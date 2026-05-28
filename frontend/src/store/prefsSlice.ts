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
export type ThemeId = 'gruvbox' | 'midnight' | 'nord' | 'solarized' | 'rose-pine' | 'catppuccin';

/**
 * Dub timing strategy — replaces audio time-compression with two cleaner
 * alternatives. `concise` trims the translation up-front so it fits at
 * natural rate (overflows surfaced for manual edit); `stretch_video`
 * stretches the source video per-segment so natural-rate audio fits
 * without lip-sync drift. `strict_slot` is the legacy compress-to-fit
 * path, retained for back-compat.
 */
export type TimingStrategy = 'concise' | 'stretch_video' | 'strict_slot';

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

  /**
   * Show RAM/CPU/VRAM live counters in the header. Default OFF — the
   * "Make voices that sound like you" landing screen shouldn't double as a
   * resource monitor. Power users can flip this on via Settings →
   * Performance. The Idle/Ready/Loading status badge + Flush button stay
   * visible regardless because they're action-relevant.
   */
  showHeaderLiveStats: boolean;

  /**
   * How the dub pipeline reconciles natural-rate TTS with the original
   * timeline. `concise` (default) trims translation to fit; `stretch_video`
   * stretches the video instead; `strict_slot` compresses the audio to fit
   * (legacy behaviour, retained for back-compat).
   */
  timingStrategy: TimingStrategy;

  setTranslateQuality: (q: TranslateQuality) => void;
  setDualSubs: (on: boolean) => void;
  setBurnSubs: (on: boolean) => void;
  setGlossaryVisible: (on: boolean) => void;
  setReviewMode: (mode: 'on' | 'off') => void;
  setShowHeaderLiveStats: (on: boolean) => void;
  setTimingStrategy: (s: TimingStrategy) => void;

  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}

export const createPrefsSlice: StateCreator<PrefsSlice, [], [], PrefsSlice> = (set) => ({
  translateQuality: 'fast',
  dualSubs: false,
  burnSubs: false,
  glossaryVisible: true,
  reviewMode: 'on',
  showHeaderLiveStats: false,
  timingStrategy: 'concise',

  setTranslateQuality:    (q) => set({ translateQuality: q }),
  setDualSubs:            (on) => set({ dualSubs: on }),
  setBurnSubs:            (on) => set({ burnSubs: on }),
  setGlossaryVisible:     (on) => set({ glossaryVisible: on }),
  setReviewMode:          (mode) => set({ reviewMode: mode }),
  setShowHeaderLiveStats: (on) => set({ showHeaderLiveStats: on }),
  setTimingStrategy:      (s) => set({ timingStrategy: s }),

  theme: 'gruvbox',
  setTheme: (id) => {
    set({ theme: id });
    // Apply to DOM — gruvbox is default (no attribute)
    if (id === 'gruvbox') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', id);
    }
  },
});
