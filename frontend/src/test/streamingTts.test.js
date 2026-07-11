import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Streaming TTS preview (feat: streaming-tts-preview): the NDJSON client must
// start Web Audio playback from the FIRST chunk, register as a tracked
// 'output' playback (mini-player bar), flip its label on completion, resolve
// with the "done" metadata — and turn ANY mid-stream failure into
// StreamingPreviewError so useTTS can fall back to the classic flow.

vi.mock('../api/client', () => ({
  apiFetch: vi.fn(),
}));

const { apiFetch } = await import('../api/client');
const {
  streamGenerateSpeech,
  createStreamingChunkPlayer,
  supportsStreamingPreview,
  decodePcm16Base64,
  peaksFromChunkList,
  StreamingPreviewError,
} = await import('../utils/streamingTts');
const { getPlaybackTrack, stopActivePlayback, seekActivePlayback } =
  await import('../utils/playback');

// ── Web Audio fakes ─────────────────────────────────────────────────────────

class FakeGainParam {
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}
class FakeGain {
  constructor() {
    this.gain = new FakeGainParam();
  }
  connect() {}
  disconnect() {}
}
class FakeSource {
  constructor(ctx) {
    this.ctx = ctx;
  }
  connect() {}
  disconnect() {}
  start(when, offset) {
    this.startedAt = { when, offset: offset || 0 };
    this.ctx.started.push(this);
  }
  stop() {
    this.stopped = true;
  }
}
class FakeAudioContext {
  static instances = [];
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this.started = []; // every source that called start()
    FakeAudioContext.instances.push(this);
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
  }
  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return {
      length,
      duration: length / sampleRate,
      numberOfChannels: channels,
      sampleRate,
      copyToChannel: (src) => data.set(src),
      getChannelData: () => data,
    };
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  createGain() {
    return new FakeGain();
  }
}

// ── NDJSON fixtures ─────────────────────────────────────────────────────────

const b64Pcm = (samples) => {
  // Int16 PCM little-endian → base64.
  const pcm = new Int16Array(samples);
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const CHUNK_SAMPLES = 2400; // 100 ms @ 24 kHz

const startEvent = (totalChunks) => ({
  type: 'start',
  sample_rate: 24000,
  channels: 1,
  format: 'pcm16',
  total_chunks: totalChunks,
  crossfade_ms: 50,
  seed: 7,
});
const chunkEvent = (seq) => ({
  type: 'chunk',
  seq,
  pcm: b64Pcm(Array.from({ length: CHUNK_SAMPLES }, (_, i) => (i % 100) * 50)),
});
const doneEvent = {
  type: 'done',
  id: 'abc12345',
  audio_path: 'abc12345.wav',
  duration: 0.3,
  gen_time: 1.2,
  seed: 7,
  sample_rate: 24000,
};

const ndjsonResponse = (events, headers = {}) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(JSON.stringify(e) + '\n'));
      controller.close();
    },
  });
  return { headers: new Headers(headers), body: stream };
};

beforeEach(() => {
  FakeAudioContext.instances = [];
  window.AudioContext = FakeAudioContext;
  apiFetch.mockReset();
});

afterEach(() => {
  stopActivePlayback();
});

// ── unit: codecs ────────────────────────────────────────────────────────────

describe('decodePcm16Base64', () => {
  it('roundtrips int16 samples to normalized floats', () => {
    const out = decodePcm16Base64(b64Pcm([0, 16384, -16384, 32767, -32768]));
    expect(out.length).toBe(5);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(0.5, 3);
    expect(out[2]).toBeCloseTo(-0.5, 3);
    expect(out[3]).toBeCloseTo(1, 2);
    expect(out[4]).toBe(-1);
  });
});

describe('peaksFromChunkList', () => {
  it('returns normalized peaks across chunk boundaries', () => {
    const quiet = new Float32Array(1000).fill(0.1);
    const loud = new Float32Array(1000).fill(0.8);
    const peaks = peaksFromChunkList([quiet, loud], 10);
    expect(peaks.length).toBe(10);
    expect(Math.max(...peaks)).toBe(1); // normalized
    expect(peaks[0]).toBeLessThan(peaks[9]); // loud tail dominates
  });
  it('handles empty input', () => {
    expect(peaksFromChunkList([])).toBeNull();
  });
});

describe('supportsStreamingPreview', () => {
  it('is true with an AudioContext and false without', () => {
    expect(supportsStreamingPreview()).toBe(true);
    const saved = window.AudioContext;
    delete window.AudioContext;
    delete window.webkitAudioContext;
    expect(supportsStreamingPreview()).toBe(false);
    window.AudioContext = saved;
  });
});

// ── streamGenerateSpeech ────────────────────────────────────────────────────

