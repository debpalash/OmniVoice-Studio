import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./farEndBus', () => ({ publishFarEnd: vi.fn() }));

import { publishFarEnd } from './farEndBus';
import { attachPlaybackTap } from './playbackTap';

let context;
let workletNode;

class FakeAudioContext {
  constructor() {
    context = this;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = {};
    this.audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    this.source = { connect: vi.fn(), disconnect: vi.fn() };
  }

  createMediaElementSource() {
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

describe('attachPlaybackTap', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    publishFarEnd.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    context = undefined;
    workletNode = undefined;
  });

  it('delivers fixed-size 16 kHz reference frames from a 48 kHz context', async () => {
    const detach = await attachPlaybackTap({}, { sampleRate: 16000, frameSize: 4 });

    expect(workletNode.options.processorOptions).toEqual({ frameSize: 12, channels: 1 });
    workletNode.port.onmessage({
      data: new Float32Array([-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25]),
    });

    expect(publishFarEnd).toHaveBeenCalledWith(new Float32Array([-1, -0.25, 0.5, 0.75]));

    await detach();
    expect(workletNode.disconnect).toHaveBeenCalledOnce();
    expect(context.source.connect).toHaveBeenCalledWith(context.destination);
  });
});
