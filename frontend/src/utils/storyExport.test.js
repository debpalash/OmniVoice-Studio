import { describe, it, expect } from 'vitest';
import { silenceBuffer, concatBuffers, encodeWav } from './storyExport';

function fakeBuffer(samples, sampleRate = 24000) {
  const data = Float32Array.from(samples);
  return { sampleRate, numberOfChannels: 1, length: data.length, getChannelData: () => data };
}

describe('silenceBuffer', () => {
  it('produces sampleRate * seconds zeroed samples (mono)', () => {
    const b = silenceBuffer(0.5, 24000);
    expect(b.length).toBe(12000);
    expect(b.numberOfChannels).toBe(1);
    expect(b.getChannelData(0).every((v) => v === 0)).toBe(true);
  });
});

describe('concatBuffers', () => {
  it('joins buffers in order into one of summed length', () => {
    const out = concatBuffers([fakeBuffer([1, 2]), fakeBuffer([3, 4, 5])], 24000);
    expect(out.length).toBe(5);
    expect(Array.from(out.getChannelData(0))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('encodeWav', () => {
  it('writes a 44-byte RIFF/WAVE PCM16 header', () => {
    const wav = encodeWav(fakeBuffer([0, 0.5, -0.5]), 24000);
    const dv = new DataView(wav);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(36)).toBe('data');
    expect(dv.getUint16(22, true)).toBe(1);     // mono
    expect(dv.getUint32(24, true)).toBe(24000);  // sample rate
    expect(dv.getUint16(34, true)).toBe(16);     // bits/sample
    expect(wav.byteLength).toBe(44 + 3 * 2);     // header + 3 int16 samples
  });
});
