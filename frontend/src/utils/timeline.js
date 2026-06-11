/**
 * timeline.js — pure math/state helpers for the dub timeline segment editor
 * (#280, item 3). Everything here is DOM-free and unit-tested; SegmentTrack
 * only does rendering + pointer/keyboard plumbing on top of these.
 *
 * All times are seconds (float), all pixels are CSS px.
 */

// Minimum slot a segment may be resized down to. Matches the backend's
// MIN_SEG_DUR_S in services/onset_align.py.
export const MIN_SEG_DUR = 0.3;
// Alt-drag may push past the hard non-overlap clamp by at most this much.
// The backend mix loop sums placements, so a small overlap is audibly safe.
export const MAX_OVERLAP = 0.2;
// Snap radius in *pixels* — converted to seconds via pxPerSec at call sites.
export const SNAP_PX = 8;
// Below this zoom the integer-second grid joins the snap candidates.
export const GRID_SNAP_MAX_PX_PER_SEC = 40;

// Segment box palette — was WaveformTimeline's region palette; lives here so
// both the track and any legend can share it without circular imports.
export const REGION_COLORS = [
  'rgba(211,134,155,0.3)',
  'rgba(131,165,152,0.3)',
  'rgba(184,187,38,0.3)',
  'rgba(250,189,47,0.3)',
  'rgba(142,192,124,0.3)',
  'rgba(254,128,25,0.3)',
  'rgba(104,157,106,0.3)',
];

export const timeToPx = (t, pxPerSec) => t * pxPerSec;
export const pxToTime = (px, pxPerSec) => (pxPerSec > 0 ? px / pxPerSec : 0);

/**
 * visibleSegmentRange — windowing for the virtualized track.
 *
 * Binary search over segments sorted by `start` for the index window
 * covering [viewStart, viewEnd] (+ buffer). Returns [lo, hi) — render
 * segments.slice(lo, hi). Tolerates the ≤MAX_OVERLAP overlaps the editor
 * allows by walking `lo` back while the previous segment still reaches
 * into view.
 */
export function visibleSegmentRange(segments, viewStart, viewEnd, bufferS = 2) {
  const n = segments.length;
  if (!n) return [0, 0];
  const t0 = viewStart - bufferS;
  const t1 = viewEnd + bufferS;

  // lo: first segment whose end could reach t0 — lower_bound on start >= t0,
  // then step back over any segments that start earlier but end inside view.
  let a = 0, b = n;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (segments[mid].start < t0) a = mid + 1; else b = mid;
  }
  let lo = a;
  while (lo > 0 && segments[lo - 1].end > t0) lo -= 1;

  // hi: first segment that starts after t1 (upper_bound on start > t1).
  a = lo; b = n;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (segments[mid].start <= t1) a = mid + 1; else b = mid;
  }
  return [lo, a];
}

/**
 * snapTime — pure snap: nearest candidate within thresholdS wins.
 * Ties resolve to the earliest candidate so behaviour is deterministic.
 * Returns { time, candidate } — candidate === null means "no snap".
 */
export function snapTime(t, candidates, thresholdS) {
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (!Number.isFinite(c)) continue;
    const d = Math.abs(c - t);
    if (d <= thresholdS && (d < bestDist || (d === bestDist && best !== null && c < best))) {
      best = c;
      bestDist = d;
    }
  }
  return best === null ? { time: t, candidate: null } : { time: best, candidate: best };
}

/**
 * snapCandidates — the candidate set for a drag, per the editor spec:
 * onsets + adjacent segment edges + playhead + (at low zoom) the
 * integer-second grid around t.
 */
export function snapCandidates({ onsets = [], prevEnd, nextStart, playhead, pxPerSec, t }) {
  const out = [];
  for (const o of onsets) out.push(o);
  if (Number.isFinite(prevEnd)) out.push(prevEnd);
  if (Number.isFinite(nextStart)) out.push(nextStart);
  if (Number.isFinite(playhead)) out.push(playhead);
  if (pxPerSec > 0 && pxPerSec < GRID_SNAP_MAX_PX_PER_SEC && Number.isFinite(t)) {
    out.push(Math.floor(t), Math.ceil(t));
  }
  return out;
}

