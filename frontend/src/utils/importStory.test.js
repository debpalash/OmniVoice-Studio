import { describe, it, expect } from 'vitest';
import { parseSrt, importToText } from './importStory';

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello there.

2
00:00:03,500 --> 00:00:05,000
How are you?
`;

describe('parseSrt', () => {
  it('strips indices + timestamps, one cue per line', () => {
    expect(parseSrt(SRT)).toBe('Hello there.\nHow are you?');
  });
  it('joins multi-line cues with a space', () => {
    const s = '1\n00:00:01,000 --> 00:00:02,000\nLine one\nline two\n';
    expect(parseSrt(s)).toBe('Line one line two');
  });
  it('empty → empty', () => {
    expect(parseSrt('')).toBe('');
  });
});

describe('importToText', () => {
  it('routes .srt through parseSrt', () => {
    expect(importToText('subs.srt', SRT)).toBe('Hello there.\nHow are you?');
  });
  it('passes .txt through unchanged', () => {
    expect(importToText('story.txt', 'Once upon a time.')).toBe('Once upon a time.');
  });
});
