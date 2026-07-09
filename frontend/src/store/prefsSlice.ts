/**
 * User-preference slice — translateQuality, dualSubs, etc.
 *
 * These were `useState(() => localStorage.getItem(...))` scattered through
 * App.jsx. Centralising them in the store lets any component read/write
 * without prop-drilling and lets zustand's `persist` middleware handle
 * the storage round-trip once instead of per-field.
 */
import type { StateCreator } from 'zustand';
import { apiJson, apiPost } from '../api/client';

type TranslateQuality = 'fast' | 'autofit' | 'cinematic';
type ThemeId = 'gruvbox' | 'midnight' | 'nord' | 'solarized' | 'rose-pine' | 'catppuccin';

/** Dictation start/stop semantics — mirror of the backend `dictation.mode`. */
type DictationMode = 'toggle' | 'hold';

/** Default sherpa dictation model id — matches the backend
 * `sherpa_dictation.DEFAULT_MODEL_ID`. Used only as the pre-hydration seed;
 * the authoritative value comes from `GET /dictation/prefs`. */
const DEFAULT_DICTATION_MODEL_ID = 'sherpa-parakeet-tdt-v3';

/**
 * Global UI font. Applied app-wide by overriding the `--font-sans` CSS custom
 * property on `document.documentElement` (the whole UI uses
 * `font-family: var(--font-sans)`). `default` removes the override so the CSS
 * `:root` Inter stack takes over. All stacks are SYSTEM-SAFE — no web-font
 * downloads, so this works identically offline across macOS/Windows/Linux.
 */
type FontId = 'default' | 'system' | 'serif' | 'mono' | 'rounded' | 'readable';

