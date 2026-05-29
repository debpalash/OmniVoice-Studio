import { describe, it, expect } from 'vitest';
import { buildDesignInstruct } from './voiceInstruct';

// plan-05 (#132): the Voice Design payload must be a validator-safe instruct —
// one valid tag per category, no unsupported free-text — so Synthesize stops
// failing with "Unsupported instruct items" (#115) / "conflicting items within
// the same category" (#114).

describe('buildDesignInstruct', () => {
  it('keeps one valid tag per category from the dropdowns', () => {
    const { instruct, dropped } = buildDesignInstruct(
      { Gender: 'male', Age: 'middle-aged', Pitch: 'low pitch', Style: 'Auto',
        EnglishAccent: 'british accent', ChineseDialect: 'Auto' },
      '',
    );
    expect(instruct.split(', ').sort())
      .toEqual(['british accent', 'low pitch', 'male', 'middle-aged'].sort());
    expect(dropped).toEqual([]);
  });

  it('drops free-text prose as unsupported and reports it (#115)', () => {
    const { instruct, dropped } = buildDesignInstruct(
      { Gender: 'male' }, 'Speak as a calm documentary narrator');
    expect(instruct).toBe('male');
    expect(dropped).toContain('Speak as a calm documentary narrator');
  });

  it('drops a free-text tag whose category a dropdown already set (no #114 conflict)', () => {
    const { instruct, dropped } = buildDesignInstruct({ Pitch: 'low pitch' }, 'high pitch');
    expect(instruct).toBe('low pitch'); // dropdown wins the category
    expect(dropped).toContain('high pitch');
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
});
