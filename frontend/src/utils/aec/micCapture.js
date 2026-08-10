// Microphone PCM capture for the opt-in AEC path and for WebViews that cannot
// construct MediaRecorder. Routes a getUserMedia stream through an
// AudioWorklet that emits fixed-size Float32 frames; the caller converts,
// tags, streams, or WAV-encodes them.

const WORKLET_URL = '/aec-worklet.js';

/**
 * Start capturing ``stream`` as Float32 mono frames at ``sampleRate``.
 *
 * @param {MediaStream} stream      mic stream from getUserMedia
 * @param {(frame: Float32Array) => void} onFrame  called per frame
 * @param {{sampleRate?: number, frameSize?: number}} opts
 * @returns {Promise<() => Promise<void>>}  async stop() that tears down the graph
 */
export async function startMicCapture(
  stream,
  onFrame,
  { sampleRate = 16000, frameSize = 320 } = {},
) {
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

  const stop = async function stop() {
    try {
      node.port.onmessage = null;
    } catch {
      /* ignore */
    }
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
    try {
      src.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await ctx.close();
    } catch {
      /* ignore */
    }
  };
  // Existing callers use this value as a function. The property lets generic
  // PCM/WAV recording encode the frames at the AudioContext's actual rate.
  stop.sampleRate = ctx.sampleRate;
  return stop;
}
