// AudioWorklet processor for the opt-in dictate-over-playback AEC (parity
// Action 8). Accumulates mono Float32 input into fixed-size frames and posts
// them to the main thread, which converts them to tagged int16 PCM. The same
// processor serves both the microphone capture and the playback-reference tap
// — only the wiring on the main thread differs.
//
// Served as a static asset from /public so the AudioContext can load it via
// audioWorklet.addModule('/aec-worklet.js') in both dev and the bundled app.

class AecFrameEmitter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frame = (options && options.processorOptions && options.processorOptions.frameSize) || 320;
    this._frameSize = frame;     // 320 samples = 20 ms @ 16 kHz
    this._buf = new Float32Array(frame);
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    // input[0] is the first (mono) channel; absent when upstream is idle.
    if (input && input[0]) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i];
        if (this._n >= this._frameSize) {
          // Copy out — the buffer is reused for the next frame.
          this.port.postMessage(this._buf.slice(0, this._frameSize));
          this._n = 0;
        }
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('aec-frame-emitter', AecFrameEmitter);
