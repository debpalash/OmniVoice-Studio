/**
 * useSegmentEditing — undo/redo stack + segment CRUD operations for the dub timeline.
 *
 * Extracted from App.jsx to reduce its useState/useRef/useCallback count.
 * All segment mutations go through this hook so undo tracking is automatic.
 */
import { useState, useRef, useCallback } from 'react';
import { useAppStore } from '../store';
import { askConfirm } from '../utils/dialog';
import { apiPost } from '../api/client';
import { segmentGenInputs } from '../utils/segments';
import { commitMoveResize } from '../utils/timeline';

export default function useSegmentEditing() {
  const dubSegments = useAppStore(s => s.dubSegments);
  const setDubSegments = useAppStore(s => s.setDubSegments);

  // ── Undo / Redo ──
  const undoStack = useRef([]);
  const redoStack = useRef([]);

  const pushUndo = (segments) => {
    undoStack.current.push(JSON.stringify(segments));
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = []; // clear redo on new edit
  };

  const undo = () => {
    if (undoStack.current.length === 0) return;
    redoStack.current.push(JSON.stringify(dubSegments));
    const prev = JSON.parse(undoStack.current.pop());
    setDubSegments(prev);
  };

  const redo = () => {
    if (redoStack.current.length === 0) return;
    undoStack.current.push(JSON.stringify(dubSegments));
    const next = JSON.parse(redoStack.current.pop());
    setDubSegments(next);
  };

  // Wrap setDubSegments calls that are user-edits with undo tracking
  const editSegments = (newSegs) => {
    pushUndo(dubSegments);
    setDubSegments(newSegs);
  };

  // Stable handlers for virtualized segment rows. Use functional updates so
  // they don't depend on dubSegments identity (avoids row re-renders).
  const segmentEditField = useCallback((id, field, value) => {
    pushUndo(dubSegments);
    setDubSegments(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
  }, [dubSegments]);

  const segmentDelete = useCallback((id) => {
    pushUndo(dubSegments);
    setDubSegments(prev => prev.filter(s => s.id !== id));
  }, [dubSegments]);

  // Timeline drag/resize commit (#280, item 3). Called ONCE per gesture by
  // SegmentTrack (live drag positions stay in component state); keyboard
  // nudges coalesce by passing undo:false after the first nudge of a focus
  // session. String(id) match fixes the old parseInt('seg-3_a') bug that
  // edited the wrong segment after a split. commitMoveResize() preserves
  // fingerprint parity (move never touches generation inputs; resize only
  // changes `speed`, dropping the key at 1.0).
  const segmentMoveResize = useCallback((id, { start, end }, opts = {}) => {
    const { undo = true } = opts;
    if (undo) pushUndo(dubSegments);
    setDubSegments(prev => prev.map(s =>
      String(s.id) === String(id) ? commitMoveResize(s, { start, end }) : s));
  }, [dubSegments]);

  // Timeline selection — syncs the segment table (scroll + highlight).
  const [timelineSelSegId, setTimelineSelSegId] = useState(null);

  const segmentRestoreOriginal = useCallback((id) => {
    pushUndo(dubSegments);
    setDubSegments(prev => prev.map(s => s.id === id
      ? { ...s, text: s.text_original || s.text, translate_error: undefined }
      : s));
  }, [dubSegments]);

  // Segment multi-select
  const [selectedSegIds, setSelectedSegIds] = useState(new Set());
  const lastSelectedIdxRef = useRef(null);

  const toggleSegSelect = useCallback((id, idx, shift) => {
    setSelectedSegIds(prev => {
      const next = new Set(prev);
      if (shift && lastSelectedIdxRef.current !== null) {
        const [a, b] = [lastSelectedIdxRef.current, idx].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) {
          const s = dubSegments[i];
          if (s) next.add(s.id);
        }
      } else {
        if (next.has(id)) next.delete(id); else next.add(id);
        lastSelectedIdxRef.current = idx;
      }
      return next;
    });
  }, [dubSegments]);

  const selectAllSegs = useCallback((segs) => {
    setSelectedSegIds(new Set(segs.map(s => s.id)));
  }, []);

  const clearSegSelection = useCallback(() => setSelectedSegIds(new Set()), []);

  // Bulk actions
  const bulkApplyToSelected = useCallback((patch) => {
    if (!selectedSegIds.size) return;
    pushUndo(dubSegments);
    setDubSegments(prev => prev.map(s => selectedSegIds.has(s.id) ? { ...s, ...patch } : s));
  }, [dubSegments, selectedSegIds]);

  const bulkDeleteSelected = useCallback(async () => {
    if (!selectedSegIds.size) return;
    if (!(await askConfirm(`Delete ${selectedSegIds.size} selected segment${selectedSegIds.size === 1 ? '' : 's'}?`))) return;
    pushUndo(dubSegments);
    setDubSegments(prev => prev.filter(s => !selectedSegIds.has(s.id)));
    setSelectedSegIds(new Set());
  }, [dubSegments, selectedSegIds]);

  // Split at text cursor. Time split proportional to cursor position in text.
  const segmentSplit = useCallback((id, cursorPos) => {
    pushUndo(dubSegments);
    setDubSegments(prev => {
      const idx = prev.findIndex(s => s.id === id);
      if (idx < 0) return prev;
      const seg = prev[idx];
      const text = seg.text || '';
      const pos = Math.max(1, Math.min(cursorPos, text.length - 1));
      const ratio = text.length > 0 ? pos / text.length : 0.5;
      const midT = seg.start + (seg.end - seg.start) * ratio;
      const left = { ...seg, id: `${seg.id}_a`, text: text.slice(0, pos).trim(), end: midT, text_original: text.slice(0, pos).trim() };
      const right = { ...seg, id: `${seg.id}_b`, text: text.slice(pos).trim(), start: midT, text_original: text.slice(pos).trim() };
      return [...prev.slice(0, idx), left, right, ...prev.slice(idx + 1)];
    });
  }, [dubSegments]);

  // Merge segment with its next sibling.
  const segmentMerge = useCallback((id) => {
    pushUndo(dubSegments);
    setDubSegments(prev => {
      const idx = prev.findIndex(s => s.id === id);
      if (idx < 0 || idx >= prev.length - 1) return prev;
      const a = prev[idx];
      const b = prev[idx + 1];
      const merged = {
        ...a,
        text: `${a.text || ''} ${b.text || ''}`.trim(),
        text_original: `${a.text_original || a.text || ''} ${b.text_original || b.text || ''}`.trim(),
        end: b.end,
      };
      return [...prev.slice(0, idx), merged, ...prev.slice(idx + 2)];
    });
  }, [dubSegments]);

  // Direction editor state
  const [directionSegId, setDirectionSegId] = useState(null);
  const openDirection = useCallback((seg) => setDirectionSegId(seg.id), []);
  const closeDirection = useCallback(() => setDirectionSegId(null), []);
  const saveDirection = useCallback((value) => {
    if (!directionSegId) return;
    pushUndo(dubSegments);
    setDubSegments(prev => prev.map(s => s.id === directionSegId
      ? { ...s, direction: value || undefined }
      : s));
  }, [directionSegId, dubSegments]);

  // Incremental plan — tracks which segments changed since last generate
  const [lastGenFingerprints, setLastGenFingerprints] = useState({});
  const [incrementalPlan, setIncrementalPlan] = useState(null);

  const recomputeIncremental = useCallback(async () => {
    if (!dubSegments.length || !Object.keys(lastGenFingerprints).length) {
      setIncrementalPlan(null);
      return;
    }
    try {
      // Same payload shape as the generate request (utils/segments.js) so
      // stored fingerprints actually match unchanged segments (#281).
      const res = await apiPost('/tools/incremental', {
        segments: dubSegments.map(s => ({ id: String(s.id), ...segmentGenInputs(s) })),
        stored_hashes: lastGenFingerprints,
      });
      setIncrementalPlan({ stale: res.stale, fresh: res.fresh });
    } catch (e) {
      console.warn('incremental plan failed', e);
    }
  }, [dubSegments, lastGenFingerprints]);

  return {
    // Undo/Redo
    undo, redo, pushUndo, editSegments,
    // Per-segment operations
    segmentEditField, segmentDelete, segmentRestoreOriginal,
    segmentSplit, segmentMerge, segmentMoveResize,
    // Timeline selection (waveform ↔ table sync)
    timelineSelSegId, setTimelineSelSegId,
    // Multi-select
    selectedSegIds, setSelectedSegIds,
    toggleSegSelect, selectAllSegs, clearSegSelection,
    bulkApplyToSelected, bulkDeleteSelected,
    // Direction editor
    directionSegId, openDirection, closeDirection, saveDirection,
    // Incremental plan
    lastGenFingerprints, setLastGenFingerprints,
    incrementalPlan, setIncrementalPlan,
    recomputeIncremental,
  };
}
