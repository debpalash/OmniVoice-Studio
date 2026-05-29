import { describe, it, expect } from 'vitest';
import { buildDesignInstruct } from './voiceInstruct';

// plan-05 (#132): the Voice Design payload must be a validator-safe instruct —
// one valid tag per category, no unsupported free-text — so Synthesize stops
// failing with "Unsupported instruct items" (#115) / "conflicting items within
// the same category" (#114).

describe('buildDesignInstruct', () => {
  it('keeps one valid tag per category from the dropdowns', () => {
    const { instruct, unsupported, duplicates } = buildDesignInstruct(
      { Gender: 'male', Age: 'middle-aged', Pitch: 'low pitch', Style: 'Auto',
        EnglishAccent: 'british accent', ChineseDialect: 'Auto' },
      '',
    );
    expect(instruct.split(', ').sort())
      .toEqual(['british accent', 'low pitch', 'male', 'middle-aged'].sort());
    expect(unsupported).toEqual([]);
    expect(duplicates).toEqual([]);
  });

  it('buckets free-text prose as unsupported, not a duplicate (#115)', () => {
    const { instruct, unsupported, duplicates } = buildDesignInstruct(
      { Gender: 'male' }, 'Speak as a calm documentary narrator');
    expect(instruct).toBe('male');
    expect(unsupported).toContain('Speak as a calm documentary narrator');
    expect(duplicates).toEqual([]);
  });

  it('buckets a valid tag outranked by a dropdown as a duplicate, not unsupported (#114)', () => {
    const { instruct, unsupported, duplicates } = buildDesignInstruct({ Pitch: 'low pitch' }, 'high pitch');
    expect(instruct).toBe('low pitch'); // dropdown wins the category
    expect(duplicates).toContain('high pitch');
    expect(unsupported).toEqual([]);
  });

  it('accepts a valid free-text tag when its category is open', () => {
    const { instruct } = buildDesignInstruct({ Gender: 'male' }, 'whisper');
    expect(instruct.split(', ').sort()).toEqual(['male', 'whisper'].sort());
  });

  it('normalises casing and full-width commas in free-text', () => {
    const { instruct } = buildDesignInstruct({}, 'MALE，WHISPER');
    expect(instruct.split(', ').sort()).toEqual(['male', 'whisper'].sort());
  });

  it('ignores Auto and empty input', () => {
    expect(buildDesignInstruct({ Gender: 'Auto', Age: 'Auto' }, '').instruct).toBe('');
    expect(buildDesignInstruct({}, '').instruct).toBe('');
  });

  it('does not count an unknown dropdown value as unsupported free-text', () => {
    // CATEGORIES↔dropdown drift: warned in dev, excluded from instruct, NOT a
    // free-text "unsupported" item.
    const { instruct, unsupported } = buildDesignInstruct({ Gender: 'nonbinary' }, '');
    expect(instruct).toBe('');
    expect(unsupported).toEqual([]);
  });
});
