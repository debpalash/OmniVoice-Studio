/**
 * Story audiobook export.
 *
 * Renders each track (chunks + [pause] gaps) to audio via the job-less
 * `/generate` endpoint, decodes with the Web Audio API, stitches into one
 * mono buffer with timed silences, and encodes a single 16-bit PCM WAV.
 *
 * The pure helpers (silenceBuffer/concatBuffers/encodeWav) take and return
 * plain {sampleRate, numberOfChannels, length, getChannelData} shapes so they
 * are testable without a real AudioContext.
 */
import { parseStoryText } from './storyTokens';

/** Mono buffer of `seconds` of silence at `sampleRate`. */
export function silenceBuffer(seconds, sampleRate) {
  const length = Math.max(0, Math.round(seconds * sampleRate));
  const data = new Float32Array(length);
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/** Concatenate mono buffers (channel 0) in order. */
export function concatBuffers(buffers, sampleRate) {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(b.getChannelData(0).subarray(0, b.length), offset);
    offset += b.length;
  }
  return { sampleRate, numberOfChannels: 1, length: total, getChannelData: () => out };
}

/** Encode a mono buffer to a 16-bit PCM WAV ArrayBuffer. */
export function encodeWav(buffer, sampleRate) {
  const samples = buffer.getChannelData(0);
  const n = buffer.length;
  const ab = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(ab);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);          // PCM chunk size
  dv.setUint16(20, 1, true);           // PCM format
  dv.setUint16(22, 1, true);           // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate (mono * 2 bytes)
  dv.setUint16(32, 2, true);           // block align
  dv.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return ab;
}

/**
 * Render an ordered track list to one WAV blob.
 * @param tracks          [{ text, character, profileId, speed }]
 * @param resolveOpts     (track) => { profileId, speed }   // applies cast fallback
 * @param fetchChunkBlob  (text, profileId, speed) => Promise<Blob>   // /generate WAV
 * @param onProgress      (done, total) => void
 * @returns Blob (audio/wav)
 */
export async function exportStoryAudio(tracks, resolveOpts, fetchChunkBlob, onProgress) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const segments = [];
    for (const tk of tracks) {
      const opts = resolveOpts(tk) || {};
      for (const seg of parseStoryText(tk.text || '', opts.profileId)) {
        segments.push(seg.type === 'chunk' ? { ...seg, speed: opts.speed } : seg);
      }
    }
    const chunkCount = segments.filter((s) => s.type === 'chunk').length;
    let done = 0;
    const buffers = [];
    for (const seg of segments) {
      if (seg.type === 'pause') {
        buffers.push(silenceBuffer(seg.seconds, ctx.sampleRate));
        continue;
      }
      const blob = await fetchChunkBlob(seg.text, seg.profileId, seg.speed);
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      buffers.push(decoded); // decodeAudioData resamples to ctx.sampleRate → safe to concat
      onProgress?.(++done, chunkCount);
    }
    const combined = concatBuffers(buffers, ctx.sampleRate);
    return new Blob([encodeWav(combined, ctx.sampleRate)], { type: 'audio/wav' });
  } finally {
    ctx.close?.();
  }
}
