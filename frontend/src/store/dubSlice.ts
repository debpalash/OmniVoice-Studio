/**
 * Dub pipeline slice — Phase 2.2 (App.jsx monolith reduction).
 *
 * This was the largest cluster of `useState` calls in App.jsx — the state
 * that drives the whole dubbing workflow: job id, progress, segments,
 * language, translate/generate settings. Moving it into the store lets deep
 * children read pipeline state without 30+ props threaded through.
 *
 * Setters mirror React's signature — each accepts either a value or an
 * `(prev) => next` updater so existing call sites (`setDubSegments(prev =>
 * prev.map(...))`) work unchanged. The `functionalSet` helper keeps that
 * surface tiny.
 *
 * Not persisted: dub state is transient per session. Project load / dub
 * history restore explicitly rehydrates the relevant fields.
 */
import type { StateCreator } from 'zustand';

export type DubStep =
  | 'idle'
  | 'uploading'
  | 'transcribing'
  | 'editing'
  | 'generating'
  | 'stopping'
  | 'done';

export type DubPrepStage = 'download' | 'extract' | 'demucs' | 'scene' | null;

export interface DubProgress {
  current: number;
  total: number;
  text: string;
}

/** Segments are a loose shape — many optional fields added over time. */
export type DubSegment = Record<string, unknown> & { id: string; text: string };

type Updater<T> = T | ((prev: T) => T);

function resolve<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater;
}

export interface DubSlice {
  // ── Pipeline state ────────────────────────────────────────────────────
  dubJobId: string | null;
  dubStep: DubStep;
  dubTaskId: string | null;
  dubPrepStage: DubPrepStage;
  dubProgress: DubProgress;
  dubError: string;
  isTranslating: boolean;

  // ── Content ───────────────────────────────────────────────────────────
  dubSegments: DubSegment[];
  dubTranscript: string;
  dubFilename: string;
  dubDuration: number;
  dubTracks: string[];

  // ── Language / translate ──────────────────────────────────────────────
  dubLang: string;
  dubLangCode: string;

  // ── Generation options ────────────────────────────────────────────────
  dubInstruct: string;
  preserveBg: boolean;
  defaultTrack: string;
  exportTracks: Record<string, boolean>;

  // Segment ids most recently rendered at num_step=8 (preview quality).
  // The client re-renders these at full quality before final export.
  previewSegIds: string[];

  // Per-speaker auto-clones extracted from the source video's vocals. Keys
  // are speaker_id (e.g. "Speaker 1"), values are {ref_audio, ref_text,
  // duration, source_count}. Enables the cross-lingual "same voice in a
  // new language" dubbing flow.
  speakerClones: Record<string, {
    ref_audio: string;
    ref_text: string;
    duration: number;
    source_count: number;
  }>;

  // ── Setters (React-style; accept value or updater fn) ─────────────────
  setDubJobId: (v: Updater<string | null>) => void;
  setDubStep: (v: Updater<DubStep>) => void;
  setDubTaskId: (v: Updater<string | null>) => void;
  setDubPrepStage: (v: Updater<DubPrepStage>) => void;
  setDubProgress: (v: Updater<DubProgress>) => void;
  setDubError: (v: Updater<string>) => void;
  setIsTranslating: (v: Updater<boolean>) => void;
  setDubSegments: (v: Updater<DubSegment[]>) => void;
  setDubTranscript: (v: Updater<string>) => void;
  setDubFilename: (v: Updater<string>) => void;
  setDubDuration: (v: Updater<number>) => void;
  setDubTracks: (v: Updater<string[]>) => void;
  setDubLang: (v: Updater<string>) => void;
  setDubLangCode: (v: Updater<string>) => void;
  setDubInstruct: (v: Updater<string>) => void;
  setPreserveBg: (v: Updater<boolean>) => void;
  setDefaultTrack: (v: Updater<string>) => void;
  setExportTracks: (v: Updater<Record<string, boolean>>) => void;
  setPreviewSegIds: (v: Updater<string[]>) => void;
  setSpeakerClones: (v: Updater<DubSlice['speakerClones']>) => void;

