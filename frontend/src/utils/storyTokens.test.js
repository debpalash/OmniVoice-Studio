import { describe, it, expect } from 'vitest';
import { parseStoryText, hasStoryMarkers, applyInlineVoice, insertToken } from './storyTokens';

describe('parseStoryText', () => {
  it('returns a single chunk with the default voice when no markers are present', () => {
    const out = parseStoryText('Hello world.', 'narrator');
    expect(out).toEqual([{ type: 'chunk', text: 'Hello world.', profileId: 'narrator' }]);
  });

  it('parses a pause token into an explicit pause event', () => {
    const out = parseStoryText('Hello [pause 0.5s] world.', 'narrator');
    expect(out).toEqual([
      { type: 'chunk', text: 'Hello', profileId: 'narrator' },
      { type: 'pause', seconds: 0.5 },
      { type: 'chunk', text: 'world.', profileId: 'narrator' },
    ]);
  });

  it('accepts pauses without trailing "s" and with integer seconds', () => {
    const out = parseStoryText('A [pause 1] B [pause 2s] C', 'n');
    expect(out.filter(e => e.type === 'pause')).toEqual([
      { type: 'pause', seconds: 1 },
      { type: 'pause', seconds: 2 },
    ]);
  });

  it('switches voice on a voice marker and carries it forward', () => {
    const out = parseStoryText('Default [voice:char-0] switched [pause 0.3s] still switched', 'narrator');
    expect(out).toEqual([
      { type: 'chunk', text: 'Default', profileId: 'narrator' },
      { type: 'chunk', text: 'switched', profileId: 'char-0' },
      { type: 'pause', seconds: 0.3 },
      { type: 'chunk', text: 'still switched', profileId: 'char-0' },
    ]);
  });

  it('reverts to the track default on [voice:default]', () => {
    const out = parseStoryText('[voice:char-0]A[voice:default]B', 'narrator');
    expect(out).toEqual([
      { type: 'chunk', text: 'A', profileId: 'char-0' },
      { type: 'chunk', text: 'B', profileId: 'narrator' },
    ]);
  });

  it('drops whitespace-only chunks between markers', () => {
    const out = parseStoryText('A   [pause 0.2s]   B', 'n');
    // Only the trimmed "A" and "B" survive; the spaces between aren't spoken.
    expect(out.filter(e => e.type === 'chunk').map(e => e.text)).toEqual(['A', 'B']);
  });

  it('ignores pauses with zero or negative seconds', () => {
    const out = parseStoryText('A [pause 0s] B', 'n');
    expect(out.some(e => e.type === 'pause')).toBe(false);
  });

  it('returns an empty list for empty input', () => {
    expect(parseStoryText('', 'n')).toEqual([]);
    expect(parseStoryText(null, 'n')).toEqual([]);
  });
});

describe('hasStoryMarkers', () => {
  it('returns true when either token is present', () => {
    expect(hasStoryMarkers('A [pause 0.5s] B')).toBe(true);
    expect(hasStoryMarkers('[voice:char-0] hello')).toBe(true);
  });
  it('returns false for plain prose', () => {
    expect(hasStoryMarkers('Just regular text.')).toBe(false);
    expect(hasStoryMarkers('Square [brackets] are fine.')).toBe(false);
  });
});

describe('applyInlineVoice', () => {
  it('wraps a non-empty selection with switch + default markers', () => {
    const result = applyInlineVoice('Hello brave new world', 6, 11, 'char-0');
    expect(result).toBe('Hello [voice:char-0]brave[voice:default] new world');
  });
  it('inserts a switch marker at the caret when the selection is collapsed', () => {
    const result = applyInlineVoice('AB', 1, 1, 'char-1');
    expect(result).toBe('A[voice:char-1]B');
  });
  it('clamps out-of-range indices to the text length', () => {
    const result = applyInlineVoice('xy', 99, 99, 'c');
    expect(result).toBe('xy[voice:c]');
  });
});

describe('insertToken', () => {
  it('inserts at the caret, padding with spaces', () => {
    expect(insertToken('hello world', 5, '[laughter]')).toBe('hello [laughter] world');
  });
  it('appends to the end when the caret is null', () => {
    expect(insertToken('hello', null, '[pause 0.5s]')).toBe('hello [pause 0.5s]');
  });
  it('does not add a leading space at the start of the text', () => {
    expect(insertToken('hi', 0, '[sigh]')).toBe('[sigh] hi');
  });
  it('handles empty text', () => {
    expect(insertToken('', null, '[laughter]')).toBe('[laughter]');
  });
});