export const FONT_OPTIONS: { id: FontId; label: string }[] = [
  { id: 'default', label: 'Inter (default)' },
  { id: 'system', label: 'System' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Monospace' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'readable', label: 'Readable' },
];

export const FONT_STACKS: Record<FontId, string | null> = {
  default: null, // use the CSS :root --font-sans (Inter)
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
  rounded: '"SF Pro Rounded", "Nunito", "Quicksand", system-ui, sans-serif',
  readable: '"Atkinson Hyperlegible", Verdana, system-ui, sans-serif',
};

/**
 * Dub timing strategy — replaces audio time-compression with cleaner
 * alternatives. `concise` trims the translation up-front so it fits at
 * natural rate (overflows surfaced for manual edit); `smart_fit` splits
 * the burden between a mild audio speed-up (≤1.2× alone, ≤1.5× hybrid)
 * and a mild per-segment video slow-down (≤2.0×); `stretch_video`
 * stretches the source video per-segment so natural-rate audio fits
 * without lip-sync drift. `strict_slot` is the legacy compress-to-fit
 * path, retained for back-compat.
 */
type TimingStrategy = 'concise' | 'smart_fit' | 'stretch_video' | 'strict_slot';

/**
 * Knob overrides for the `smart_fit` strategy. `null` (default) sends no
 * `fit_options` and the backend uses its canonical FitParams defaults —
 * identical behavior on every platform out of the box.
 */
interface FitOptions {
  max_audio_only_rate?: number;
  audio_rate_cap?: number;
  video_slow_cap?: number;
  gap_guard_s?: number;
  allow_video_retime?: boolean;
}

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

  /**
   * Optional Smart Fit knob overrides. Stays `null` unless a power user
   * sets custom caps — the backend then applies its own defaults.
   */
  fitOptions: FitOptions | null;

  /**
   * Last app version whose release notes the user has seen (feat/safe-updates).
   * `null` = never recorded (fresh install / pre-feature profile): the first
   * launch baselines it silently so brand-new users don't get a "What's new"
   * nudge for a version they just installed. After an update,
   * `whatsNewPending()` flags the mismatch and the footer shows a small
   * non-blocking "What's new" affordance until the notes are opened.
   */
  whatsNewSeenVersion: string | null;
  setWhatsNewSeenVersion: (v: string | null) => void;

  setTranslateQuality: (q: TranslateQuality) => void;
  setDualSubs: (on: boolean) => void;
  setBurnSubs: (on: boolean) => void;
  setGlossaryVisible: (on: boolean) => void;
  setReviewMode: (mode: 'on' | 'off') => void;
  setShowHeaderLiveStats: (on: boolean) => void;
  setTimingStrategy: (s: TimingStrategy) => void;
  setFitOptions: (o: FitOptions | null) => void;

  /**
   * Opt-in dictate-over-playback echo cancellation (parity Action 8). When
   * on, dictation streams raw PCM through the server-side NLMS AEC and the
   * audio player taps its output as the echo reference, so dictating while
   * OmniVoice plays audio doesn't transcribe the playback. Default OFF — the
   * standard MediaRecorder dictation path is unchanged when off.
   */
  aecEnabled: boolean;
  setAecEnabled: (on: boolean) => void;

  /**
   * Live-dictation prefs — MIRRORED from the backend `GET /dictation/prefs`
   * (the backend `prefs.json` `dictation.*` namespace is the source of truth).
   * On app init we hydrate these from the backend; every setter write-throughs
   * to `POST /dictation/prefs` so the capture engine and the UI never diverge.
   * They're intentionally NOT in `partialize` (store/index.ts) — the backend
   * owns them, so persisting a stale localStorage copy would fight the server.
   *
   *   • dictationEnabled  — master on/off for the dictation hotkey.
   *   • dictationMode     — 'toggle' (press to start, press to stop) | 'hold'
   *                          (record while the key is held).
   *   • dictationModelId  — the selected sherpa-onnx model id (e.g.
   *                          'sherpa-parakeet-tdt-v3'); drives `?model=` on the
   *                          live `/ws/transcribe` socket.
   */
  dictationEnabled: boolean;
  dictationMode: DictationMode;
  dictationModelId: string;
  /** Local-only flag: true once the backend prefs have been hydrated, so the
   * Voice panel can avoid flashing defaults before the first load. */
  dictationLoaded: boolean;
  /** Optimistic local set + write-through to POST /dictation/prefs. */
  setDictationEnabled: (on: boolean) => void;
  setDictationMode: (mode: DictationMode) => void;
  setDictationModelId: (id: string) => void;
  /** Hydrate from GET /dictation/prefs (called once on app init). */
  loadDictationPrefs: () => Promise<void>;

  /**
   * Auto-play the output preview as soon as a render finishes (Voice Clone /
   * Design / profile preview, AND the studio generate path in useTTS —
   * #1032 wired the latter; #666's toggle only covered the WaveformPlayer
   * sites). Default ON — preserves the long-standing behavior. Users
   * batch-generating segments (#666) can turn it off so each finished clip
   * doesn't start playing on its own.
   */
  autoPlayPreview: boolean;
  setAutoPlayPreview: (on: boolean) => void;

  locale: string;
  setLocale: (l: string) => void;

  theme: ThemeId;
  setTheme: (id: ThemeId) => void;

  font: FontId;
  setFont: (id: FontId) => void;
}

/** Map a `GET/POST /dictation/prefs` response → the store's dictation fields.
 * Tolerant of partial/garbage payloads so a malformed response can never wedge
 * the store. */
function _dictationFromPrefs(p: any): Partial<PrefsSlice> {
  const out: Partial<PrefsSlice> = {};
  if (p && typeof p === 'object') {
    if (typeof p.enabled === 'boolean') out.dictationEnabled = p.enabled;
    if (p.mode === 'toggle' || p.mode === 'hold') out.dictationMode = p.mode;
    if (typeof p.model_id === 'string' && p.model_id) out.dictationModelId = p.model_id;
  }
  return out;
}

