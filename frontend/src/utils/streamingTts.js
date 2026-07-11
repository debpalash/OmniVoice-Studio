/**
 * streamingTts.js — streaming TTS preview (feat: streaming-tts-preview).
 *
 * POSTs /generate with stream=true (NDJSON: "start" → N × "chunk" → "done")
 * and starts playback from the FIRST received chunk while the backend is
 * still synthesizing the rest, instead of waiting for the whole render.
 *
 * Playback is plain Web Audio (AudioContext + scheduled AudioBufferSource
 * nodes) — available in all three Tauri webviews (WKWebView / WebView2 /
 * WebKitGTK) and regular browsers, so the default behavior is identical on
 * macOS, Windows and Linux (strict repo rule). No MediaSource, which WKWebView
 * does not reliably support for audio/wav. Chunks are joined with the same
 * linear crossfade the backend uses for the final file, so the preview
 * timeline matches the saved take.
 *
 * The mini-player integration is the same tracked-'output' claim that
 * playBlobAudio uses (utils/playback.js), so the GlobalAudioPlayer bar shows
 * the streaming state (label + growing duration) with live seek inside the
 * buffered region, pause/resume, and stop.
 *
 * Failure contract: ANY problem after the HTTP response starts — an in-band
 * "error" event, a transport drop mid-body, a Web Audio failure — surfaces as
 * StreamingPreviewError so the caller (useTTS) can fall back to the classic
 * whole-file flow with the user none the wiser. Pre-stream HTTP errors keep
 * their ApiError identity (they would fail the classic flow identically, so
 * falling back would only duplicate the failure).
 */
import { apiFetch } from '../api/client';
import { claimTrackedPlayback } from './playback';

/** True when the webview can progressively play PCM chunks (Web Audio). */
export const supportsStreamingPreview = () =>
  typeof window !== 'undefined' &&
  typeof (window.AudioContext || window.webkitAudioContext) === 'function';

/** A failure AFTER the stream started — the signal to fall back to the
 *  classic whole-file /generate flow. */
export class StreamingPreviewError extends Error {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'StreamingPreviewError';
  }
}

/** base64 → Int16 PCM → Float32 samples in [-1, 1]. Exported for tests. */
export const decodePcm16Base64 = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
};

/**
 * Normalized [0..1] waveform peaks across a LIST of sample chunks — the
 * incremental twin of media.js computePeaks (which needs one decoded
 * AudioBuffer). Strided like the original so it stays O(buckets) per call
 * even for hour-long renders. Exported for tests.
 */
export const peaksFromChunkList = (chunkArrays, buckets = 240) => {
  const total = chunkArrays.reduce((n, c) => n + c.length, 0);
  if (!total) return null;
  const n = Math.min(buckets, total);
  const peaks = Array.from({ length: n }, () => 0);
  const bucketSize = total / n;
  const step = Math.max(1, Math.floor(bucketSize / 64));
  let base = 0;
  for (const data of chunkArrays) {
    for (let j = 0; j < data.length; j += step) {
      const v = Math.abs(data[j]);
      const b = Math.min(n - 1, Math.floor((base + j) / bucketSize));
      if (v > peaks[b]) peaks[b] = v;
    }
    base += data.length;
  }
  const top = Math.max(...peaks, 0.001);
  return peaks.map((p) => p / top);
};

/**
 * Progressive chunk player: schedules each appended PCM chunk on a shared
 * AudioContext timeline with the backend's crossfade, so playback runs
 * continuously while later chunks are still being synthesized. If synthesis
 * is slower than playback, the playhead waits at the buffered edge and
 * resumes when the next chunk lands (re-anchoring the schedule).
 *
 * Registered as a tracked 'output' playback: live time, growing duration,
 * progressive peaks, seek within the buffered region, pause/resume, stop.
 * Exported for tests; production entry point is streamGenerateSpeech below.
 */