describe('streamGenerateSpeech', () => {
  it('plays chunks progressively, flips the label on done, resolves metadata', async () => {
    apiFetch.mockResolvedValue(
      ndjsonResponse([startEvent(3), chunkEvent(0), chunkEvent(1), chunkEvent(2), doneEvent], {
        'X-Seed': '7',
      }),
    );
    const onHeaders = vi.fn();
    const onProgress = vi.fn();

    const meta = await streamGenerateSpeech(new FormData(), {
      label: 'Streaming preview…',
      finalLabel: 'Generated audio',
      onHeaders,
      onProgress,
    });

    expect(meta.id).toBe('abc12345');
    expect(meta.audio_path).toBe('abc12345.wav');
    expect(onHeaders).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(100);

    // All three chunks were scheduled on one context.
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.started.length).toBe(3);

    // Tracked 'output' claim → mini-player bar; label flipped at completion;
    // duration covers the buffered chunks (3 × 100 ms minus 2 × 50 ms fades).
    const track = getPlaybackTrack();
    expect(track.source).toBe('output');
    expect(track.label).toBe('Generated audio');
    expect(track.duration).toBeCloseTo(0.2, 3);
    expect(track.peaks?.length).toBeGreaterThan(0);
    expect(track.canSeek).toBe(true);
  });

  it('appends stream=true without mutating the caller FormData', async () => {
    apiFetch.mockResolvedValue(ndjsonResponse([startEvent(1), chunkEvent(0), doneEvent]));
    const fd = new FormData();
    fd.append('text', 'hello');
    await streamGenerateSpeech(fd, {});
    expect(fd.get('stream')).toBeNull(); // caller's copy untouched
    const sent = apiFetch.mock.calls[0][1].body;
    expect(sent.get('stream')).toBe('true');
    expect(sent.get('text')).toBe('hello');
  });

  it('turns an in-band error event into StreamingPreviewError and releases the bar', async () => {
    apiFetch.mockResolvedValue(
      ndjsonResponse([startEvent(3), chunkEvent(0), { type: 'error', detail: 'engine boom' }]),
    );
    await expect(streamGenerateSpeech(new FormData(), {})).rejects.toThrow(StreamingPreviewError);
    expect(getPlaybackTrack()).toBeNull(); // playback torn down for the fallback
    expect(FakeAudioContext.instances[0].state).toBe('closed');
  });

  it('rejects with StreamingPreviewError when the stream ends without done', async () => {
    apiFetch.mockResolvedValue(ndjsonResponse([startEvent(2), chunkEvent(0)]));
    await expect(streamGenerateSpeech(new FormData(), {})).rejects.toThrow(StreamingPreviewError);
  });

  it('wraps a mid-body transport drop but lets pre-stream ApiError through untouched', async () => {
    // Mid-body drop → StreamingPreviewError (fallback signal).
    const enc = new TextEncoder();
    apiFetch.mockResolvedValue({
      headers: new Headers(),
      body: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(JSON.stringify(startEvent(2)) + '\n'));
          c.error(new TypeError('network dropped'));
        },
      }),
    });
    await expect(streamGenerateSpeech(new FormData(), {})).rejects.toThrow(StreamingPreviewError);

    // Pre-stream HTTP failure → original error identity (NO fallback; the
    // classic flow would fail identically).
    const apiErr = Object.assign(new Error('400 Bad Request: nope'), { name: 'ApiError' });
    apiFetch.mockRejectedValue(apiErr);
    await expect(streamGenerateSpeech(new FormData(), {})).rejects.toBe(apiErr);
  });
});

// ── createStreamingChunkPlayer transport ────────────────────────────────────

describe('createStreamingChunkPlayer', () => {
  it('supports seek within the buffered region (reschedules from the target)', () => {
    const player = createStreamingChunkPlayer({
      label: 'x',
      sampleRate: 24000,
      crossfadeMs: 0,
    });
    player.appendPcm16Base64(chunkEvent(0).pcm);
    player.appendPcm16Base64(chunkEvent(1).pcm);
    const ctx = FakeAudioContext.instances[0];
    const before = ctx.started.length;
    seekActivePlayback(0.15); // inside chunk 1 (0.1–0.2 s timeline)
    expect(ctx.started.length).toBeGreaterThan(before); // rescheduled
    const reseek = ctx.started[ctx.started.length - 1];
    expect(reseek.startedAt.offset).toBeCloseTo(0.05, 3); // intra-chunk offset
    expect(getPlaybackTrack().currentTime).toBeCloseTo(0.15, 3);
    player.fail();
  });

  it('stop via the manager finishes the player and closes the context', () => {
    const onDone = vi.fn();
    const player = createStreamingChunkPlayer({
      label: 'x',
      sampleRate: 24000,
      crossfadeMs: 50,
      onDone,
    });
    player.appendPcm16Base64(chunkEvent(0).pcm);
    stopActivePlayback();
    expect(onDone).toHaveBeenCalledWith('stopped');
    expect(player.stopped).toBe(true);
    expect(FakeAudioContext.instances[0].state).toBe('closed');
  });
});
