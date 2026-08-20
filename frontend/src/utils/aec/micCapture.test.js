import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startMicCapture } from './micCapture';

let context;
let workletNode;
let contextSampleRate;

class FakeAudioContext {
  constructor() {
    context = this;
    this.sampleRate = contextSampleRate;
    this.state = 'suspended';
    this.audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    this.resume = vi.fn(async () => {
      this.state = 'running';
    });
    this.close = vi.fn().mockResolvedValue(undefined);
    this.source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createMediaStreamSource() {
    return this.source;
  }
}

class FakeAudioWorkletNode {
  constructor(_context, _name, options) {
    workletNode = this;
    this.options = options;
    this.port = { onmessage: null };
    this.disconnect = vi.fn();
  }
}

describe('startMicCapture', () => {
  beforeEach(() => {
    contextSampleRate = 48000;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    context = undefined;
    workletNode = undefined;
    contextSampleRate = undefined;
  });

  it('resumes a suspended AudioContext before capturing microphone frames', async () => {
    const stop = await startMicCapture({}, vi.fn());

    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.state).toBe('running');

    await stop();
  });

  it('delivers fixed-size 16 kHz frames when the AudioContext runs at 48 kHz', async () => {
    const frames = [];
    const stop = await startMicCapture({}, (frame) => frames.push(frame), {
      sampleRate: 16000,
      frameSize: 4,
    });

    expect(workletNode.options.processorOptions).toEqual({ frameSize: 12, channels: 1 });
    workletNode.port.onmessage({
      data: new Float32Array([-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25]),
    });

    expect(frames).toEqual([new Float32Array([-1, -0.25, 0.5, 0.75])]);
    expect(stop.sampleRate).toBe(16000);

    await stop();
  });

  it('preserves worklet frames when the AudioContext honors the requested rate', async () => {
    contextSampleRate = 16000;
    const onFrame = vi.fn();
    const stop = await startMicCapture({}, onFrame, { sampleRate: 16000, frameSize: 4 });
    const frame = new Float32Array([-1, -0.25, 0.5, 0.75]);

    workletNode.port.onmessage({ data: frame });

    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame).toHaveBeenCalledWith(frame);

    await stop();
  });
});