export const createStreamingChunkPlayer = ({ label, sampleRate, crossfadeMs = 0, onDone } = {}) => {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const xf = Math.max(0, crossfadeMs) / 1000;

  const chunks = []; // Float32Array per received chunk
  const starts = []; // timeline start (s) of each chunk, crossfade-overlapped
  let totalDuration = 0; // buffered timeline seconds
  let scheduled = []; // live nodes: { src, gain, index }
  let baseOffset = 0; // timeline position where the current chain started
  let anchor = 0; // ctx.currentTime when the current chain started
  let finished = false;
  let complete = false; // all chunks received (finalize() called)
  let timer = null;

  const dur = (i) => chunks[i].length / sampleRate;
  const fadeFor = (i) => (i > 0 ? Math.min(xf, dur(i - 1), dur(i)) : 0);
  const currentPos = () =>
    Math.max(0, Math.min(baseOffset + (ctx.currentTime - anchor), totalDuration));

  const finish = (reason) => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    stopScheduled();
    try {
      ctx.close();
    } catch {
      /* already closed */
    }
    try {
      onDone?.(reason);
    } catch {
      /* consumer callbacks must not break the manager */
    }
  };

  const stopScheduled = () => {
    for (const node of scheduled) {
      try {
        node.src.stop();
      } catch {
        /* not started / already stopped */
      }
      try {
        node.src.disconnect();
        node.gain.disconnect();
      } catch {
        /* noop */
      }
    }
    scheduled = [];
  };

  // Schedule chunk `i` at its timeline slot on the current anchor. `intra`
  // starts mid-chunk (seek); `withFade` crossfades against the chain's tail.
  const scheduleChunk = (i, intra = 0, withFade = true) => {
    const buffer = ctx.createBuffer(1, chunks[i].length, sampleRate);
    // copyToChannel is on every real AudioBuffer; fall back for old shims.
    if (buffer.copyToChannel) buffer.copyToChannel(chunks[i], 0);
    else buffer.getChannelData(0).set(chunks[i]);
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buffer;
    src.connect(gain);
    gain.connect(ctx.destination);

    const when = anchor + (starts[i] + intra - baseOffset);
    const fade = withFade && intra === 0 ? fadeFor(i) : 0;
    const tail = scheduled[scheduled.length - 1];
    if (fade > 0 && tail) {
      // Linear crossfade — same shape the backend bakes into the final file.
      tail.gain.gain.setValueAtTime(1, when);
      tail.gain.gain.linearRampToValueAtTime(0, when + fade);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + fade);
    }
    src.start(Math.max(when, ctx.currentTime), intra);
    scheduled.push({ src, gain, index: i });
  };

  const session = claimTrackedPlayback({
    source: 'output',
    label,
    stop: () => finish('stopped'),
    seek: (t) => {
      if (finished || !chunks.length) return;
      const target = Math.max(0, Math.min(t, Math.max(0, totalDuration - 0.02)));
      stopScheduled();
      let j = 0;
      for (let i = 0; i < starts.length; i++) if (starts[i] <= target) j = i;
      baseOffset = target;
      anchor = ctx.currentTime + 0.02;
      scheduleChunk(j, target - starts[j], false);
      for (let i = j + 1; i < chunks.length; i++) scheduleChunk(i);
      session.update({ currentTime: target });
    },
    pause: () => {
      if (finished) return;
      ctx
        .suspend()
        .then(() => session.update({ paused: true, currentTime: currentPos() }))
        .catch(() => {});
    },
    resume: () => {
      if (finished) return;
      ctx
        .resume()
        .then(() => session.update({ paused: false }))
        .catch(() => {});
    },
  });

  timer = setInterval(() => {
    if (finished || ctx.state !== 'running') return;
    const pos = currentPos();
    session.update({ currentTime: pos });
    if (complete && pos >= totalDuration - 0.03) {
      session.update({ currentTime: totalDuration });
      session.release();
      finish('ended');
    }
  }, 250);

  return {
    /** Append one base64 PCM16 chunk and schedule it for gapless playback. */
    appendPcm16Base64: (b64) => {
      if (finished) return;
      const data = decodePcm16Base64(b64);
      if (!data.length) return;
      const i = chunks.length;
      chunks.push(data);
      starts.push(i === 0 ? 0 : starts[i - 1] + dur(i - 1) - fadeFor(i));
      totalDuration = starts[i] + dur(i);

      const when = anchor + (starts[i] - baseOffset);
      if (i > 0 && when < ctx.currentTime - 0.01) {
        // Underrun: playback drained the buffered chunks before this one
        // arrived. Re-anchor so the new chunk starts now (the playhead sat at
        // the buffered edge) instead of clipping its head.
        baseOffset = starts[i];
        anchor = ctx.currentTime + 0.02;
        scheduleChunk(i, 0, false);
      } else {
        scheduleChunk(i);
      }
      session.update({
        duration: totalDuration,
        peaks: peaksFromChunkList(chunks),
      });
    },
    /** All chunks received: freeze the duration and retitle the bar. */
    finalize: ({ label: finalLabel } = {}) => {
      if (finished) return;
      complete = true;
      const patch = { duration: totalDuration };
      if (finalLabel) patch.label = finalLabel;
      session.update(patch);
    },
    /** Mid-stream failure: tear down silently (the caller falls back). */
    fail: () => {
      if (finished) return;
      session.release();
      finish('error');
    },
    get stopped() {
      return finished;
    },
  };
};