  /** Reset every pipeline field back to idle defaults. */
  resetDubState: () => void;
}

const INITIAL: Omit<DubSlice,
  | 'setDubJobId' | 'setDubStep' | 'setDubTaskId' | 'setDubPrepStage'
  | 'setDubProgress' | 'setDubError' | 'setIsTranslating' | 'setDubSegments'
  | 'setDubTranscript' | 'setDubFilename' | 'setDubDuration' | 'setDubTracks'
  | 'setDubLang' | 'setDubLangCode' | 'setDubInstruct' | 'setPreserveBg'
  | 'setDefaultTrack' | 'setExportTracks' | 'setPreviewSegIds' | 'setSpeakerClones' | 'resetDubState'
> = {
  dubJobId: null,
  dubStep: 'idle',
  dubTaskId: null,
  dubPrepStage: null,
  dubProgress: { current: 0, total: 0, text: '' },
  dubError: '',
  isTranslating: false,
  dubSegments: [],
  dubTranscript: '',
  dubFilename: '',
  dubDuration: 0,
  dubTracks: [],
  dubLang: 'Auto',
  dubLangCode: 'en',
  dubInstruct: '',
  preserveBg: true,
  defaultTrack: 'original',
  exportTracks: { original: true },
  previewSegIds: [],
  speakerClones: {},
};

export const createDubSlice: StateCreator<DubSlice, [], [], DubSlice> = (set, get) => ({
  ...INITIAL,

  setDubJobId:     (v) => set((s) => ({ dubJobId:     resolve(v, s.dubJobId) })),
  setDubStep:      (v) => set((s) => ({ dubStep:      resolve(v, s.dubStep) })),
  setDubTaskId:    (v) => set((s) => ({ dubTaskId:    resolve(v, s.dubTaskId) })),
  setDubPrepStage: (v) => set((s) => ({ dubPrepStage: resolve(v, s.dubPrepStage) })),
  setDubProgress:  (v) => set((s) => ({ dubProgress:  resolve(v, s.dubProgress) })),
  setDubError:     (v) => set((s) => ({ dubError:     resolve(v, s.dubError) })),
  setIsTranslating:(v) => set((s) => ({ isTranslating:resolve(v, s.isTranslating) })),
  setDubSegments:  (v) => set((s) => ({ dubSegments:  resolve(v, s.dubSegments) })),
  setDubTranscript:(v) => set((s) => ({ dubTranscript:resolve(v, s.dubTranscript) })),
  setDubFilename:  (v) => set((s) => ({ dubFilename:  resolve(v, s.dubFilename) })),
  setDubDuration:  (v) => set((s) => ({ dubDuration:  resolve(v, s.dubDuration) })),
  setDubTracks:    (v) => set((s) => ({ dubTracks:    resolve(v, s.dubTracks) })),
  setDubLang:      (v) => set((s) => ({ dubLang:      resolve(v, s.dubLang) })),
  setDubLangCode:  (v) => set((s) => ({ dubLangCode:  resolve(v, s.dubLangCode) })),
  setDubInstruct:  (v) => set((s) => ({ dubInstruct:  resolve(v, s.dubInstruct) })),
  setPreserveBg:   (v) => set((s) => ({ preserveBg:   resolve(v, s.preserveBg) })),
  setDefaultTrack: (v) => set((s) => ({ defaultTrack: resolve(v, s.defaultTrack) })),
  setExportTracks: (v) => set((s) => ({ exportTracks: resolve(v, s.exportTracks) })),
  setPreviewSegIds:(v) => set((s) => ({ previewSegIds:resolve(v, s.previewSegIds) })),
  setSpeakerClones:(v) => set((s) => ({ speakerClones: resolve(v, s.speakerClones) })),

  resetDubState: () => {
    // Touch `get` so strict-mode double-invocation of the initializer doesn't
    // warn us about unused args — and future logging can read current state.
    void get;
    set(INITIAL);
  },
});
