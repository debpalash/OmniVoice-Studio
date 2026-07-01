/**
 * CaptureWidget live-dictation state machine — pure helpers.
 *
 * `isSherpaModel` gates the raw-PCM streaming path; `classifySherpaFinal`
 * distinguishes a per-utterance commit from the authoritative EOF summary so we
 * paste each sentence live (committing on pauses) without re-pasting the summary
 * — the heart of the "text appears as you speak" behaviour.
 */
import { describe, it, expect } from 'vitest';
import { isSherpaModel, classifySherpaFinal, computeTypeDelta } from '../components/CaptureWidget';

describe('isSherpaModel', () => {
  it('matches the sherpa- dictation ids and nothing else', () => {
    expect(isSherpaModel('sherpa-parakeet-tdt-v3')).toBe(true);
    expect(isSherpaModel('sherpa-whisper-tiny')).toBe(true);
    expect(isSherpaModel('whisper-large-v3')).toBe(false);
    expect(isSherpaModel('')).toBe(false);
    expect(isSherpaModel(undefined)).toBe(false);
  });
});

describe('classifySherpaFinal', () => {
  it('treats the first non-empty offline final as a new utterance (then close finalises)', () => {
    // Offline model (Parakeet v3 default): one final, nothing committed yet.
    expect(classifySherpaFinal('hello world', [])).toBe('utterance');
  });

  it('treats a streaming per-utterance final as an utterance', () => {
    expect(classifySherpaFinal('second sentence', ['first sentence'])).toBe('utterance');
  });

  it('detects the EOF summary (text === the committed join)', () => {
    const committed = ['first sentence', 'second sentence'];
    expect(classifySherpaFinal('first sentence second sentence', committed)).toBe('summary');
  });

  it('detects a single-utterance summary (summary equals the one commit)', () => {
    expect(classifySherpaFinal('hello world', ['hello world'])).toBe('summary');
  });

  it('finalises on an empty no-speech terminator', () => {
    expect(classifySherpaFinal('', [])).toBe('terminator');
  });

  it('ignores an empty final once utterances were committed (the summary covers it)', () => {
    expect(classifySherpaFinal('', ['something'])).toBe('ignore');
  });
});

describe('computeTypeDelta', () => {
  it('pure append: no backspaces, types only the new tail', () => {
    expect(computeTypeDelta('hello wor', 'hello world')).toEqual({
      backspaces: 0,
      text: 'ld',
      noop: false,
    });
  });

  it('types the whole string from empty', () => {
    expect(computeTypeDelta('', 'hello')).toEqual({
      backspaces: 0,
      text: 'hello',
      noop: false,
    });
  });

  it('no change is a noop (no keystrokes)', () => {
    expect(computeTypeDelta('hello', 'hello')).toEqual({
      backspaces: 0,
      text: '',
      noop: true,
    });
  });

  it('both empty is a noop', () => {
    expect(computeTypeDelta('', '')).toEqual({ backspaces: 0, text: '', noop: true });
  });

  it('handles null/undefined inputs as empty', () => {
    expect(computeTypeDelta(undefined, null)).toEqual({ backspaces: 0, text: '', noop: true });
    expect(computeTypeDelta(null, 'hi')).toEqual({ backspaces: 0, text: 'hi', noop: false });
  });

  it('recognizer self-correction: backspaces the revised tail then types the fix', () => {
    // "hello to" → "hello two": common prefix "hello t", retract "o", type "wo".
    expect(computeTypeDelta('hello to', 'hello two')).toEqual({
      backspaces: 1,
      text: 'wo',
      noop: false,
    });
  });

  it('full-word revision: "recognise" → "recognize"', () => {
    // common prefix "recogni", retract "se", type "ze".
    expect(computeTypeDelta('recognise', 'recognize')).toEqual({
      backspaces: 2,
      text: 'ze',
      noop: false,
    });
  });

  it('shorter revision retracts the extra chars and types nothing', () => {
    // "helloo" → "hello": retract one 'o', type nothing.
    expect(computeTypeDelta('helloo', 'hello')).toEqual({
      backspaces: 1,
      text: '',
      noop: false,
    });
  });

  it('a leading separator is just another typed prefix delta', () => {
    // First delta of a new utterance is seeded as " word".
    expect(computeTypeDelta('', ' world')).toEqual({
      backspaces: 0,
      text: ' world',
      noop: false,
    });
  });

  it('counts astral (emoji/CJK surrogate-pair) chars as single units', () => {
    // "ab😀" → "ab😁": the emoji is one code point — retract 1, type 1, not 2.
    expect(computeTypeDelta('ab😀', 'ab😁')).toEqual({
      backspaces: 1,
      text: '😁',
      noop: false,
    });
  });

  it('appends after a multibyte char without disturbing it', () => {
    expect(computeTypeDelta('café', 'café au')).toEqual({
      backspaces: 0,
      text: ' au',
      noop: false,
    });
  });
});
