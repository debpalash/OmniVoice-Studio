import { describe, it, expect } from 'vitest';
import { parseScript, normalizeSpeaker } from './parseScript';

const L = '“'; // “
const R = '”'; // ”

describe('normalizeSpeaker', () => {
  it('drops a leading "the", trims punctuation, title-cases', () => {
    expect(normalizeSpeaker('the fox')).toBe('Fox');
    expect(normalizeSpeaker('OWL,')).toBe('Owl');
    expect(normalizeSpeaker('  red riding hood ')).toBe('Red Riding Hood');
    expect(normalizeSpeaker('')).toBe('Narrator');
  });
});

describe('parseScript — screenplay', () => {
  it('parses NAME: dialogue lines', () => {
    const r = parseScript('FOX: Where are we going?\nOWL: Somewhere safe.');
    expect(r).toEqual([
      { speaker: 'Fox', text: 'Where are we going?' },
      { speaker: 'Owl', text: 'Somewhere safe.' },
    ]);
  });
  it('does not treat a URL as a speaker', () => {
    const r = parseScript('See https://example.com for details.');
    expect(r).toEqual([{ speaker: 'Narrator', text: 'See https://example.com for details.' }]);
  });
});

describe('parseScript — prose', () => {
  it('attributes a quote from a leading dialogue tag', () => {
    const r = parseScript('The fox asked, "Where are we going?"');
    expect(r.some((s) => s.speaker === 'Fox' && s.text === 'Where are we going?')).toBe(true);
  });
  it('attributes a quote from a trailing dialogue tag', () => {
    const r = parseScript('"Run!" shouted Milo.');
    expect(r.some((s) => s.speaker === 'Milo' && s.text === 'Run!')).toBe(true);
  });
  it('handles curly quotes + "said the owl"', () => {
    const r = parseScript(`${L}Somewhere safe,${R} said the owl.`);
    expect(r.some((s) => s.speaker === 'Owl' && s.text.startsWith('Somewhere safe'))).toBe(true);
  });
  it('pure narration → Narrator', () => {
    const r = parseScript('It was a dark and stormy night.');
    expect(r).toEqual([{ speaker: 'Narrator', text: 'It was a dark and stormy night.' }]);
  });
  it('unattributed quote falls back to Narrator', () => {
    const r = parseScript('A sign read "Keep Out".');
    expect(r.some((s) => s.text === 'Keep Out')).toBe(true);
    // no name nearby → narrator
    expect(r.find((s) => s.text === 'Keep Out').speaker).toBe('Narrator');
  });
  it('returns [] for empty input', () => {
    expect(parseScript('')).toEqual([]);
    expect(parseScript('   ')).toEqual([]);
  });
});
