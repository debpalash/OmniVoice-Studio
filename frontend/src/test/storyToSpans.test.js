import { describe, it, expect } from 'vitest';
import { storyToSpans } from '../utils/storyToSpans';

const CAST = [
  { id: 'narrator', name: 'Narrator', profileId: 'p_narr' },
  { id: 'c_fox', name: 'Fox', profileId: 'p_fox' },
];

describe('storyToSpans', () => {
  it('resolves each line to its cast voice', () => {
    const tracks = [
      { character: 'narrator', text: 'Once upon a time.' },
      { character: 'c_fox', text: 'Hello there.' },
    ];
    const chapters = storyToSpans(tracks, CAST);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].spans).toEqual([
      { voice_id: 'p_narr', text: 'Once upon a time.', pause_ms_after: 0, speed: null },
      { voice_id: 'p_fox', text: 'Hello there.', pause_ms_after: 0, speed: null },
    ]);
  });

  it('opens a new chapter on a "# " line', () => {
    const tracks = [
      { character: 'narrator', text: '# Chapter One' },
      { character: 'narrator', text: 'Intro.' },
      { character: 'narrator', text: '# Chapter Two' },
      { character: 'c_fox', text: 'More.' },
    ];
    const chapters = storyToSpans(tracks, CAST);
    expect(chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
    expect(chapters[1].spans[0]).toEqual({ voice_id: 'p_fox', text: 'More.', pause_ms_after: 0, speed: null });
  });

  it('honors a per-line voice override', () => {
    const tracks = [{ character: 'narrator', profileId: 'p_override', text: 'Hi.' }];
    expect(storyToSpans(tracks, CAST)[0].spans[0].voice_id).toBe('p_override');
  });

  it('carries the per-line speed onto its spans', () => {
    const tracks = [{ character: 'narrator', text: 'Slow. [pause 0.2s] down.', speed: 0.8 }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans.every((s) => s.speed === 0.8)).toBe(true);
  });

  it('applies inline SSML-lite prosody (overriding the line speed)', () => {
    const tracks = [{ character: 'narrator', text: 'calm [fast]rush[/fast] [spell]USA[/spell]', speed: 0.9 }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    const calm = spans.find((s) => s.text === 'calm');
    const rush = spans.find((s) => s.text === 'rush');
    const usa = spans.find((s) => s.text === 'U S A');
    expect(calm.speed).toBe(0.9);     // plain → falls back to the line slider
    expect(rush.speed).toBe(1.15);    // [fast] overrides the line slider
    expect(usa).toBeTruthy();         // [spell] spelled the letters out
  });

  it('folds [pause] into the previous span', () => {
    const tracks = [{ character: 'narrator', text: 'Wait. [pause 0.5s] Done.' }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans[0]).toEqual({ voice_id: 'p_narr', text: 'Wait.', pause_ms_after: 500, speed: null });
    expect(spans[1]).toEqual({ voice_id: 'p_narr', text: 'Done.', pause_ms_after: 0, speed: null });
  });

  it('switches voice mid-line on [voice:]', () => {
    const tracks = [{ character: 'narrator', text: 'A [voice:p_fox] B' }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans[0].voice_id).toBe('p_narr');
    expect(spans[1].voice_id).toBe('p_fox');
  });

  it('drops empty lines and empty chapters', () => {
    const tracks = [
      { character: 'narrator', text: '# Empty' },
      { character: 'narrator', text: '   ' },
      { character: 'narrator', text: '# Real' },
      { character: 'narrator', text: 'Here.' },
    ];
    const chapters = storyToSpans(tracks, CAST);
    expect(chapters.map((c) => c.title)).toEqual(['Real']);
  });

  it('a leading pause becomes a silent span', () => {
    const tracks = [{ character: 'narrator', text: '[pause 1s] Go.' }];
    const spans = storyToSpans(tracks, CAST)[0].spans;
    expect(spans[0]).toEqual({ voice_id: 'p_narr', text: '', pause_ms_after: 1000, speed: null });
    expect(spans[1].text).toBe('Go.');
  });
});
