import { describe, it, expect } from 'vitest';
import {
  MIN_SEG_DUR, MAX_OVERLAP,
  visibleSegmentRange, snapTime, snapCandidates,
  clampSegmentEdit, commitMoveResize, detectOverlaps, nearestOnset,
} from './timeline';
import { segmentGenInputs } from './segments';

const seg = (id, start, end, extra = {}) => ({ id, start, end, text: `t${id}`, ...extra });

describe('visibleSegmentRange', () => {
  const segs = [seg(1, 0, 2), seg(2, 2, 4), seg(3, 4, 6), seg(4, 6, 8), seg(5, 8, 10)];

  it('returns the window covering the view', () => {
    const [lo, hi] = visibleSegmentRange(segs, 4.5, 5.5, 0);
    expect(segs.slice(lo, hi).map(s => s.id)).toEqual([3]);
  });

  it('includes buffer on both sides', () => {
    const [lo, hi] = visibleSegmentRange(segs, 4.5, 5.5, 2);
    expect(segs.slice(lo, hi).map(s => s.id)).toEqual([2, 3, 4]);
  });

  it('empty list → [0,0]', () => {
    expect(visibleSegmentRange([], 0, 10)).toEqual([0, 0]);
  });

  it('view before all segments → empty window', () => {
    const [lo, hi] = visibleSegmentRange(segs, -100, -50, 0);
    expect(hi - lo).toBe(0);
  });

  it('view after all segments → empty window at end', () => {
    const [lo, hi] = visibleSegmentRange(segs, 100, 200, 0);
    expect(lo).toBe(segs.length);
    expect(hi).toBe(segs.length);
  });

  it('view spanning everything returns all', () => {
    const [lo, hi] = visibleSegmentRange(segs, -1, 11, 0);
    expect([lo, hi]).toEqual([0, segs.length]);
  });

  it('walks lo back over an earlier segment that overlaps into view', () => {
    const overlapping = [seg(1, 0, 5.2), seg(2, 5, 7), seg(3, 7, 9)];
    const [lo, hi] = visibleSegmentRange(overlapping, 5.05, 6, 0);
    expect(overlapping.slice(lo, hi).map(s => s.id)).toEqual([1, 2]);
  });

  it('boundary exactly on a segment edge', () => {
    const [lo, hi] = visibleSegmentRange(segs, 2, 4, 0);
    // seg 1 ends exactly at 2 (end > t0 is false), segs 2 and 3 qualify.
    expect(segs.slice(lo, hi).map(s => s.id)).toContain(2);
    expect(segs.slice(lo, hi).map(s => s.id)).toContain(3);
  });
});

describe('snapTime', () => {
  it('snaps to the nearest candidate within threshold', () => {
    expect(snapTime(5.05, [4.0, 5.0, 6.0], 0.1)).toEqual({ time: 5.0, candidate: 5.0 });
  });

  it('no snap outside threshold', () => {
    expect(snapTime(5.5, [4.0, 6.0], 0.1)).toEqual({ time: 5.5, candidate: null });
  });

  it('tie resolves to the earliest candidate', () => {
    const r = snapTime(5.0, [4.9, 5.1], 0.2);
    expect(r.candidate).toBe(4.9);
  });

  it('ignores non-finite candidates', () => {
    expect(snapTime(1.0, [NaN, Infinity, 1.02], 0.05).candidate).toBe(1.02);
  });

  it('exact hit snaps with zero distance', () => {
    expect(snapTime(3.0, [3.0], 0.0).candidate).toBe(3.0);
  });
});

describe('snapCandidates', () => {
  it('includes onsets, neighbour edges and playhead', () => {
    const c = snapCandidates({ onsets: [1.1, 2.2], prevEnd: 0.5, nextStart: 3.3, playhead: 2.0, pxPerSec: 100, t: 1.5 });
    expect(c).toEqual(expect.arrayContaining([1.1, 2.2, 0.5, 3.3, 2.0]));
    // High zoom → no integer grid.
    expect(c).not.toContain(1);
  });

  it('adds the integer grid only at low zoom', () => {
    const c = snapCandidates({ onsets: [], pxPerSec: 20, t: 7.4 });
    expect(c).toEqual(expect.arrayContaining([7, 8]));
  });
});

