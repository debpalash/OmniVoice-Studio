import { describe, it, expect } from 'vitest';
import { buildDesignInstruct, instructToFormValue, designModeProfileId } from './voiceInstruct';

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

  it('clone path (#612): non-EN/ZH free-text yields no instruct, all items flagged unsupported', () => {
    // The clone synthesize path runs free-text through buildDesignInstruct({}, …)
    // exactly like this. A Vietnamese description must NOT reach the backend (it
    // 400s with "Unsupported instruct items"); it drops to "" + a warn bucket so
    // the UI shows a localized toast and synthesis still proceeds (no style).
    const { instruct, unsupported } = buildDesignInstruct({}, 'quảng cáo, sôi nổi và thu hút');
    expect(instruct).toBe('');
    expect(unsupported).toEqual(['quảng cáo', 'sôi nổi và thu hút']);
  });

  it('clone path keeps valid style tags while dropping prose in the same field', () => {
    const { instruct, unsupported } = buildDesignInstruct({}, 'whisper, sôi nổi');
    expect(instruct).toBe('whisper');
    expect(unsupported).toEqual(['sôi nổi']);
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

describe('designModeProfileId (#674 — clone must not hijack design attributes)', () => {
  const profiles = [
    { id: 'clone1', name: 'My Clone' },                 // no instruct → clone
    { id: 'clone2', name: 'Demo', instruct: '' },        // empty instruct → clone
    { id: 'design1', name: 'Narrator', instruct: 'male, low pitch' }, // design
  ];

  it('suppresses a known clone profile (so gender/timbre comes from the attributes)', () => {
    expect(designModeProfileId('clone1', profiles)).toBeNull();
    expect(designModeProfileId('clone2', profiles)).toBeNull();
  });

  it('forwards a design profile (re-render a designed voice)', () => {
    expect(designModeProfileId('design1', profiles)).toBe('design1');
  });

  it('omits when nothing is selected; passes through an unknown id (profiles not loaded)', () => {
    expect(designModeProfileId('', profiles)).toBeNull();
    expect(designModeProfileId(null, profiles)).toBeNull();
    expect(designModeProfileId('not-loaded-yet', [])).toBe('not-loaded-yet');
    expect(designModeProfileId('x', undefined)).toBe('x');
  });
});

describe('instructToFormValue (#550 [object Object] guard)', () => {
  it('extracts the string from a buildDesignInstruct() object, never "[object Object]"', () => {
    const built = buildDesignInstruct({ Gender: 'male' }, '');
    // the bug: appending the raw object to FormData string-coerces to this
    expect(String(built)).toBe('[object Object]');
    expect(typeof instructToFormValue(built)).toBe('string');
    expect(instructToFormValue(built)).toBe('male');
    expect(instructToFormValue(built)).not.toBe('[object Object]');
  });

  it('passes a plain string through and coerces null/garbage to ""', () => {
    expect(instructToFormValue('male, high pitch')).toBe('male, high pitch');
    expect(instructToFormValue(null)).toBe('');
    expect(instructToFormValue(undefined)).toBe('');
    expect(instructToFormValue({})).toBe('');
  });
});