/**
 * Run one streaming generation end-to-end: POST /generate (stream=true),
 * progressively play the preview, and resolve with the "done" metadata
 * ({ id, audio_path, duration, gen_time, seed, sample_rate }) once the final
 * file is saved server-side (same watermark/history/retention pipeline as the
 * classic flow).
 *
 * @param {FormData} formData  The exact classic /generate form (not mutated).
 * @param {object}   opts
 * @param {AbortSignal} [opts.signal]
 * @param {string}   [opts.label]      Bar label while streaming.
 * @param {string}   [opts.finalLabel] Bar label once generation completes.
 * @param {(res: Response) => void} [opts.onHeaders]  Same X-Seed / routing
 *                    header handling as the classic path.
 * @param {(pct: number) => void}   [opts.onProgress] Chunk progress 0–100.
 * @throws {StreamingPreviewError} on any mid-stream failure (fall back to the
 *         classic flow); ApiError/AbortError propagate untouched.
 */
export async function streamGenerateSpeech(
  formData,
  { signal, label, finalLabel, onHeaders, onProgress } = {},
) {
  const fd = new FormData();
  for (const [k, v] of formData.entries()) fd.append(k, v);
  fd.append('stream', 'true');

  // Pre-stream failures (400/503/transport) throw ApiError here — identical
  // to the classic flow, so they are NOT wrapped for fallback.
  const response = await apiFetch('/generate', { method: 'POST', body: fd, signal });
  onHeaders?.(response);

  let player = null;
  let meta = null;
  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let totalChunks = 0;
    let received = 0;

    const handleEvent = (ev) => {
      if (ev.type === 'start') {
        totalChunks = ev.total_chunks || 0;
        player = createStreamingChunkPlayer({
          label,
          sampleRate: ev.sample_rate,
          crossfadeMs: ev.crossfade_ms || 0,
        });
      } else if (ev.type === 'chunk') {
        received += 1;
        player?.appendPcm16Base64(ev.pcm);
        if (totalChunks > 0)
          onProgress?.(Math.min(100, Math.round((received / totalChunks) * 100)));
      } else if (ev.type === 'done') {
        meta = ev;
      } else if (ev.type === 'error') {
        throw new StreamingPreviewError(ev.detail || 'TTS stream reported an error');
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleEvent(JSON.parse(line));
      }
    }
    if (!meta) throw new StreamingPreviewError('TTS stream ended without a completion event');
    player?.finalize({ label: finalLabel });
    return meta;
  } catch (err) {
    try {
      player?.fail();
    } catch {
      /* teardown must not mask the original error */
    }
    if (err?.name === 'AbortError' || err instanceof StreamingPreviewError) throw err;
    // Anything else mid-stream (transport drop, JSON parse, Web Audio) → the
    // fallback signal.
    throw new StreamingPreviewError(err?.message || String(err), { cause: err });
  }
}
