// Microphone PCM capture for the opt-in AEC path and for WebViews that cannot
// construct MediaRecorder. Routes a getUserMedia stream through an
// AudioWorklet that emits fixed-size Float32 frames; the caller converts,
// tags, streams, or WAV-encodes them.

const WORKLET_URL = '/aec-worklet.js';

export function resampleInterleavedFrame(frame, inputRate, outputRate, channels) {
  if (inputRate === outputRate || frame.length === 0) return frame;

  const inputFrames = Math.floor(frame.length / channels);
  const outputFrames = Math.max(1, Math.round((inputFrames * outputRate) / inputRate));
  const output = new Float32Array(outputFrames * channels);
  const sourceStep = inputRate / outputRate;

  for (let outputIndex = 0; outputIndex < outputFrames; outputIndex += 1) {
    const sourcePosition = outputIndex * sourceStep;
    const lowerIndex = Math.min(Math.floor(sourcePosition), inputFrames - 1);
    const upperIndex = Math.min(lowerIndex + 1, inputFrames - 1);
    const mix = sourcePosition - lowerIndex;

    for (let channel = 0; channel < channels; channel += 1) {
      const lower = frame[lowerIndex * channels + channel];
      const upper = frame[upperIndex * channels + channel];
      output[outputIndex * channels + channel] = lower + (upper - lower) * mix;
    }
  }

  return output;
}

/**
 * Start capturing ``stream`` as Float32 mono frames at ``sampleRate``.
 *
 * @param {MediaStream} stream      mic stream from getUserMedia
 * @param {(frame: Float32Array) => void} onFrame  called per frame
 * @param {{sampleRate?: number, frameSize?: number, channels?: number}} opts
 * @returns {Promise<() => Promise<void>>}  async stop() that tears down the graph
 */
export async function startMicCapture(
  stream,
  onFrame,
  { sampleRate = 16000, frameSize = 320, channels = 1 } = {},
) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate });
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* gesture may be required; capture setup can still continue */
    }
  }
  await ctx.audioWorklet.addModule(WORKLET_URL);
  const src = ctx.createMediaStreamSource(stream);
  const sourceFrameSize = Math.max(1, Math.round((frameSize * ctx.sampleRate) / sampleRate));
  const node = new AudioWorkletNode(ctx, 'aec-frame-emitter', {
    processorOptions: { frameSize: sourceFrameSize, channels },
  });
  node.port.onmessage = (e) =>
    onFrame(resampleInterleavedFrame(e.data, ctx.sampleRate, sampleRate, channels));
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
  // PCM/WAV recording encode the delivered frames at their actual rate.
  stop.sampleRate = sampleRate;
  stop.channels = channels;
  return stop;
}