/**
 * clampSegmentEdit — enforce the overlap/ordering rules on a proposed edit.
 *
 * mode: 'start' | 'end' | 'move'
 * Default = hard non-overlap: edges clamp exactly at the neighbour's
 * boundary (segments may touch, never cross). With allowOverlap (Alt held)
 * the edge may push up to MAX_OVERLAP past the neighbour. Reordering past a
 * neighbour is never possible. Resizes preserve MIN_SEG_DUR against the
 * opposite edge; moves preserve duration.
 */
export function clampSegmentEdit(segments, index, mode, proposed, opts = {}) {
  const { allowOverlap = false, duration = Infinity } = opts;
  const seg = segments[index];
  const prev = index > 0 ? segments[index - 1] : null;
  const next = index < segments.length - 1 ? segments[index + 1] : null;
  const give = allowOverlap ? MAX_OVERLAP : 0;
  const minStart = Math.max(0, prev ? prev.end - give : 0);
  const maxEnd = Math.min(duration, next ? next.start + give : duration);

  let start;
  let end;
  if (mode === 'move') {
    const dur = seg.end - seg.start;
    start = Math.max(minStart, Math.min(proposed.start, maxEnd - dur));
    // Degenerate squeeze (neighbours closer than the segment is long):
    // pin to the lower bound rather than producing start > end games.
    if (start < minStart) start = minStart;
    end = start + dur;
  } else if (mode === 'start') {
    start = Math.min(Math.max(proposed.start, minStart), seg.end - MIN_SEG_DUR);
    end = seg.end;
  } else {
    end = Math.max(Math.min(proposed.end, maxEnd), seg.start + MIN_SEG_DUR);
    start = seg.start;
  }
  return { start: +start.toFixed(3), end: +end.toFixed(3) };
}

/**
 * commitMoveResize — produce the updated segment object for a finished
 * move/resize gesture, with FINGERPRINT PARITY against utils/segments.js'
 * segmentGenInputs():
 *
 *  - A pure MOVE (duration preserved) touches ONLY start/end. Neither field
 *    is a generation input, so the segment stays cache-fresh.
 *  - A RESIZE recomputes speed exactly like the old Regions handler:
 *    speed = +(original_duration / newDuration).toFixed(2), persisting the
 *    very first original_duration so successive drags compound correctly.
 *  - If a resize lands back at speed === 1.0 the `speed` key is DELETED
 *    instead of stored: the backend's _canon_value hashes a missing field
 *    as "" but 1.0 as 1.0, so storing the literal would wrongly mark a
 *    never-speed-adjusted segment stale.
 */
export function commitMoveResize(seg, { start, end }) {
  const newStart = +start.toFixed(2);
  const newEnd = +end.toFixed(2);
  const oldDur = seg.end - seg.start;
  const newDur = newEnd - newStart;
  const isMove = Math.abs(newDur - oldDur) < 0.005;
  if (isMove) {
    return { ...seg, start: newStart, end: newEnd };
  }
  const origDur = seg.original_duration || oldDur;
  const newSpeed = newDur > 0 ? +(origDur / newDur).toFixed(2) : 1.0;
  const next = { ...seg, start: newStart, end: newEnd, original_duration: origDur };
  if (newSpeed === 1) {
    delete next.speed;
  } else {
    next.speed = newSpeed;
  }
  return next;
}

/**
 * detectOverlaps — Set of String(id) for every segment that overlaps a
 * neighbour (start-sorted sweep; tiny epsilon so touching edges don't flag).
 */
export function detectOverlaps(segments, epsilon = 1e-6) {
  const flagged = new Set();
  if (segments.length < 2) return flagged;
  const sorted = [...segments].sort((x, y) => x.start - y.start || x.end - y.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.start < prev.end - epsilon) {
      flagged.add(String(prev.id));
      flagged.add(String(cur.id));
    }
  }
  return flagged;
}

/** nearestOnset — closest onset to t, or null when none exist. */
export function nearestOnset(t, onsets) {
  let best = null;
  let bestDist = Infinity;
  for (const o of onsets) {
    const d = Math.abs(o - t);
    if (d < bestDist) { best = o; bestDist = d; }
  }
  return best;
}