describe('clampSegmentEdit', () => {
  const segs = [seg(1, 0, 2), seg(2, 3, 5), seg(3, 6, 8)];

  it('start edge clamps at previous neighbour boundary', () => {
    const r = clampSegmentEdit(segs, 1, 'start', { start: 1.0, end: 5 });
    expect(r).toEqual({ start: 2, end: 5 });
  });

  it('end edge clamps at next neighbour boundary', () => {
    const r = clampSegmentEdit(segs, 1, 'end', { start: 3, end: 7.5 });
    expect(r).toEqual({ start: 3, end: 6 });
  });

  it('resize preserves MIN_SEG_DUR against the opposite edge', () => {
    const r = clampSegmentEdit(segs, 1, 'start', { start: 4.99, end: 5 });
    expect(r.start).toBeCloseTo(5 - MIN_SEG_DUR, 5);
    const r2 = clampSegmentEdit(segs, 1, 'end', { start: 3, end: 3.01 });
    expect(r2.end).toBeCloseTo(3 + MIN_SEG_DUR, 5);
  });

  it('Alt allows up to MAX_OVERLAP past the neighbour, never more', () => {
    const r = clampSegmentEdit(segs, 1, 'start', { start: 1.0, end: 5 }, { allowOverlap: true });
    expect(r.start).toBeCloseTo(2 - MAX_OVERLAP, 5);
    const r2 = clampSegmentEdit(segs, 1, 'end', { start: 3, end: 9 }, { allowOverlap: true });
    expect(r2.end).toBeCloseTo(6 + MAX_OVERLAP, 5);
  });

  it('move preserves duration and clamps inside both neighbours', () => {
    const r = clampSegmentEdit(segs, 1, 'move', { start: 0.5, end: 2.5 });
    expect(r).toEqual({ start: 2, end: 4 });
    const r2 = clampSegmentEdit(segs, 1, 'move', { start: 5.5, end: 7.5 });
    expect(r2).toEqual({ start: 4, end: 6 });
  });

  it('move never crosses zero for the first segment', () => {
    const r = clampSegmentEdit(segs, 0, 'move', { start: -3, end: -1 });
    expect(r).toEqual({ start: 0, end: 2 });
  });

  it('end of the last segment clamps to the track duration', () => {
    const r = clampSegmentEdit(segs, 2, 'end', { start: 6, end: 50 }, { duration: 10 });
    expect(r.end).toBe(10);
  });
});

describe('commitMoveResize — fingerprint parity (#281 invariants)', () => {
  it('a pure move leaves segmentGenInputs untouched', () => {
    const before = seg('3_a', 2, 4, { profile_id: 'p1', instruct: 'calm', target_lang: 'de' });
    const after = commitMoveResize(before, { start: 3, end: 5 });
    expect(after.start).toBe(3);
    expect(after.end).toBe(5);
    expect(segmentGenInputs(after)).toEqual(segmentGenInputs(before));
    // No speed/original_duration introduced by a move.
    expect('speed' in after).toBe(false);
    expect('original_duration' in after).toBe(false);
  });

  it('a resize changes ONLY speed among generation inputs', () => {
    const before = seg(7, 2, 4, { profile_id: 'p1' });
    const after = commitMoveResize(before, { start: 2, end: 3 });
    const gi0 = segmentGenInputs(before);
    const gi1 = segmentGenInputs(after);
    expect(gi1.speed).toBe(2);                 // 2s original / 1s slot
    expect({ ...gi1, speed: undefined }).toEqual({ ...gi0, speed: undefined });
    expect(after.original_duration).toBe(2);
  });

  it('successive resizes compound against the FIRST original_duration', () => {
    const s0 = seg(1, 0, 4);
    const s1 = commitMoveResize(s0, { start: 0, end: 2 });   // speed 2
    expect(s1.speed).toBe(2);
    const s2 = commitMoveResize(s1, { start: 0, end: 8 });   // back from 4s original → 0.5
    expect(s2.speed).toBe(0.5);
    expect(s2.original_duration).toBe(4);
  });

  it('resize landing at speed 1.0 DELETES the key (missing hashes as "")', () => {
    const s0 = seg(1, 0, 4);
    const s1 = commitMoveResize(s0, { start: 0, end: 2 });
    const s2 = commitMoveResize(s1, { start: 0, end: 4 });   // back to original duration
    expect('speed' in s2).toBe(false);
    expect(segmentGenInputs(s2).speed).toBeUndefined();
  });

  it('string split ids ("3_a") survive untouched — no parseInt mangling', () => {
    const after = commitMoveResize(seg('3_a', 1, 2), { start: 1.5, end: 2.5 });
    expect(after.id).toBe('3_a');
  });

  it('zero/negative duration guard yields speed key dropped (1.0)', () => {
    const after = commitMoveResize(seg(1, 0, 2), { start: 2, end: 2 });
    expect('speed' in after).toBe(false);
  });
});

describe('detectOverlaps', () => {
  it('flags both members of an overlapping pair', () => {
    const set = detectOverlaps([seg(1, 0, 2.1), seg(2, 2, 4)]);
    expect(set.has('1')).toBe(true);
    expect(set.has('2')).toBe(true);
  });

  it('touching edges do not flag', () => {
    expect(detectOverlaps([seg(1, 0, 2), seg(2, 2, 4)]).size).toBe(0);
  });

  it('unsorted input still detected; ids stringified', () => {
    const set = detectOverlaps([seg('3_b', 5, 7), seg('3_a', 4, 5.1)]);
    expect(set).toEqual(new Set(['3_a', '3_b']));
  });
});

describe('nearestOnset', () => {
  it('returns the closest onset', () => {
    expect(nearestOnset(2.4, [0, 2.5, 5])).toBe(2.5);
  });
  it('empty → null', () => {
    expect(nearestOnset(1, [])).toBeNull();
  });
});
