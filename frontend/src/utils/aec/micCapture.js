// Microphone PCM capture for the opt-in AEC path (parity Action 8). Routes a
// getUserMedia stream through an AudioWorklet that emits fixed-size Float32
// frames; the caller converts/tags/sends them. Only used when AEC is enabled
// — the default dictation path keeps using MediaRecorder/WebM untouched.

const WORKLET_URL = '/aec-worklet.js';

/**
 * Start capturing ``stream`` as Float32 mono frames at ``sampleRate``.
 *
 * @param {MediaStream} stream      mic stream from getUserMedia
 * @param {(frame: Float32Array) => void} onFrame  called per frame
 * @param {{sampleRate?: number, frameSize?: number}} opts
 * @returns {Promise<() => Promise<void>>}  async stop() that tears down the graph
 */
export async function startMicCapture(stream, onFrame, { sampleRate = 16000, frameSize = 320 } = {}) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate });
  await ctx.audioWorklet.addModule(WORKLET_URL);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'aec-frame-emitter', {
    processorOptions: { frameSize },
  });
  node.port.onmessage = (e) => onFrame(e.data);
  // Mic → worklet only. Deliberately NOT connected to destination: we tap the
  // mic, we don't want to play it back through the speakers.
  src.connect(node);

  return async function stop() {
    try { node.port.onmessage = null; } catch { /* ignore */ }
    try { node.disconnect(); } catch { /* ignore */ }
    try { src.disconnect(); } catch { /* ignore */ }
    try { await ctx.close(); } catch { /* ignore */ }
  };
}
