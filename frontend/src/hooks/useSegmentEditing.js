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

// Stable empty map so `lastGenFingerprints` keeps a constant identity for a
// language with no stored hashes (avoids effect/callback churn).
const EMPTY_FINGERPRINTS = {};

export default function useSegmentEditing() {
  const dubSegments = useAppStore((s) => s.dubSegments);
  const setDubSegments = useAppStore((s) => s.setDubSegments);

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
  const segmentEditField = useCallback(
    (id, field, value) => {
      pushUndo(dubSegments);
      // P1.2 — a manual text edit is a translation edit for the CURRENT
      // target language: keep `translations[lang]` in lock-step with `text`
      // so switching languages and back never loses the edit.
      const lang = useAppStore.getState().dubLangCode;
      setDubSegments((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          const next = { ...s, [field]: value };
          if (field === 'text' && lang) {
            next.translations = { ...s.translations, [lang]: value };
          }
          return next;
        }),
      );
    },
    [dubSegments],
  );

  const segmentDelete = useCallback(
    (id) => {
      pushUndo(dubSegments);
      setDubSegments((prev) => prev.filter((s) => s.id !== id));
    },
    [dubSegments],
  );

  // Timeline drag/resize commit (#280, item 3). Called ONCE per gesture by
  // SegmentTrack (live drag positions stay in component state); keyboard
  // nudges coalesce by passing undo:false after the first nudge of a focus
  // session. String(id) match fixes the old parseInt('seg-3_a') bug that
  // edited the wrong segment after a split. commitMoveResize() preserves
  // fingerprint parity (move never touches generation inputs; resize only
  // changes `speed`, dropping the key at 1.0).
  const segmentMoveResize = useCallback(
    (id, { start, end }, opts = {}) => {
      const { undo = true } = opts;
      if (undo) pushUndo(dubSegments);
      setDubSegments((prev) =>
        prev.map((s) => (String(s.id) === String(id) ? commitMoveResize(s, { start, end }) : s)),
      );
    },
    [dubSegments],
  );

  // Timeline selection — syncs the segment table (scroll + highlight).
  const [timelineSelSegId, setTimelineSelSegId] = useState(null);

  const segmentRestoreOriginal = useCallback(
    (id) => {
      pushUndo(dubSegments);
      // "Use the original text for this row" is a per-language decision like
      // any other text edit — record it under the current language so a
      // round-trip through another language doesn't resurrect the discarded
      // translation (P1.2).
      const lang = useAppStore.getState().dubLangCode;
      setDubSegments((prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          const restored = s.text_original || s.text;
          return {
            ...s,
            text: restored,
            ...(lang ? { translations: { ...s.translations, [lang]: restored } } : {}),
            translate_error: undefined,
          };
        }),
      );
    },
    [dubSegments],
  );

  // Segment multi-select
  const [selectedSegIds, setSelectedSegIds] = useState(new Set());
  const lastSelectedIdxRef = useRef(null);

  const toggleSegSelect = useCallback(
    (id, idx, shift) => {
      setSelectedSegIds((prev) => {
        const next = new Set(prev);
        if (shift && lastSelectedIdxRef.current !== null) {
          const [a, b] = [lastSelectedIdxRef.current, idx].sort((x, y) => x - y);
          for (let i = a; i <= b; i++) {
            const s = dubSegments[i];
            if (s) next.add(s.id);
          }
        } else {
          if (next.has(id)) next.delete(id);
          else next.add(id);
          lastSelectedIdxRef.current = idx;
        }
        return next;
      });
    },
    [dubSegments],
  );

  const selectAllSegs = useCallback((segs) => {
    setSelectedSegIds(new Set(segs.map((s) => s.id)));
  }, []);

  const clearSegSelection = useCallback(() => setSelectedSegIds(new Set()), []);

  // Bulk actions
  const bulkApplyToSelected = useCallback(
    (patch) => {
      if (!selectedSegIds.size) return;
      pushUndo(dubSegments);
      setDubSegments((prev) =>
        prev.map((s) => (selectedSegIds.has(s.id) ? { ...s, ...patch } : s)),
      );
    },
    [dubSegments, selectedSegIds],
  );

  const bulkDeleteSelected = useCallback(async () => {
    if (!selectedSegIds.size) return;
    if (
      !(await askConfirm(
        `Delete ${selectedSegIds.size} selected segment${selectedSegIds.size === 1 ? '' : 's'}?`,
      ))
    )
      return;
    pushUndo(dubSegments);
    setDubSegments((prev) => prev.filter((s) => !selectedSegIds.has(s.id)));
    setSelectedSegIds(new Set());
  }, [dubSegments, selectedSegIds]);

  // Split at text cursor. Time split proportional to cursor position in text.
  const segmentSplit = useCallback(
    (id, cursorPos) => {
      pushUndo(dubSegments);
      setDubSegments((prev) => {
        const idx = prev.findIndex((s) => s.id === id);
        if (idx < 0) return prev;
        const seg = prev[idx];
        const text = seg.text || '';
        const pos = Math.max(1, Math.min(cursorPos, text.length - 1));
        const ratio = text.length > 0 ? pos / text.length : 0.5;
        const midT = seg.start + (seg.end - seg.start) * ratio;
        // Other languages' saved texts (P1.2) can't be split at a sensible
        // position for the halves — drop them; the halves are new segment ids
        // that need fresh TTS per language anyway.
        const left = {
          ...seg,
          id: `${seg.id}_a`,
          text: text.slice(0, pos).trim(),
          end: midT,
          text_original: text.slice(0, pos).trim(),
          translations: undefined,
        };
        const right = {
          ...seg,
          id: `${seg.id}_b`,
          text: text.slice(pos).trim(),
          start: midT,
          text_original: text.slice(pos).trim(),
          translations: undefined,
        };
        return [...prev.slice(0, idx), left, right, ...prev.slice(idx + 1)];
      });
    },
    [dubSegments],
  );

  // Merge segment with its next sibling.
  const segmentMerge = useCallback(
    (id) => {
      pushUndo(dubSegments);
      setDubSegments((prev) => {
        const idx = prev.findIndex((s) => s.id === id);
        if (idx < 0 || idx >= prev.length - 1) return prev;
        const a = prev[idx];
        const b = prev[idx + 1];
        // Merge per-language texts (P1.2) only where BOTH sides carry the
        // language — a half-known language would otherwise mix two languages
        // in one entry. Missing entries just mean "translate again".
        const ta = a.translations || {};
        const tb = b.translations || {};
        const mergedTranslations = {};
        for (const lang of Object.keys(ta)) {
          if (typeof ta[lang] === 'string' && typeof tb[lang] === 'string') {
            mergedTranslations[lang] = `${ta[lang]} ${tb[lang]}`.trim();
          }
        }
        const merged = {
          ...a,
          text: `${a.text || ''} ${b.text || ''}`.trim(),
          text_original:
            `${a.text_original || a.text || ''} ${b.text_original || b.text || ''}`.trim(),
          end: b.end,
          translations: Object.keys(mergedTranslations).length ? mergedTranslations : undefined,
        };
        return [...prev.slice(0, idx), merged, ...prev.slice(idx + 2)];
      });
    },
    [dubSegments],
  );

  // Direction editor state
  const [directionSegId, setDirectionSegId] = useState(null);
  const openDirection = useCallback((seg) => setDirectionSegId(seg.id), []);
  const closeDirection = useCallback(() => setDirectionSegId(null), []);
  const saveDirection = useCallback(
    (value) => {
      if (!directionSegId) return;
      pushUndo(dubSegments);
      setDubSegments((prev) =>
        prev.map((s) => (s.id === directionSegId ? { ...s, direction: value || undefined } : s)),
      );
    },
    [directionSegId, dubSegments],
  );

  // Incremental plan — tracks which segments changed since last generate.
  // P1.3: fingerprints are stored PER LANGUAGE ({ lang: { segId: hash } }),
  // and `lastGenFingerprints` is the ACTIVE language's map — so "Regen N
  // changed" is judged against the track you're looking at, never against
  // whichever language happened to generate last. Switching to a language
  // that was never generated yields an empty map → no plan (no false
  // "all fresh" / "all stale" claims).
  const dubLangCode = useAppStore((s) => s.dubLangCode);
  const [fingerprintsByLang, setFingerprintsByLang] = useState({});
  const lastGenFingerprints = fingerprintsByLang[dubLangCode] || EMPTY_FINGERPRINTS;
  // Same call signature as before for existing single-track callers; the
  // optional `lang` pins the map to the track that produced the hashes
  // (e.g. each pick of the multi-language batch loop) instead of whatever
  // the store's selection is by the time the response lands.
  const setLastGenFingerprints = useCallback((map, lang) => {
    const key = lang || useAppStore.getState().dubLangCode;
    if (!key) return;
    setFingerprintsByLang((prev) => ({ ...prev, [key]: map || {} }));
  }, []);
  const [incrementalPlan, setIncrementalPlan] = useState(null);

  const recomputeIncremental = useCallback(async () => {
    if (!dubSegments.length || !Object.keys(lastGenFingerprints).length) {
      setIncrementalPlan(null);
      return;
    }
    try {
      // Same payload shape as the generate request (utils/segments.js) so
      // stored fingerprints actually match unchanged segments (#281). `lang`
      // must match the language the generate run hashed with — it's part of
      // the fingerprint now (P1.3).
      const res = await apiPost('/tools/incremental', {
        segments: dubSegments.map((s) => ({ id: String(s.id), ...segmentGenInputs(s) })),
        stored_hashes: lastGenFingerprints,
        lang: dubLangCode,
      });
      setIncrementalPlan({ stale: res.stale, fresh: res.fresh });
    } catch (e) {
      console.warn('incremental plan failed', e);
    }
  }, [dubSegments, lastGenFingerprints, dubLangCode]);

  return {
    // Undo/Redo
    undo,
    redo,
    pushUndo,
    editSegments,
    // Per-segment operations
    segmentEditField,
    segmentDelete,
    segmentRestoreOriginal,
    segmentSplit,
    segmentMerge,
    segmentMoveResize,
    // Timeline selection (waveform ↔ table sync)
    timelineSelSegId,
    setTimelineSelSegId,
    // Multi-select
    selectedSegIds,
    setSelectedSegIds,
    toggleSegSelect,
    selectAllSegs,
    clearSegSelection,
    bulkApplyToSelected,
    bulkDeleteSelected,
    // Direction editor
    directionSegId,
    openDirection,
    closeDirection,
    saveDirection,
    // Incremental plan
    lastGenFingerprints,
    setLastGenFingerprints,
    // Per-language fingerprint store (P1.3) — for project save/load and dub
    // history restore, which persist/rehydrate ALL tracks' hashes at once.
    fingerprintsByLang,
    setFingerprintsByLang,
    incrementalPlan,
    setIncrementalPlan,
    recomputeIncremental,
  };
}
