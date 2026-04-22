/**
 * User-preference slice — translateQuality, dualSubs, etc.
 *
 * These were `useState(() => localStorage.getItem(...))` scattered through
 * App.jsx. Centralising them in the store lets any component read/write
 * without prop-drilling and lets zustand's `persist` middleware handle
 * the storage round-trip once instead of per-field.
 */
import type { StateCreator } from 'zustand';

export type TranslateQuality = 'fast' | 'cinematic';

export interface PrefsSlice {
  translateQuality: TranslateQuality;
  dualSubs: boolean;
  burnSubs: boolean;
  glossaryVisible: boolean;
  /**
   * Phase 4.3 — staged checkpoints. When 'on', between-stage banners nudge
   * the user to review ASR / translation output before advancing. Turn 'off'
   * for rapid-fire workflows where reviewing every stage is overkill.
   */
  reviewMode: 'on' | 'off';

  setTranslateQuality: (q: TranslateQuality) => void;
  setDualSubs: (on: boolean) => void;
  setBurnSubs: (on: boolean) => void;
  setGlossaryVisible: (on: boolean) => void;
  setReviewMode: (mode: 'on' | 'off') => void;
}

export const createPrefsSlice: StateCreator<PrefsSlice, [], [], PrefsSlice> = (set) => ({
  translateQuality: 'fast',
  dualSubs: false,
  burnSubs: false,
  glossaryVisible: true,
  reviewMode: 'on',

  setTranslateQuality: (q) => set({ translateQuality: q }),
  setDualSubs:         (on) => set({ dualSubs: on }),
  setBurnSubs:         (on) => set({ burnSubs: on }),
  setGlossaryVisible:  (on) => set({ glossaryVisible: on }),
  setReviewMode:       (mode) => set({ reviewMode: mode }),
});
