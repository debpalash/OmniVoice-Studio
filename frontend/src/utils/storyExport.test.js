import { describe, it, expect } from 'vitest';
import {
  silenceBuffer, concatBuffers, encodeWav,
  isChapterLine, chapterTitle, formatTimecode, tracksByCharacter, buildCueSheet,
} from './storyExport';

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

describe('chapter helpers', () => {
  it('detects + titles H1 chapter lines (H1-only, #27)', () => {
    expect(isChapterLine('# Chapter One')).toBe(true);
    expect(isChapterLine('  # Indented')).toBe(true);   // leading space ok
    // #27 convergence: H2–H6 narrate as body, not chapter breaks.
    expect(isChapterLine('  ## Part 2 ')).toBe(false);
    expect(isChapterLine('### Deep')).toBe(false);
    // `# ` / `#   ` with no non-space title is body (matches server _HEADING_RE).
    expect(isChapterLine('# ')).toBe(false);
    expect(isChapterLine('#   ')).toBe(false);
    expect(isChapterLine('#Title')).toBe(false);        // needs a space
    expect(isChapterLine('Not a chapter')).toBe(false);
    expect(chapterTitle('# Chapter One')).toBe('Chapter One');
    // strip only the single H1 marker; remainder verbatim (raw-title behavior).
    expect(chapterTitle('# [voice:x] Title')).toBe('[voice:x] Title');
  });
  it('formats timecodes HH:MM:SS', () => {
    expect(formatTimecode(0)).toBe('00:00:00');
    expect(formatTimecode(65)).toBe('00:01:05');
    expect(formatTimecode(3661)).toBe('01:01:01');
  });
  it('builds a cue sheet', () => {
    expect(buildCueSheet([{ time: 0, title: 'Intro' }, { time: 65, title: 'Two' }]))
      .toBe('00:00:00 Intro\n00:01:05 Two');
  });
});

describe('tracksByCharacter', () => {
  it('groups spoken lines by character, skipping chapter headings', () => {
    const groups = tracksByCharacter([
      { character: 'narrator', text: '# Chapter 1' },
      { character: 'narrator', text: 'Once.' },
      { character: 'fox', text: 'Hi.' },
      { character: 'narrator', text: 'Then.' },
    ]);
    expect(groups.map((g) => g.character)).toEqual(['narrator', 'fox']);
    expect(groups[0].tracks).toHaveLength(2);
    expect(groups[1].tracks).toHaveLength(1);
  });
});