export const createPrefsSlice: StateCreator<PrefsSlice, [], [], PrefsSlice> = (set, get) => ({
  translateQuality: 'fast',
  dualSubs: false,
  burnSubs: false,
  glossaryVisible: true,
  reviewMode: 'on',
  showHeaderLiveStats: false,
  timingStrategy: 'concise',
  fitOptions: null,
  whatsNewSeenVersion: null,
  aecEnabled: false,
  autoPlayPreview: true,

  // Seeds only — overwritten by loadDictationPrefs() on init. The backend
  // default is enabled:true / mode:'toggle' / model:Parakeet TDT v3.
  dictationEnabled: true,
  dictationMode: 'toggle',
  dictationModelId: DEFAULT_DICTATION_MODEL_ID,
  dictationLoaded: false,

  setTranslateQuality: (q) => set({ translateQuality: q }),
  setDualSubs: (on) => set({ dualSubs: on }),
  setBurnSubs: (on) => set({ burnSubs: on }),
  setGlossaryVisible: (on) => set({ glossaryVisible: on }),
  setReviewMode: (mode) => set({ reviewMode: mode }),
  setShowHeaderLiveStats: (on) => set({ showHeaderLiveStats: on }),
  setTimingStrategy: (s) => set({ timingStrategy: s }),
  setFitOptions: (o) => set({ fitOptions: o }),
  setWhatsNewSeenVersion: (v) => set({ whatsNewSeenVersion: v }),
  setAecEnabled: (on) => set({ aecEnabled: on }),
  setAutoPlayPreview: (on) => set({ autoPlayPreview: on }),

  // ── Dictation prefs (backend-backed) ──────────────────────────────────
  // Each setter is optimistic (update the store immediately so the UI is
  // snappy) then write-throughs to POST /dictation/prefs, which returns the
  // full authoritative prefs — we re-sync from that so a backend rejection
  // (400 on a bad value) or normalisation (repo_id → canonical id) can't leave
  // the UI out of step. A failed write rolls the optimistic value back.
  setDictationEnabled: (on) => {
    const prev = get().dictationEnabled;
    set({ dictationEnabled: on });
    apiPost('/dictation/prefs', { enabled: on })
      .then((p: any) => set(_dictationFromPrefs(p)))
      .catch(() => set({ dictationEnabled: prev }));
  },
  setDictationMode: (mode) => {
    const prev = get().dictationMode;
    set({ dictationMode: mode });
    apiPost('/dictation/prefs', { mode })
      .then((p: any) => set(_dictationFromPrefs(p)))
      .catch(() => set({ dictationMode: prev }));
  },
  setDictationModelId: (id) => {
    const prev = get().dictationModelId;
    set({ dictationModelId: id });
    apiPost('/dictation/prefs', { model_id: id })
      .then((p: any) => set(_dictationFromPrefs(p)))
      .catch(() => set({ dictationModelId: prev }));
  },
  loadDictationPrefs: async () => {
    try {
      const p = await apiJson<any>('/dictation/prefs');
      set({ ..._dictationFromPrefs(p), dictationLoaded: true });
    } catch {
      // Backend not ready / older build without the route — keep the seeds and
      // mark loaded so the panel renders defaults rather than a perpetual
      // spinner. A later manual interaction will retry the write-through.
      set({ dictationLoaded: true });
    }
  },

  locale:
    typeof navigator !== 'undefined'
      ? (() => {
          const nav = navigator.language || '';
          if (nav.toLowerCase().includes('tw') || nav.toLowerCase().includes('hk')) return 'zh-TW';
          const match = [
            'zh-CN',
            'es',
            'fr',
            'de',
            'ja',
            'pt',
            'it',
            'ru',
            'ko',
            'hi',
            'tr',
            'pl',
            'nl',
            'sv',
            'th',
            'vi',
            'id',
            'uk',
            'ar',
          ].find((code) => nav.startsWith(code.split('-')[0]));
          return match || 'en';
        })()
      : 'en',
  setLocale: (l) => set({ locale: l }),

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

  font: 'default',
  setFont: (id) => {
    set({ font: id });
    const stack = FONT_STACKS[id];
    if (stack) document.documentElement.style.setProperty('--font-sans', stack);
    else document.documentElement.style.removeProperty('--font-sans');
  },
});
