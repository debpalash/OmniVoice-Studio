import React, { useState, useRef, useEffect, useCallback, Suspense, lazy } from 'react';
import './index.css';
import { useAppStore } from './store';
import SearchableSelect from './components/SearchableSelect';
import DirectionDialog from './components/DirectionDialog';

// Lazy-load heavy/conditional components so they don't bloat the initial bundle.
const AudioTrimmer = lazy(() => import('./components/AudioTrimmer'));
const Launchpad = lazy(() => import('./pages/Launchpad'));
const CloneDesignTab = lazy(() => import('./pages/CloneDesignTab'));
const DubTab = lazy(() => import('./pages/DubTab'));
const Sidebar = lazy(() => import('./components/Sidebar'));
const CompareModal = lazy(() => import('./components/CompareModal'));
const Settings = lazy(() => import('./pages/Settings'));
const VoiceProfile = lazy(() => import('./pages/VoiceProfile'));
const BatchQueue = lazy(() => import('./pages/BatchQueue'));
const ToolsPage = lazy(() => import('./pages/ToolsPage'));
const SetupWizard = lazy(() => import('./pages/SetupWizard'));
const KeyboardCheatsheet = lazy(() => import('./components/KeyboardCheatsheet'));
const VoicePreview = lazy(() => import('./components/VoicePreview'));
const LogsFooter = lazy(() => import('./components/LogsFooter'));
const ProjectsPage = lazy(() => import('./pages/Projects'));
const VoiceGallery = lazy(() => import('./pages/VoiceGallery'));
const DonatePage = lazy(() => import('./pages/DonatePage'));
const EnterprisePage = lazy(() => import('./pages/EnterprisePage'));
import Header from './components/Header';
import NavRail from './components/NavRail';
import ErrorBoundary from './components/ErrorBoundary';
import FloatingPill from './components/FloatingPill';
import useRealtimeEvents from './hooks/useRealtimeEvents';
import { BootstrapSplash, useBootstrapStage } from './components/BootstrapSplash';

import './components/Misc.css';

const LazyFallback = () => <div className="app-lazy-fallback">Loading…</div>;

import { Toaster, toast } from 'react-hot-toast';
import ALL_LANGUAGES from './languages.json';
import {
  POPULAR_LANGS, POPULAR_ISO, TAGS, CATEGORIES, PRESETS, CLONE_MAX_SECONDS,
} from './utils/constants';
import { LANG_CODES } from './utils/languages';
import { formatTime, probeAudioDuration } from './utils/format';
import { API, apiPost } from './api/client';
import { cleanAudio as apiCleanAudio, flushMemory as apiFlushMemory, modelStatus as apiModelStatus } from './api/system';
import { useSysinfo, useModelStatus } from './api/hooks';
import { listProfiles, createProfile, deleteProfile as apiDeleteProfile, lockProfile, unlockProfile } from './api/profiles';
import { listHistory, clearHistory, generateSpeech, audioUrlWithCacheBust } from './api/generate';
import { listProjects, saveProject as apiSaveProject, loadProject as apiLoadProject, deleteProject as apiDeleteProject } from './api/projects';
import {
  dubUpload, dubIngestUrl, dubAbort as apiDubAbort, dubCleanupSegments, dubTranslate, dubGenerate,
  tasksStreamUrl, tasksCancel, listDubHistory, clearDubHistory, transcribeStreamUrl,
} from './api/dub';
import { listExportHistory, exportAction, exportReveal, exportRecord } from './api/exports';
import {
  Sparkles, Fingerprint, Wand2, SlidersHorizontal, UserSquare2, ShieldCheck,
  Download as DownloadIcon, History, Command, Globe, Volume2, UploadCloud,
  Settings2, ChevronDown, ChevronUp, Play, Search, Film, Trash2,
  FileText, Loader, Check, AlertCircle, Plus, User, Save, Languages, Headphones,
  FolderOpen, FolderPlus, Pencil, Clock, Lock, Unlock, Mic, MicOff, Square,
  CheckCircle, Circle, ChevronRight, Target, PanelLeftClose, PanelLeftOpen, Scale,
  Layers, Music, Package, DownloadCloud, RefreshCw,
} from 'lucide-react';

// Tauri: pre-import window API to avoid async delays in event handlers
const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
let tauriWindow = null;
if (isTauri) {
  import('@tauri-apps/api/window').then(m => { tauriWindow = m; });
}
const doubleClickMaximize = () => {
  if (tauriWindow) tauriWindow.getCurrentWindow().toggleMaximize();
};

/**
 * Convert a File object to a media-safe URL.
 * In Tauri's WebKit, blob: URLs fail for <video>/<audio> elements.
 * We upload to the backend's /preview endpoint and serve via HTTP instead.
 * Falls back to createObjectURL for regular browsers.
 */
const _PREVIEW_API = import.meta.env.VITE_OMNIVOICE_API || 'http://localhost:3900';
const fileToMediaUrl = async (file, prevUrls) => {
  // Revoke previous blob URLs if they exist
  if (prevUrls?.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(prevUrls.videoUrl);
  if (prevUrls?.audioUrl?.startsWith('blob:')) URL.revokeObjectURL(prevUrls.audioUrl);
  
  if (isTauri) {
    try {
      const form = new FormData();
      form.append('video', file, file.name || 'media.wav');
      const res = await fetch(`${_PREVIEW_API}/preview/upload`, { method: 'POST', body: form });
      const data = await res.json();
      return {
        videoUrl: `${_PREVIEW_API}${data.url}`,
        audioUrl: data.audioUrl ? `${_PREVIEW_API}${data.audioUrl}` : `${_PREVIEW_API}${data.url}`
      };
    } catch (e) {
      console.warn('Preview upload failed, falling back to blob URL:', e);
    }
  }
  const url = URL.createObjectURL(file);
  return { videoUrl: url, audioUrl: url };
};

/**
 * Play audio from a Blob. Uses Web Audio API in Tauri (blob URLs blocked)
 * and standard Audio() elsewhere.
 */
const playBlobAudio = async (blob) => {
  if (isTauri) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // WebKit suspends AudioContext by default — must resume before decoding
    if (ctx.state === 'suspended') await ctx.resume();
    try {
      const buf = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(ctx.destination);
      src.start(0);
      src.onended = () => ctx.close();
    } catch (e) {
      console.error('playBlobAudio decode error:', e);
      ctx.close();
      // Fallback: try the standard Audio() path even in Tauri
      try {
        const url = URL.createObjectURL(blob);
        const a = new Audio(url);
        await a.play();
        a.onended = () => URL.revokeObjectURL(url);
      } catch (e2) {
        console.error('playBlobAudio fallback error:', e2);
      }
    }
  } else {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.play().catch((e) => console.error('playBlobAudio play error:', e));
    a.onended = () => URL.revokeObjectURL(url);
  }
};

let _pingCtx = null;
const playPing = () => {
  try {
    if (!_pingCtx) _pingCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _pingCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.08);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.03);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch (e) {}
};

function App() {
  // First-run bootstrap: Rust spawns uv sync in a background thread and
  // publishes progress via the `bootstrap_status` Tauri command. Hook below
  // polls every 1 s; until `ready`, we render BootstrapSplash instead of the
  // normal app shell, so the user sees real progress instead of a hung UI.
  const { stage: bootstrapStage, message: bootstrapMessage } = useBootstrapStage();

  // UI navigation state now lives in the Zustand `uiSlice` (Phase 2.2).
  // Mode + uiScale + sidebar-collapsed persist across reloads automatically
  // via the store's `partialize`; active project / voice ids stay transient.
  const uiScale = useAppStore(s => s.uiScale);
  const setUiScale = useAppStore(s => s.setUiScale);
  const mode = useAppStore(s => s.mode);
  const setMode = useAppStore(s => s.setMode);
  const [navRailSide, setNavRailSide] = useState(() => {
    try { return localStorage.getItem('omnivoice.navRailSide') || 'left'; } catch { return 'left'; }
  });
  const showCheatsheet = useAppStore(s => s.showCheatsheet);
  const setShowCheatsheet = useAppStore(s => s.setShowCheatsheet);

  // Global '?' → open cheatsheet
  useEffect(() => {
    const h = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShowCheatsheet(v => !v);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const flipNavRailSide = useCallback(() => {
    setNavRailSide(prev => {
      const next = prev === 'left' ? 'right' : 'left';
      try { localStorage.setItem('omnivoice.navRailSide', next); } catch {}
      return next;
    });
  }, []);
  // Voice-profile navigation — slice owns "remember where I was" for Back.
  const activeVoiceId = useAppStore(s => s.activeVoiceId);
  const openVoiceProfile = useAppStore(s => s.openVoiceProfile);
  const closeVoiceProfile = useAppStore(s => s.closeVoiceProfile);
  const hideSidebar = mode === 'launchpad' || mode === 'settings' || mode === 'voice' || mode === 'donate'
    || mode === 'queue' || mode === 'tools' || mode === 'projects' || mode === 'gallery' || mode === 'enterprise';
  const availableSidebarTabs = mode === 'dub'
    ? ['projects', 'history', 'downloads']
    : (mode === 'clone' || mode === 'design')
      ? ['projects', 'history']
      : [];
  // Generate-tab prefs now live in `generateSlice` (Phase 2.2). Persisted
  // knobs survive reloads via the store's `partialize`.
  const text              = useAppStore(s => s.text);
  const setText           = useAppStore(s => s.setText);
  const [refAudio, setRefAudio] = useState(null);
  const [pendingTrimFile, setPendingTrimFile] = useState(null);

  const ingestRefAudio = useCallback(async (file) => {
    if (!file) { setRefAudio(null); return; }
    const dur = await probeAudioDuration(file);
    if (dur && dur > CLONE_MAX_SECONDS) {
      setPendingTrimFile(file);
      setSelectedProfile(null);
      toast(`Audio is ${dur.toFixed(1)}s — trim to ≤${CLONE_MAX_SECONDS}s for best cloning`);
      return;
    }
    setRefAudio(file);
    setSelectedProfile(null);
  }, []);
  const refText         = useAppStore(s => s.refText);
  const setRefText      = useAppStore(s => s.setRefText);
  const instruct        = useAppStore(s => s.instruct);
  const setInstruct     = useAppStore(s => s.setInstruct);
  const language        = useAppStore(s => s.language);
  const setLanguage     = useAppStore(s => s.setLanguage);
  const [isGenerating, setIsGenerating] = useState(false);
  const [history, setHistory] = useState([]);
  const [exportHistory, setExportHistory] = useState([]);

  const speed           = useAppStore(s => s.speed);
  const setSpeed        = useAppStore(s => s.setSpeed);
  const steps           = useAppStore(s => s.steps);
  const setSteps        = useAppStore(s => s.setSteps);
  const cfg             = useAppStore(s => s.cfg);
  const setCfg          = useAppStore(s => s.setCfg);
  const [showOverrides, setShowOverrides] = useState(false);
  const denoise         = useAppStore(s => s.denoise);
  const setDenoise      = useAppStore(s => s.setDenoise);
  const tShift          = useAppStore(s => s.tShift);
  const setTShift       = useAppStore(s => s.setTShift);
  const posTemp         = useAppStore(s => s.posTemp);
  const setPosTemp      = useAppStore(s => s.setPosTemp);
  const classTemp       = useAppStore(s => s.classTemp);
  const setClassTemp    = useAppStore(s => s.setClassTemp);
  const layerPenalty    = useAppStore(s => s.layerPenalty);
  const setLayerPenalty = useAppStore(s => s.setLayerPenalty);
  const postprocess     = useAppStore(s => s.postprocess);
  const setPostprocess  = useAppStore(s => s.setPostprocess);
  const duration        = useAppStore(s => s.duration);
  const setDuration     = useAppStore(s => s.setDuration);

  const vdStates        = useAppStore(s => s.vdStates);
  const setVdStates     = useAppStore(s => s.setVdStates);

  const [generationTime, setGenerationTime] = useState(0);
  const timerRef = useRef(null);
  const textAreaRef = useRef(null);

  // ═══ VOICE PROFILES ═══
  const [profiles, setProfiles] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [showSaveProfile, setShowSaveProfile] = useState(false);
  const [profileName, setProfileName] = useState('');

  // A/B Voice Comparison State
  const [isCompareModalOpen, setIsCompareModalOpen] = useState(false);
  const [compareVoiceA, setCompareVoiceA] = useState("");
  const [compareVoiceB, setCompareVoiceB] = useState("");
  const [compareText, setCompareText] = useState("The quick brown fox jumps over the lazy dog, proving that this voice sounds much better.");
  const [compareResultA, setCompareResultA] = useState(null);
  const [compareResultB, setCompareResultB] = useState(null);
  const [isComparing, setIsComparing] = useState(false);
  const [compareProgress, setCompareProgress] = useState("");
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(null);
  const [segmentPreviewLoading, setSegmentPreviewLoading] = useState(null);

  // Voice Preview floating card
  const [isVoicePreviewOpen, setIsVoicePreviewOpen] = useState(false);
  const [voicePreviewProfileId, setVoicePreviewProfileId] = useState('');

  // ═══ MIC RECORDING ═══
  const [isRecording, setIsRecording] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);

  // ═══ DUB STATE ═══
  // Phase 2.2 — the dub pipeline's 18 useState calls now live in `dubSlice`.
  // Setters keep React-style signatures (value | updater fn) so every
  // existing call site works unchanged. Local state kept only for:
  //   - File / Blob objects (non-serialisable)
  //   - Truly transient UI (showTranscript, previewAudios, timers)
  //   - Listings loaded from the backend (dubHistory, studioProjects)
  const dubJobId           = useAppStore(s => s.dubJobId);
  const setDubJobId        = useAppStore(s => s.setDubJobId);
  const dubStep            = useAppStore(s => s.dubStep);
  const setDubStep         = useAppStore(s => s.setDubStep);
  const dubSegments        = useAppStore(s => s.dubSegments);
  const setDubSegments     = useAppStore(s => s.setDubSegments);
  const dubLang            = useAppStore(s => s.dubLang);
  const setDubLang         = useAppStore(s => s.setDubLang);
  const dubLangCode        = useAppStore(s => s.dubLangCode);
  const setDubLangCode     = useAppStore(s => s.setDubLangCode);
  const dubInstruct        = useAppStore(s => s.dubInstruct);
  const setDubInstruct     = useAppStore(s => s.setDubInstruct);
  const dubProgress        = useAppStore(s => s.dubProgress);
  const setDubProgress     = useAppStore(s => s.setDubProgress);
  const dubFilename        = useAppStore(s => s.dubFilename);
  const setDubFilename     = useAppStore(s => s.setDubFilename);
  const dubDuration        = useAppStore(s => s.dubDuration);
  const setDubDuration     = useAppStore(s => s.setDubDuration);
  const dubError           = useAppStore(s => s.dubError);
  const setDubError        = useAppStore(s => s.setDubError);
  const dubTracks          = useAppStore(s => s.dubTracks);
  const setDubTracks       = useAppStore(s => s.setDubTracks);
  const dubTranscript      = useAppStore(s => s.dubTranscript);
  const setDubTranscript   = useAppStore(s => s.setDubTranscript);
  const isTranslating      = useAppStore(s => s.isTranslating);
  const setIsTranslating   = useAppStore(s => s.setIsTranslating);
  const preserveBg         = useAppStore(s => s.preserveBg);
  const setPreserveBg      = useAppStore(s => s.setPreserveBg);
  const defaultTrack       = useAppStore(s => s.defaultTrack);
  const setDefaultTrack    = useAppStore(s => s.setDefaultTrack);
  const exportTracks       = useAppStore(s => s.exportTracks);
  const setExportTracks    = useAppStore(s => s.setExportTracks);
  const previewSegIds      = useAppStore(s => s.previewSegIds);
  const setPreviewSegIds   = useAppStore(s => s.setPreviewSegIds);
  const speakerClones      = useAppStore(s => s.speakerClones);
  const setSpeakerClones   = useAppStore(s => s.setSpeakerClones);
  const dubTaskId          = useAppStore(s => s.dubTaskId);
  const setDubTaskId       = useAppStore(s => s.setDubTaskId);
  const dubPrepStage       = useAppStore(s => s.dubPrepStage);
  const setDubPrepStage    = useAppStore(s => s.setDubPrepStage);

  const translateQuality = useAppStore(s => s.translateQuality);
  const setTranslateQuality = useAppStore(s => s.setTranslateQuality);
  const glossaryTerms = useAppStore(s => s.glossaryTerms);
  const setGlossaryTerms = useAppStore(s => s.setGlossaryTerms);
  const dualSubs = useAppStore(s => s.dualSubs);
  const burnSubs = useAppStore(s => s.burnSubs);
  const setDualSubs = useAppStore(s => s.setDualSubs);

  const [translateProvider, setTranslateProvider] = useState('argos');
  const [dubVideoFile, setDubVideoFile] = useState(null);
  const [dubLocalBlobUrl, setDubLocalBlobUrl] = useState(null);
  const dubBlobUrlRef = useRef(null);
  useEffect(() => { dubBlobUrlRef.current = dubLocalBlobUrl; }, [dubLocalBlobUrl]);
  useEffect(() => () => {
    // Release any outstanding blob URLs on unmount to avoid leaks.
    const urls = dubBlobUrlRef.current;
    if (urls?.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(urls.videoUrl);
    if (urls?.audioUrl?.startsWith('blob:') && urls.audioUrl !== urls.videoUrl) URL.revokeObjectURL(urls.audioUrl);
  }, []);
  const [showTranscript, setShowTranscript] = useState(false);
  const [previewAudios, setPreviewAudios] = useState({});
  const [dubHistory, setDubHistory] = useState([]);
  const [transcribeStart, setTranscribeStart] = useState(null);
  const [transcribeElapsed, setTranscribeElapsed] = useState(0);

  // ═══ STUDIO PROJECTS ═══
  const [studioProjects, setStudioProjects] = useState([]);
  const activeProjectId = useAppStore(s => s.activeProjectId);
  const activeProjectName = useAppStore(s => s.activeProjectName);
  const setActiveProject = useAppStore(s => s.setActiveProject);
  const sidebarTab    = useAppStore(s => s.sidebarTab);
  const setSidebarTab = useAppStore(s => s.setSidebarTab);

  // Snap sidebar to a valid tab when view changes
  useEffect(() => {
    if (availableSidebarTabs.length && !availableSidebarTabs.includes(sidebarTab)) {
      setSidebarTab(availableSidebarTabs[0]);
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const isSidebarProjectsCollapsed    = useAppStore(s => s.isSidebarProjectsCollapsed);
  const setIsSidebarProjectsCollapsed = useAppStore(s => s.setIsSidebarProjectsCollapsed);
  const isSidebarCollapsed = useAppStore(s => s.isSidebarCollapsed);
  const setIsSidebarCollapsed = useAppStore(s => s.setIsSidebarCollapsed);

  // ── UNDO / REDO ──
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

  // Phase 4.2 — direction editor per segment. Dialog state lives in App so
  // opening one dialog closes any other, and Undo includes direction changes.
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

  // Phase 4.1 — after each successful dub generate, stash the segment
  // fingerprints. "What changed since last generate?" reads against this map.
  const [lastGenFingerprints, setLastGenFingerprints] = useState({});
  const [incrementalPlan, setIncrementalPlan] = useState(null);  // {stale:[], fresh:[]}

  const recomputeIncremental = useCallback(async () => {
    if (!dubSegments.length || !Object.keys(lastGenFingerprints).length) {
      setIncrementalPlan(null);
      return;
    }
    try {
      const res = await apiPost('/tools/incremental', {
        segments: dubSegments.map(s => ({
          id: String(s.id), text: s.text, target_lang: s.target_lang,
          profile_id: s.profile_id, instruct: s.instruct,
          speed: s.speed, direction: s.direction,
        })),
        stored_hashes: lastGenFingerprints,
      });
      setIncrementalPlan({ stale: res.stale, fresh: res.fresh });
    } catch (e) {
      console.warn('incremental plan failed', e);
    }
  }, [dubSegments, lastGenFingerprints]);

  useEffect(() => { recomputeIncremental(); }, [recomputeIncremental]);

  const segmentDelete = useCallback((id) => {
    pushUndo(dubSegments);
    setDubSegments(prev => prev.filter(s => s.id !== id));
  }, [dubSegments]);

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

  const bulkDeleteSelected = useCallback(() => {
    if (!selectedSegIds.size) return;
    if (!confirm(`Delete ${selectedSegIds.size} selected segment${selectedSegIds.size === 1 ? '' : 's'}?`)) return;
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

  // ── MODEL STATUS + SYSINFO (TanStack Query) ──
  const sysQuery = useSysinfo();
  const msQuery  = useModelStatus();
  const sysStats    = sysQuery.data ?? null;
  const modelStatus = msQuery.data?.status ?? 'idle';

  // First-run gate — `/setup/status` reports whether required HF models are
  // on disk. If not, we render <SetupWizard> in place of the main studio so
  // the user actually SEES the download instead of a silent 5 GB hang.
  //
  // Packaged .app note: the frozen backend sidecar takes several seconds to
  // import torch/torchaudio/whisper/etc. before it can serve /setup/status.
  // A single fetch on mount lands during that window, fails, and the wizard
  // would never render. So we retry with backoff until we get a response or
  // the user gives up. `setupChecked` gates main-UI render so we don't flash
  // the studio in front of a user who actually needs the wizard.
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [setupChecked, setSetupChecked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { setupStatus } = await import('./api/setup');
      // ~30 attempts × ~1s ≈ 30s ceiling; enough for a cold sidecar on slow disks.
      for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
        try {
          const s = await setupStatus();
          if (cancelled) return;
          setSetupNeeded(!s.models_ready);
          setSetupChecked(true);
          return;
        } catch {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!cancelled) setSetupChecked(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Tauri auto-updater ──
  // On boot, ask GitHub Releases if a newer build is available. If yes,
  // prompt the user, download the signed bundle, restart into the new
  // version. Only runs in packaged .app (not `tauri dev`) — the updater
  // endpoint 404s until the first signed release is published, and we
  // don't want that noise in the dev console.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('__TAURI_INTERNALS__' in window)) return;
    if (import.meta.env.DEV) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ check }, { relaunch }, { ask }] = await Promise.all([
          import('@tauri-apps/plugin-updater'),
          import('@tauri-apps/plugin-process'),
          import('@tauri-apps/plugin-dialog'),
        ]);
        const update = await check();
        if (cancelled || !update) return;
        const proceed = await ask(
          `A new version (${update.version}) of OmniVoice Studio is available.\n\nWhat's new:\n${update.body || '— see release notes'}\n\nDownload and install now?`,
          { title: 'Update available', kind: 'info' },
        );
        if (!proceed) return;
        await update.downloadAndInstall();
        await relaunch();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.debug('Updater check failed (non-fatal):', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── DESKTOP NATIVE INTEGRATION ──
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // 1. Prevent default right-click to hide web nature
    const handleContextMenu = (e) => {
      // allow on inputs/textareas for copy/paste
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      e.preventDefault();
    };
    
    // 2. Prevent keyboard quicks (reload, zoom, print)
    const handleKeyDown = (e) => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (['r', 'p', '=', '-', '+'].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
    };
    
    // 3. Prevent pinch-to-zoom
    const handleWheel = (e) => {
      if (e.ctrlKey) e.preventDefault();
    };
    
    // 4. Global Drag and drop for seamless native feeling
    const handleDrop = (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      
      const isVideo = file.name.match(/\.(mp4|mov|mkv|webm|avi)$/i);
      const isAudio = file.name.match(/\.(mp3|wav|flac|m4a|ogg)$/i);
      if (isVideo || isAudio) {
        setMode('dub');
        setDubVideoFile(file);
        fileToMediaUrl(file, null).then(urls => setDubLocalBlobUrl(urls));
        setDubFilename(file.name);
        setDubStep('idle');
      }
    };
    const handleDragOver = (e) => e.preventDefault();

    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('drop', handleDrop);
    window.addEventListener('dragover', handleDragOver);
    
    return () => {
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('drop', handleDrop);
      window.removeEventListener('dragover', handleDragOver);
    };
  }, []);

  // sysinfo + modelStatus polling is now handled by TanStack Query hooks
  // (useSysinfo / useModelStatus at top of component). No manual setInterval.

  // ── Floating pill for model loading (ASR cold start can take ~120s) ──
  const prevModelStatusRef = useRef(modelStatus);
  useEffect(() => {
    const prev = prevModelStatusRef.current;
    prevModelStatusRef.current = modelStatus;
    const pill = useAppStore.getState();
    // Only show pill if model transitions to loading and pill isn't already
    // showing something more important (e.g. active dubbing).
    if (modelStatus === 'loading' && prev !== 'loading' && pill.stage === 'idle') {
      pill.showPill('loading-model', 'Loading ASR model…');
    }
    if (modelStatus === 'ready' && prev === 'loading') {
      // Only dismiss if the pill is still showing the model-loading state
      if (pill.stage === 'loading-model' && pill.label.includes('ASR')) {
        pill.completePill('ASR model ready');
      }
    }
  }, [modelStatus]);

  const loadProfiles = useCallback(async () => {
    try { setProfiles(await listProfiles()); } catch (e) {}
  }, []);

  const loadHistory = useCallback(async () => {
    try { setHistory(await listHistory()); } catch (e) {}
  }, []);

  const loadDubHistory = useCallback(async () => {
    try { setDubHistory(await listDubHistory()); } catch (e) {}
  }, []);

  const loadProjects = useCallback(async () => {
    try { setStudioProjects(await listProjects()); } catch (e) {}
  }, []);

  const loadExportHistory = useCallback(async () => {
    try { setExportHistory(await listExportHistory()); } catch (e) {}
  }, []);

  // ── Real-time sidebar updates via WebSocket ────────────────────────────
  // Replaces polling — the backend pushes an event on every DB mutation and
  // we simply re-fetch the affected list. Reconnects automatically.
  useRealtimeEvents({
    projects:           () => loadProjects(),
    profiles:           () => loadProfiles(),
    dub_history:        () => loadDubHistory(),
    export_history:     () => loadExportHistory(),
    generation_history: () => loadHistory(),
  });

  useEffect(() => {
    // Wait for backend to come alive before loading data (handles Tauri startup race)
    let cancelled = false;
    const loadAll = async () => {
      // Retry until backend responds (exponential backoff: 1s, 2s, 4s max)
      let delay = 1000;
      while (!cancelled) {
        try {
          await apiModelStatus();
          break; // backend is alive
        } catch (e) { /* not ready yet */ }
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 4000);
      }
      if (cancelled) return;
      loadProfiles();
      loadHistory();
      loadDubHistory();
      loadProjects();
      loadExportHistory();
    };
    loadAll();
    // Restore local UI state
    try {
      const saved = JSON.parse(localStorage.getItem('omni_ui') || '{}');
      if (saved.uiScale) setUiScale(saved.uiScale);
      if (saved.text) setText(saved.text);
      if (saved.mode) setMode(saved.mode);
      if (saved.vdStates) setVdStates(saved.vdStates);
      if (saved.language) setLanguage(saved.language);
      if (saved.isSidebarCollapsed !== undefined) setIsSidebarCollapsed(saved.isSidebarCollapsed);
      if (saved.sidebarTab) setSidebarTab(saved.sidebarTab);
      // Dub state
      if (saved.dubJobId) setDubJobId(saved.dubJobId);
      if (saved.dubFilename) setDubFilename(saved.dubFilename);
      if (saved.dubDuration !== undefined) setDubDuration(saved.dubDuration);
      if (saved.dubSegments) setDubSegments(saved.dubSegments.map(s => ({ ...s, text_original: s.text_original || s.text || '' })));
      if (saved.dubLang) setDubLang(saved.dubLang);
      if (saved.dubLangCode) setDubLangCode(saved.dubLangCode);
      if (saved.dubTracks) setDubTracks(saved.dubTracks);
      if (saved.dubStep) setDubStep(saved.dubStep);
      if (saved.dubTranscript) setDubTranscript(saved.dubTranscript);
      // Extra UI State
      if (saved.exportTracks) setExportTracks(saved.exportTracks);
      if (saved.preserveBg !== undefined) setPreserveBg(saved.preserveBg);
      if (saved.defaultTrack) setDefaultTrack(saved.defaultTrack);
      if (saved.exportHistory) setExportHistory(saved.exportHistory);
      // Inference Parameters
      if (saved.speed) setSpeed(saved.speed);
      if (saved.steps) setSteps(saved.steps);
      if (saved.cfg) setCfg(saved.cfg);
      if (saved.denoise !== undefined) setDenoise(saved.denoise);
      if (saved.showOverrides !== undefined) setShowOverrides(saved.showOverrides);
    } catch (e) {}
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    localStorage.setItem('omni_ui', JSON.stringify({
      uiScale, text, mode, vdStates, language,
      isSidebarCollapsed, sidebarTab,
      dubJobId, dubFilename, dubDuration, dubSegments, 
      dubLang, dubLangCode, dubTracks, dubStep, dubTranscript,
      exportTracks, preserveBg, defaultTrack, exportHistory,
      speed, steps, cfg, denoise, showOverrides
    }));
  }, [
    uiScale, text, mode, vdStates, language, isSidebarCollapsed, sidebarTab, 
    dubJobId, dubFilename, dubDuration, dubSegments, dubLang, dubLangCode, 
    dubTracks, dubStep, dubTranscript, exportTracks, preserveBg, defaultTrack, 
    exportHistory, speed, steps, cfg, denoise, showOverrides
  ]);

  // ── KEYBOARD SHORTCUTS ──
  useEffect(() => {
    const handler = (e) => {
      // ⌘+Enter or Ctrl+Enter → Generate
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (mode === 'dub') {
          if (dubStep === 'editing' && dubSegments.length > 0) handleDubGenerate();
        } else {
          if (!isGenerating) handleGenerate();
        }
        return;
      }
      // ⌘+S or Ctrl+S → Save project
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (mode === 'dub') saveProject();
        return;
      }
      // ⌘+Z → Undo
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      // ⌘+Shift+Z → Redo
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // ── TTS ──
  const insertTag = (tag) => {
    if (!textAreaRef.current) return;
    const start = textAreaRef.current.selectionStart;
    const end = textAreaRef.current.selectionEnd;
    setText(text.substring(0, start) + tag + text.substring(end));
    setTimeout(() => { textAreaRef.current.focus(); textAreaRef.current.setSelectionRange(start + tag.length, start + tag.length); }, 0);
  };

  const applyPreset = (preset) => {
    setVdStates(preset.attrs);
    if (preset.tags && !text.includes(preset.tags.trim())) insertTag(preset.tags);
  };

  const handleGenerate = async () => {
    if (!text.trim()) return toast.error("Please enter text");
    if (mode === 'clone' && !refAudio && !selectedProfile) return toast.error("Upload an audio or select a voice profile");
    setIsGenerating(true);
    setGenerationTime(0);
    const st = Date.now();
    timerRef.current = setInterval(() => setGenerationTime(((Date.now() - st) / 1000).toFixed(1)), 100);
    try {
      const formData = new FormData();
      formData.append("text", text);
      if (language !== 'Auto') formData.append("language", language);
      formData.append("num_step", steps);
      formData.append("guidance_scale", cfg);
      formData.append("speed", speed);
      formData.append("denoise", denoise);
      formData.append("t_shift", tShift);
      formData.append("position_temperature", posTemp);
      formData.append("class_temperature", classTemp);
      formData.append("layer_penalty_factor", layerPenalty);
      formData.append("postprocess_output", postprocess);
      if (duration) formData.append("duration", parseFloat(duration));

      if (mode === 'clone') {
        if (selectedProfile) {
          formData.append("profile_id", selectedProfile);
        } else if (refAudio) {
          formData.append("ref_audio", refAudio);
          formData.append("ref_text", refText);
        }
        if (instruct) formData.append("instruct", instruct);
      } else {
        // Design mode: generate a random seed for reproducibility
        const designSeed = Math.floor(Math.random() * 2147483647);
        formData.append("seed", designSeed);
        const parts = Object.values(vdStates).filter(v => v !== 'Auto');
        if (instruct.trim()) parts.push(instruct.trim());
        const finalInstruct = parts.join(', ');
        if (finalInstruct) formData.append("instruct", finalInstruct);
        // If a design profile is selected, pass it so backend can use its locked audio
        if (selectedProfile) {
          formData.append("profile_id", selectedProfile);
        }
      }

      const response = await generateSpeech(formData);

      // Streaming TTS: read audio bytes as they arrive
      const reader = response.body.getReader();
      const chunks = [];
      let receivedLength = 0;
      const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        
        // Update generation time to show streaming progress
        if (contentLength > 0) {
          const pct = Math.round((receivedLength / contentLength) * 100);
          setGenerationTime(prev => `${prev.toString().split(' ')[0]} (${pct}%)`);
        }
      }
      
      // Construct final blob and auto-play
      const blob = new Blob(chunks, { type: 'audio/wav' });
      
      // Auto-play the streamed result immediately
      try {
        await playBlobAudio(blob);
      } catch (e) {}

      // Refresh history from server and explicitly switch to history tab automatically so user can see it
      await loadHistory();
      setSidebarTab('history');
      playPing();
    } catch (err) {
      toast.error("Error: " + err.message);
    } finally {
      clearInterval(timerRef.current);
      setIsGenerating(false);
    }
  };

  // ── PROFILES ──
  const handleSaveProfile = async () => {
    if (!profileName.trim() || !refAudio) return toast.error("Need a name and reference audio");
    const formData = new FormData();
    formData.append("name", profileName);
    formData.append("ref_audio", refAudio);
    formData.append("ref_text", refText);
    formData.append("instruct", instruct);
    formData.append("language", language);
    try {
      await createProfile(formData);
      setShowSaveProfile(false);
      setProfileName('');
      await loadProfiles();
    } catch (e) { toast.error(e.message); }
  };

  const handleDeleteProfile = async (id) => {
    if (!confirm('Delete this voice profile?')) return;
    await apiDeleteProfile(id);
    if (selectedProfile === id) setSelectedProfile(null);
    await loadProfiles();
  };

  const handleSelectProfile = (profile) => {
    setSelectedProfile(profile.id);
    setRefText(profile.ref_text || '');
    setInstruct(profile.instruct || '');
    if (profile.language && profile.language !== 'Auto') setLanguage(profile.language);
  };

  const handlePreviewVoice = async (proj, e) => {
    e.stopPropagation();
    if (previewLoading) return;
    
    let previewText = "This is a voice preview.";
    let reqLang = language;
    
    // Auto-select text context based on current mode
    if (mode === 'dub' && dubSegments.length > 0) {
      // Find a segment assigned to this profile, or just the first segment with text
      let seg = dubSegments.find(s => s.profile_id === proj.id && s.text.trim().length > 0);
      if (!seg) seg = dubSegments.find(s => s.text.trim().length > 0);
      if (seg) previewText = seg.text;
      
      reqLang = dubLang;
    } else if (text.trim() !== '') {
      previewText = text;
    }

    setPreviewLoading(proj.id);
    const toastId = toast.loading(`Synthesizing preview for ${proj.name}...`);
    
    try {
      const formData = new FormData();
      formData.append("text", previewText);
      formData.append("profile_id", proj.id);
      
      if (reqLang && reqLang !== 'Auto') {
        formData.append("language", reqLang);
      }
      
      formData.append("num_step", steps || 16);
      const res = await generateSpeech(formData);
      const blob = await res.blob();

      toast.success('Preview ready!', { id: toastId });
      
      playBlobAudio(blob).catch(() => toast.error('Playback failed', { id: toastId }));
      
      await loadHistory();
    } catch (err) {
      toast.error('Preview failed: ' + err.message, { id: toastId });
    } finally {
      setPreviewLoading(null);
    }
  };

  const handleSegmentPreview = async (seg, e) => {
    e.preventDefault();
    if (segmentPreviewLoading) return;
    setSegmentPreviewLoading(seg.id);
    const toastId = toast.loading(`Synthesizing segment...`);
    
    try {
      const formData = new FormData();
      formData.append("text", seg.text);
      
      let fin_prof = seg.profile_id || '';
      let fin_inst = seg.instruct || '';
      
      if (fin_prof.startsWith('preset:')) {
        const pr = PRESETS.find(p => p.id === fin_prof.replace('preset:', ''));
        if (pr) {
          const parts = Object.values(pr.attrs).filter(v => v !== 'Auto');
          if (fin_inst.trim()) parts.push(fin_inst.trim());
          fin_inst = parts.join(', ');
        }
        fin_prof = '';
      }
      
      if (fin_prof) formData.append("profile_id", fin_prof);
      if (fin_inst) formData.append("instruct", fin_inst);
      const fin_lang = seg.target_lang || dubLang;
      if (fin_lang !== 'Auto') formData.append("language", fin_lang);
      
      // Hardcode lightweight inference steps for live preview to drastically boost timeline responsiveness
      formData.append("num_step", 8);
      formData.append("guidance_scale", cfg || 2.0);
      if (seg.speed && seg.speed !== 1.0) formData.append("speed", seg.speed);
      
      const res = await generateSpeech(formData);
      const blob = await res.blob();
      toast.success('Preview ready!', { id: toastId });
      
      playBlobAudio(blob).catch(() => toast.error('Playback failed', { id: toastId }));
    } catch (err) {
      toast.error('Preview failed: ' + err.message, { id: toastId });
    } finally {
      setSegmentPreviewLoading(null);
    }
  };

  const handleSaveHistoryAsProfile = async (item) => {
    try {
      const pName = `Voice ${new Date().toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'})} — ${(item.mode||'design').toUpperCase()}`;
      
      const response = await fetch(audioUrlWithCacheBust(item.audio_path));
      if (!response.ok) throw new Error("Audio not found");
      const blob = await response.blob();
      const file = new File([blob], item.audio_path, { type: "audio/wav" });

      const formData = new FormData();
      formData.append("name", pName);
      formData.append("ref_audio", file);
      const extractedText = item.text ? (item.text.length > 50 ? item.text.substring(0, 50) : item.text) : "";
      formData.append("ref_text", extractedText);
      formData.append("instruct", item.instruct || "");
      formData.append("language", item.language || "Auto");
      if (item.seed !== undefined && item.seed !== null) {
        formData.append("seed", item.seed);
      }

      await createProfile(formData);
      toast.success("Voice saved to profiles!");
      await loadProfiles();
    } catch (e) {
      toast.error(e.message || "Failed to save voice profile");
    }
  };

  const handleLockProfile = async (profileId, historyId, seed) => {
    try {
      const formData = new FormData();
      formData.append("history_id", historyId);
      if (seed !== null && seed !== undefined) formData.append("seed", seed);
      await lockProfile(profileId, formData);
      toast.success("🔒 Voice locked! Identity is now consistent across all generations.");
      await loadProfiles();
    } catch (e) {
      toast.error(e.message || "Failed to lock profile");
    }
  };

  const handleUnlockProfile = async (profileId) => {
    try {
      await unlockProfile(profileId);
      toast.success("🎨 Voice unlocked. Generations will vary again.");
      await loadProfiles();
    } catch (e) {
      toast.error(e.message || "Failed to unlock profile");
    }
  };

  // ═══ MIC RECORDING ═══
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = mediaRecorder;
      recordingChunksRef.current = [];
      setRecordingTime(0);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        clearInterval(recordingTimerRef.current);
        stream.getTracks().forEach(t => t.stop());

        const blob = new Blob(recordingChunksRef.current, { type: 'audio/webm' });
        if (blob.size < 1000) {
          toast.error("Recording too short");
          return;
        }

        // Send to backend for denoising
        setIsCleaning(true);
        try {
          const formData = new FormData();
          formData.append("audio", blob, "recording.webm");
          const res = await apiCleanAudio(formData);

          const cleanBlob = await res.blob();
          const cleanFilename = res.headers.get("X-Clean-Filename") || "recording_clean.wav";
          const cleanFile = new File([cleanBlob], cleanFilename, { type: "audio/wav" });

          await ingestRefAudio(cleanFile);
          toast.success("🎙️ Recording cleaned & loaded!");
        } catch (e) {
          // Fallback: use raw recording without denoising
          const rawFile = new File([blob], "recording.webm", { type: "audio/webm" });
          await ingestRefAudio(rawFile);
          toast.success("Recording loaded (raw — denoising unavailable)");
        } finally {
          setIsCleaning(false);
        }
      };

      mediaRecorder.start(250); // Collect chunks every 250ms
      setIsRecording(true);

      // Timer
      const st = Date.now();
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(((Date.now() - st) / 1000).toFixed(1));
      }, 100);

    } catch (e) {
      toast.error("Microphone access denied");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  // ═══ DUB WORKFLOW ═══
  const dubAbortCtrlRef = useRef(null);
  const dubClientJobIdRef = useRef(null);

  // Shared: once backend has a processed job, wait on SSE transcribe stream.
  const _waitForTranscribe = (jobId, ctrl) => new Promise((resolve, reject) => {
    const evt = new EventSource(transcribeStreamUrl(jobId));
    let gotFinal = false;

    const close = () => { try { evt.close(); } catch {} };
    const onAbortSignal = () => { close(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    ctrl.signal.addEventListener('abort', onAbortSignal, { once: true });

    evt.addEventListener('start', () => {});
    evt.addEventListener('segments', (e) => {
      try {
        const m = JSON.parse(e.data);
        const incoming = (m.segments || []).map((s, i) => ({
          ...s,
          id: s.id != null ? String(s.id) : `c${m.chunk}-${i}`,
          text_original: s.text_original || s.text || '',
        }));
        setDubSegments(prev => [...prev, ...incoming]);
      } catch (err) { /* ignore parse errors */ }
    });
    evt.addEventListener('final', (e) => {
      try {
        const m = JSON.parse(e.data);
        gotFinal = true;
        setDubSegments((m.segments || []).map((s, i) => ({
          ...s,
          id: s.id != null ? String(s.id) : String(i),
          text_original: s.text_original || s.text || '',
        })));
        setDubTranscript(m.full_transcript || '');
        // Auto-clones extracted per speaker — powers the "Speaker 1 · from
        // video" dropdown option and the cross-lingual "same voice in a new
        // language" behaviour.
        if (m.speaker_clones && typeof m.speaker_clones === 'object') {
          setSpeakerClones(m.speaker_clones);
        }
      } catch {}
    });
    evt.addEventListener('done', () => {
      close();
      ctrl.signal.removeEventListener('abort', onAbortSignal);
      resolve();
    });
    evt.addEventListener('aborted', () => {
      close();
      ctrl.signal.removeEventListener('abort', onAbortSignal);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    evt.addEventListener('error', (e) => {
      try {
        const m = e.data ? JSON.parse(e.data) : null;
        if (m && m.detail) { close(); reject(new Error(m.detail)); return; }
      } catch {}
      if (gotFinal) { close(); resolve(); return; }
      // EventSource auto-reconnects on transport errors; force-close so we
      // don't loop against a broken endpoint, and surface a pointed message.
      close();
      reject(new Error(
        'Transcribe stream dropped before emitting any segments. ' +
        'Likely ASR backend failed to load — check backend log + Settings → Models.'
      ));
    });
  });

  // Shared: listen to task_manager SSE and resolve when 'ready' event lands.
  // Updates dubPrepStage + dubJobId + dubDuration + dubFilename as stages advance.
  const _waitForPrep = (taskId, ctrl) => new Promise((resolve, reject) => {
    const evt = new EventSource(tasksStreamUrl(taskId));
    const close = () => { try { evt.close(); } catch {} };
    const onAbort = () => { close(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    ctrl.signal.addEventListener('abort', onAbort, { once: true });

    let lastData = null;
    evt.onmessage = (e) => {
      if (!e.data) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      lastData = m;
      switch (m.type) {
        case 'download_start': setDubPrepStage('download'); break;
        case 'download_done':
          if (m.filename) setDubFilename(m.filename);
          break;
        case 'extract_start': setDubPrepStage('extract'); break;
        case 'extract_done':
          // Backend-assigned real job_id lands here (same as client-supplied, but safe)
          if (m.job_id) setDubJobId(m.job_id);
          if (typeof m.duration === 'number') setDubDuration(m.duration);
          if (m.filename) setDubFilename(m.filename);
          break;
        case 'demucs_start': setDubPrepStage('demucs'); break;
        case 'demucs_done': break;
        case 'scene_start': setDubPrepStage('scene'); break;
        case 'scene_done': break;
        case 'cached': setDubPrepStage('cached'); break;
        case 'ready':
          close();
          ctrl.signal.removeEventListener('abort', onAbort);
          resolve(m);
          return;
        case 'error':
          close();
          ctrl.signal.removeEventListener('abort', onAbort);
          reject(new Error(`${m.stage || 'prep'}: ${m.error || 'unknown error'}`));
          return;
        case 'cancelled':
          close();
          ctrl.signal.removeEventListener('abort', onAbort);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        default:
          break;
      }
    };
    evt.onerror = () => {
      if (evt.readyState === EventSource.CLOSED) {
        close();
        ctrl.signal.removeEventListener('abort', onAbort);
        if (lastData && lastData.type === 'ready') resolve(lastData);
        else reject(new Error('prep stream closed unexpectedly'));
      }
    };
  });

  const handleDubUpload = async () => {
    if (!dubVideoFile) return;
    setDubStep('uploading'); setDubError(''); setDubTracks([]); setDubPrepStage('download');
    const ctrl = new AbortController();
    dubAbortCtrlRef.current = ctrl;
    const clientJobId = Math.random().toString(36).slice(2, 10);
    dubClientJobIdRef.current = clientJobId;
    setDubJobId(clientJobId);
    useAppStore.getState().showPill('loading-model', 'Preparing video…', { cancellable: true });
    try {
      const data = await dubUpload(dubVideoFile, clientJobId, { signal: ctrl.signal });
      setDubJobId(data.job_id); if (data.filename) setDubFilename(data.filename);
      setDubTaskId(data.task_id);
      setDubPrepStage('extract');
      useAppStore.getState().showPill('loading-model', 'Extracting audio & scenes…', { cancellable: true });
      await _waitForPrep(data.task_id, ctrl);

      setDubStep('transcribing');
      setDubPrepStage(null);
      setTranscribeStart(Date.now());
      setDubSegments([]);
      useAppStore.getState().showPill('transcribing', 'Transcribing audio…', { cancellable: true });

      await _waitForTranscribe(data.job_id, ctrl);

      setTranscribeStart(null);
      setDubStep('editing');
      useAppStore.getState().completePill('Transcription complete');
      loadProjects();  // refresh sidebar
      loadProfiles();  // speaker clones may have been auto-created
    } catch (err) {
      setDubPrepStage(null);
      if (err.name === 'AbortError') {
        toast('Upload cancelled');
        setDubStep('idle');
        useAppStore.getState().dismissPill();
      } else {
        setDubError(err.message); setDubStep('idle');
        toast.error('Upload failed: ' + err.message);
        useAppStore.getState().errorPill(err.message);
      }
      setTranscribeStart(null);
    } finally {
      dubAbortCtrlRef.current = null;
    }
  };

  const handleDubIngestUrl = async (url, opts = {}) => {
    const clean = (url || '').trim();
    if (!clean) return;
    setDubStep('uploading'); setDubError(''); setDubTracks([]); setDubPrepStage('download');
    const ctrl = new AbortController();
    dubAbortCtrlRef.current = ctrl;
    const clientJobId = Math.random().toString(36).slice(2, 10);
    dubClientJobIdRef.current = clientJobId;
    setDubJobId(clientJobId);
    useAppStore.getState().showPill('loading-model', 'Downloading video…', { cancellable: true });
    try {
      const data = await dubIngestUrl(clean, clientJobId, {
        signal: ctrl.signal,
        fetchSubs: !!opts.fetchSubs,
        subLangs: opts.subLangs,
      });
      setDubJobId(data.job_id);
      setDubTaskId(data.task_id);
      useAppStore.getState().showPill('loading-model', 'Extracting audio & scenes…', { cancellable: true });
      await _waitForPrep(data.task_id, ctrl);

      setDubStep('transcribing');
      setDubPrepStage(null);
      setTranscribeStart(Date.now());
      setDubSegments([]);
      useAppStore.getState().showPill('transcribing', 'Transcribing audio…', { cancellable: true });

      await _waitForTranscribe(data.job_id, ctrl);

      setTranscribeStart(null);
      setDubStep('editing');
      useAppStore.getState().completePill('Transcription complete');
      loadProjects();  // refresh sidebar
      loadProfiles();  // speaker clones may have been auto-created
      toast.success('Ingested ' + clean.slice(0, 60));
    } catch (err) {
      setDubPrepStage(null);
      if (err.name === 'AbortError') {
        toast('Ingest cancelled');
        setDubStep('idle');
        useAppStore.getState().dismissPill();
      } else {
        setDubError(err.message); setDubStep('idle');
        toast.error('URL ingest failed: ' + err.message);
        useAppStore.getState().errorPill(err.message);
      }
      setTranscribeStart(null);
    } finally {
      dubAbortCtrlRef.current = null;
    }
  };

  const handleDubAbort = async () => {
    const jobId = dubClientJobIdRef.current || dubJobId;
    if (dubAbortCtrlRef.current) dubAbortCtrlRef.current.abort();
    if (jobId) {
      await apiDubAbort(jobId);
    }
  };

  // Retry transcribe on an existing job — the video + demucs + scene-cut
  // preprocessing is already on disk, so we skip straight back to the ASR
  // stream. Used by the "Retry" button on the transcribe-failed banner.
  const handleDubRetryTranscribe = async () => {
    if (!dubJobId) return;
    const ctrl = new AbortController();
    dubAbortCtrlRef.current = ctrl;
    setDubError('');
    setDubSegments([]);
    setDubStep('transcribing');
    setTranscribeStart(Date.now());
    try {
      await _waitForTranscribe(dubJobId, ctrl);
      setTranscribeStart(null);
      setDubStep('editing');
      loadProjects();  // refresh sidebar
    } catch (err) {
      setTranscribeStart(null);
      if (err.name === 'AbortError') {
        toast('Retry cancelled');
        setDubStep('idle');
      } else {
        setDubError(err.message);
        setDubStep('idle');
        toast.error('Transcription failed: ' + err.message);
      }
    } finally {
      dubAbortCtrlRef.current = null;
    }
  };

  // Transcription elapsed timer
  useEffect(() => {
    if (!transcribeStart) { setTranscribeElapsed(0); return; }
    const iv = setInterval(() => setTranscribeElapsed(Math.floor((Date.now() - transcribeStart) / 1000)), 500);
    return () => clearInterval(iv);
  }, [transcribeStart]);

  // ── AUTO-TRANSLATE ──
  const handleCleanupSegments = async () => {
    if (!dubJobId || !dubSegments.length) return;
    const before = dubSegments.length;
    try {
      const data = await dubCleanupSegments(dubJobId);
      setDubSegments(data.segments || []);
      const delta = before - (data.after ?? data.segments.length);
      toast.success(delta > 0 ? `Cleaned ${delta} fragment${delta === 1 ? '' : 's'}` : 'Segments already clean');
    } catch (err) {
      toast.error('Clean up failed: ' + err.message);
    }
  };

  const handleTranslateAll = async () => {
    if (!dubSegments.length || !dubLangCode) return;
    setIsTranslating(true);
    try {
      const data = await dubTranslate({
        // Translate from preserved ORIGINAL text so switching target languages
        // doesn't compound errors (de → fr translating already-German).
        segments: dubSegments.map(s => ({
          id: String(s.id),
          text: (s.text_original && s.text_original.trim()) ? s.text_original : s.text,
          target_lang: s.target_lang,
          // Phase 4.2 — free-form direction threads into reflect/adapt prompts.
          direction: s.direction || undefined,
          // Phase 4.4 — slot duration lets the translator run speech-rate fit.
          slot_seconds: (s.end != null && s.start != null) ? (s.end - s.start) : undefined,
        })),
        target_lang: dubLangCode,
        provider: translateProvider,
        quality: translateQuality,  // "fast" | "cinematic"
        glossary: glossaryTerms.length
          ? glossaryTerms.map(t => ({ source: t.source, target: t.target, note: t.note || '' }))
          : undefined,
      });
      const translatedMap = {};
      const errors = [];
      (data.translated || []).forEach(t => {
        translatedMap[t.id] = t;
        if (t.error) errors.push({ id: t.id, error: t.error });
      });
      setDubSegments(dubSegments.map(s => {
        const hit = translatedMap[s.id];
        if (!hit) return s;
        const newText = (hit.text && hit.text.trim()) ? hit.text : s.text;
        return {
          ...s,
          text: newText,
          translate_error: hit.error || undefined,
          // Cinematic mode returns literal + critique alongside the final text.
          translate_literal: hit.literal || undefined,
          translate_critique: hit.critique || undefined,
        };
      }));
      if (data.cinematic_skipped === 'no-llm-configured') {
        toast(
          'Cinematic quality needs an LLM — set TRANSLATE_BASE_URL + TRANSLATE_API_KEY (Ollama works locally). Falling back to Fast.',
          { icon: 'ℹ️', duration: 7000 },
        );
      }
      if (errors.length) {
        const unique = [...new Set(errors.map(e => e.error))];
        toast.error(
          `${errors.length}/${data.translated.length} segment${errors.length === 1 ? '' : 's'} failed: ${unique[0].slice(0, 120)}`,
          { duration: 6000 }
        );
        console.warn('Translation errors:', errors);
      } else {
        const qLabel = data.quality_used === 'cinematic' ? ' (Cinematic)' : '';
        toast.success(`Translated ${data.translated.length} segment${data.translated.length === 1 ? '' : 's'} → ${data.target_lang}${qLabel}`);
      }
    } catch (err) { setDubError('Translation failed: ' + err.message); }
    setIsTranslating(false);
  };

  const handleDubGenerate = async (opts = {}) => {
    // Phase 4.1 — opts.regenOnly (array of seg ids) triggers partial regen.
    // opts.preview (bool) opts into the fast-but-lower-quality preview path
    // (num_step=8); client re-renders preview segs at full quality before export.
    const regenOnly = Array.isArray(opts.regenOnly) && opts.regenOnly.length
      ? opts.regenOnly
      : null;
    const preview = !!opts.preview;
    setDubStep('generating');
    setDubProgress({ current: 0, total: dubSegments.length, text: '' });
    setDubError('');
    const genLabel = regenOnly ? `Regenerating ${regenOnly.length} segment${regenOnly.length > 1 ? 's' : ''}…` : 'Generating dub…';
    useAppStore.getState().showPill('generating', genLabel, { cancellable: true });
    try {
      const body = {
        segment_ids: dubSegments.map(s => String(s.id)),
        regen_only: regenOnly,
        segments: dubSegments.map(s => {
          let fin_prof = s.profile_id || '';
          let fin_inst = s.instruct || '';
          if (fin_prof.startsWith('preset:')) {
            const pr = PRESETS.find(p => p.id === fin_prof.replace('preset:', ''));
            if (pr) {
              const parts = Object.values(pr.attrs).filter(v => v !== 'Auto');
              if (fin_inst.trim()) parts.push(fin_inst.trim());
              fin_inst = parts.join(', ');
            }
            fin_prof = '';
          }
          return {
            start: s.start, end: s.end, text: s.text,
            instruct: fin_inst, profile_id: fin_prof,
            speed: s.speed || undefined,
            gain: s.gain !== undefined && s.gain !== 1.0 ? s.gain : undefined,
            target_lang: s.target_lang || undefined,
            // Phase 4.2 — direction flows through to TTS (instruct + rate bias).
            direction: s.direction || undefined,
          };
        }),
        language: dubLang === 'Auto' ? 'Auto' : dubLang,
        language_code: dubLangCode,
        instruct: dubInstruct,
        num_step: steps, guidance_scale: cfg, speed: speed,
        preview,
      };
      const data = await dubGenerate(dubJobId, body);
      setDubTaskId(data.task_id);

      // Connect to background task SSE stream
      const streamRes = await fetch(tasksStreamUrl(data.task_id));
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let wasCancelled = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'progress') {
                setDubProgress({ current: evt.current + 1, total: evt.total, text: evt.text });
                const pct = Math.round(((evt.current + 1) / evt.total) * 100);
                useAppStore.getState().setPillProgress(pct);
                useAppStore.getState().setPillLabel(`Generating dub… ${evt.current + 1}/${evt.total}`);
              }
              else if (evt.type === 'done') {
                setDubStep('done');
                setDubTracks(evt.tracks || []);
                if (evt.sync_scores) {
                  setDubSegments(prev => prev.map((s, idx) => ({ ...s, sync_ratio: evt.sync_scores[idx] })));
                }
                // Phase 4.5 — backend streams seg_hashes in the 'done' event
                // (persisted after each segment, so mid-run crashes stay
                // resumable). Fall back to /tools/incremental if the backend
                // predates this field.
                // Track which segs are at preview quality. A seg's num_step
                // < the full-quality floor means the user will need to
                // re-render it at full before export; derive the list here
                // and let the export-click handler pre-flight it.
                if (evt.seg_num_step && typeof evt.seg_num_step === 'object') {
                  const preview = Object.entries(evt.seg_num_step)
                    .filter(([, n]) => typeof n === 'number' && n < steps)
                    .map(([id]) => id);
                  setPreviewSegIds(preview);
                }
                if (evt.seg_hashes && Object.keys(evt.seg_hashes).length > 0) {
                  setLastGenFingerprints(evt.seg_hashes);
                } else {
                  try {
                    const plan = await apiPost('/tools/incremental', {
                      segments: dubSegments.map(s => ({
                        id: String(s.id), text: s.text, target_lang: s.target_lang,
                        profile_id: s.profile_id, instruct: s.instruct,
                        speed: s.speed, direction: s.direction,
                      })),
                    });
                    setLastGenFingerprints(plan.fingerprints || {});
                  } catch { /* best-effort */ }
                }
              }
              else if (evt.type === 'cancelled') {
                wasCancelled = true;
                setDubStep('editing');
                setDubError('Generation aborted.');
                toast('Dubbing aborted', { icon: '⏹' });
              }
              else if (evt.type === 'error') setDubError(p => p + `\nSeg ${evt.segment}: ${evt.error}`);
            } catch (e) {}
          }
        }
      }
      setDubTaskId(null);
      if (!wasCancelled) {
        if (dubStep !== 'done') setDubStep('done');
        loadDubHistory();
        loadProjects();  // refresh sidebar with updated project state
        playPing();
        useAppStore.getState().completePill('Dub complete');
      } else {
        useAppStore.getState().dismissPill();
      }
    } catch (err) {
      setDubError(err.message); setDubStep('editing'); setDubTaskId(null);
      useAppStore.getState().errorPill(err.message);
    }
  };

  const handleDubStop = async () => {
    if (!dubTaskId) return;
    setDubStep('stopping');
    try {
      await tasksCancel(dubTaskId);
    } catch (e) {
      toast.error('Failed to stop');
    }
  };

  const handleNativeExport = async (e, sourceIdentifier, fallbackName, mode) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const ext = fallbackName.includes('.') ? fallbackName.split('.').pop() : 'wav';
      const destPath = await save({ defaultPath: fallbackName, filters: [{ name: 'Media', extensions: [ext] }] });
      if (!destPath) return; // User cancelled

      await exportAction({ source_filename: sourceIdentifier, destination_path: destPath, mode });
      toast.success(`Exported: ${fallbackName}`);
      loadExportHistory();
    } catch (err) {
      console.error(err);
      toast.error(`Export failed: ${err?.message || err}`);
    }
  };
  const revealInFolder = async (filePath) => {
    try {
      await exportReveal({ path: filePath });
    } catch (err) {
      toast.error(`Could not open folder: ${err.message}`);
    }
  };
  const parseFilenameFromContentDisposition = (header) => {
    if (!header) return null;
    const utf8 = header.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/i);
    if (utf8) { try { return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, '')); } catch { /* ignore */ } }
    const plain = header.match(/filename="?([^";]+)"?/i);
    return plain ? plain[1].trim() : null;
  };

  const triggerDownload = async (url, fallbackName) => {
    const extGuess = (fallbackName.includes('.') ? fallbackName.split('.').pop() : 'bin').toLowerCase();
    const modeGuess = ['mp4','mov','mkv','webm'].includes(extGuess)
      ? 'video' : ['wav','mp3','flac'].includes(extGuess) ? 'audio' : 'file';

    // In Tauri, WebKit silently drops blob downloads. Use native save dialog
    // + server-side copy so the file actually lands on disk at a known path.
    if (isTauri) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const destPath = await save({
          defaultPath: fallbackName,
          filters: [{ name: modeGuess === 'video' ? 'Video' : 'Audio', extensions: [extGuess] }],
        });
        if (!destPath) return; // user cancelled
        toast.loading(`Saving ${fallbackName}...`, { id: fallbackName });
        const sep = url.includes('?') ? '&' : '?';
        const res = await fetch(`${url}${sep}save_path=${encodeURIComponent(destPath)}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || 'Save failed');
        }
        const data = await res.json();
        toast.success(`Saved: ${data.path}`, { id: fallbackName });
        try {
          await exportRecord({ filename: data.display_name || fallbackName, destination_path: data.path, mode: modeGuess });
          loadExportHistory();
        } catch (_) {}
      } catch (err) {
        console.error(err);
        toast.error(`Save error: ${err.message}`, { id: fallbackName });
      }
      return;
    }

    // Browser path: standard blob download.
    try {
      toast.loading(`Processing ${fallbackName}...`, { id: fallbackName });
      const response = await fetch(url);
      if (!response.ok) throw new Error("Download failed");
      const serverName = parseFilenameFromContentDisposition(response.headers.get('content-disposition'));
      const finalName = serverName || fallbackName || 'download';
      const blob = await response.blob();
      const localUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = localUrl;
      a.download = finalName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(localUrl);
      toast.success(`Downloaded ${finalName}`, { id: fallbackName });
      try {
        await exportRecord({ filename: finalName, destination_path: `~/Downloads/${finalName}`, mode: modeGuess });
        loadExportHistory();
      } catch (_) {}
    } catch (err) {
      console.error(err);
      toast.error(`Download error: ${err.message}`, { id: fallbackName });
    }
  };
  // Pre-flight for audio/video exports. If any segments are at preview
  // quality (num_step=8, from a "Regen changed" click), re-render those at
  // full quality first so the user's exported file isn't carrying preview
  // artifacts. No-op when previewSegIds is empty.
  const finalizeTtsBeforeExport = async () => {
    if (!previewSegIds || previewSegIds.length === 0) return;
    toast(`Upgrading ${previewSegIds.length} preview-quality segment${previewSegIds.length === 1 ? '' : 's'} to full quality…`, { icon: '✨' });
    await handleDubGenerate({ regenOnly: previewSegIds, preview: false });
  };
  const handleDubDownload = async () => {
    await finalizeTtsBeforeExport();
    // Build selected tracks from all known tracks, matching the checkbox `!== false` logic
    const selected = [];
    if (exportTracks['original'] !== false) selected.push('original');
    dubTracks.forEach(t => { if (exportTracks[t] !== false) selected.push(t); });
    const tracksParam = selected.join(',');
    const burnParam = burnSubs ? `&burn_subs=1&dual=${dualSubs ? 1 : 0}` : '';
    triggerDownload(`${API}/dub/download/${dubJobId}/dubbed_video.mp4?preserve_bg=${preserveBg}&default_track=${defaultTrack}&include_tracks=${encodeURIComponent(tracksParam)}${burnParam}`, 'dubbed_video.mp4');
  };
  const handleDubAudioDownload = async () => {
    await finalizeTtsBeforeExport();
    triggerDownload(`${API}/dub/download-audio/${dubJobId}/dubbed_audio.wav?preserve_bg=${preserveBg}`, 'dubbed_audio.wav');
  };
  // Generic audio export wrapper — MP3, Clips, Stems all need preview segs
  // upgraded before mux. Subtitle exports (SRT/VTT) skip this.
  const handleAudioExport = async (url, filename) => {
    await finalizeTtsBeforeExport();
    triggerDownload(url, filename);
  };
  const resetDub = () => {
    setDubJobId(null); setDubStep('idle'); setDubSegments([]); setDubFilename('');
    setDubDuration(0); setDubError(''); setDubVideoFile(null); setDubTracks([]);
    setDubProgress({ current: 0, total: 0, text: '' }); setDubTranscript(''); setShowTranscript(false);
    setPreviewAudios({});
    setDubLocalBlobUrl(prev => {
      if (prev?.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(prev.videoUrl);
      if (prev?.audioUrl?.startsWith('blob:') && prev.audioUrl !== prev.videoUrl) URL.revokeObjectURL(prev.audioUrl);
      return null;
    });
    setActiveProject(null);
  };

  // ═══ STUDIO PROJECT CRUD ═══
  const saveProject = async () => {
    if (dubStep === 'idle') {
      toast.error("Please click 'Upload & Transcribe' first so the video is processed on the server before saving.");
      return;
    }
    const name = activeProjectName || dubFilename || `Project ${new Date().toLocaleString()}`;
    const statePayload = {
      name,
      video_path: dubFilename || null,
      duration: dubDuration || null,
      state: {
        dubJobId, dubFilename, dubDuration, dubSegments,
        dubLang, dubLangCode, dubInstruct, dubTracks,
        dubStep, dubTranscript, preserveBg, defaultTrack,
        speakerClones,
      },
    };
    try {
      const data = await apiSaveProject(statePayload, activeProjectId);
      setActiveProject(data.id, name);
      toast.success(activeProjectId ? 'Project saved' : 'Project created');
      loadProjects();
    } catch (err) {
      toast.error('Save failed: ' + err.message);
    }
  };

  const loadProject = async (projectOrId) => {
    const pid = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
    try {
      const data = await apiLoadProject(pid);
      const s = data.state || {};
      setMode('dub');
      setActiveProject(data.id, data.name);
      setDubJobId(s.dubJobId || null);
      setDubFilename(s.dubFilename || data.video_path || '');
      setDubDuration(s.dubDuration || data.duration || 0);
      setDubSegments((s.dubSegments || []).map(x => ({ ...x, text_original: x.text_original || x.text || '' })));
      setDubLang(s.dubLang || 'Auto');
      setDubLangCode(s.dubLangCode || 'en');
      setDubInstruct(s.dubInstruct || '');
      setDubTracks(s.dubTracks || []);
      setDubTranscript(s.dubTranscript || '');
      setPreserveBg(s.preserveBg !== undefined ? s.preserveBg : true);
      setDefaultTrack(s.defaultTrack !== undefined ? s.defaultTrack : 'original');
      setDubStep(s.dubStep === 'done' ? 'done' : (s.dubSegments?.length ? 'editing' : 'idle'));
      // Phase 4.5 — rehydrate per-segment fingerprints. The incremental plan
      // immediately shows "N segments changed" for any segments edited after
      // the last generate.
      setLastGenFingerprints(s.segHashes || {});
      setSpeakerClones(s.speakerClones || {});
      toast.success(`Opened: ${data.name}`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const deleteProject = async (projectId, e) => {
    if (e) e.stopPropagation();
    if (!confirm('Delete this project? This cannot be undone.')) return;
    try {
      await apiDeleteProject(projectId);
      if (activeProjectId === projectId) {
        setActiveProject(null);
      }
      loadProjects();
      toast.success('Project deleted');
    } catch (err) { toast.error(err.message); }
  };

  const restoreDubHistory = (item) => {
    try {
      if (!item.job_data) return;
      const job = JSON.parse(item.job_data);
      setMode('dub');
      setDubJobId(item.id);
      setDubFilename(job.filename || '');
      setDubDuration(job.duration || 0);
      setDubSegments((job.segments || []).map((s, i) => ({ ...s, id: s.id != null ? String(s.id) : String(i), text_original: s.text_original || s.text || '' })));
      setDubTranscript(job.full_transcript || '');
      setDubLang(item.language || 'Auto');
      setDubLangCode(item.language_code || 'und');
      setDubTracks(Object.keys(job.dubbed_tracks || {}));
      setDubStep(Object.keys(job.dubbed_tracks || {}).length > 0 ? 'done' : 'editing');
      // Phase 4.5 — seg_hashes are written per successful segment by
      // dub_generate.py. Reloading a half-generated dub lets the "Regen N
      // changed" button resume right where the crash happened.
      setLastGenFingerprints(job.seg_hashes || {});
      // Rehydrate the auto-extracted speaker clones so the CAST dropdown's
      // "🎤 From video" option reappears after a reload. Projects that
      // predate the speaker-clone feature have an empty map; the Extract
      // Voices button in the CAST strip handles those.
      setSpeakerClones(job.speaker_clones || {});
    } catch (e) {
      console.error("Failed to restore job_data", e);
    }
  };

  const restoreHistory = (item) => {
    if (item.mode) setMode(item.mode);
    if (item.text) setText(item.text);
    if (item.language) setLanguage(item.language);
    if (item.seed) setSeed(item.seed.toString());
    if (item.profile_id) setSelectedProfile(item.profile_id);
    
    // Switch to studio tab
    setSidebarTab('projects');
    toast.success('Restored previous generation state');
  };

  const deleteHistory = async (id, type) => {
    if (!confirm('Delete this history item?')) return;
    try {
      const endpoint = type === 'dub' ? `${API}/dub/history/${id}` : `${API}/history/${id}`;
      await fetch(endpoint, { method: 'DELETE' });
      if (type === 'dub') {
        loadDubHistory();
      } else {
        loadHistory();
      }
      toast.success('History item deleted');
    } catch (err) {
      toast.error(err.message);
    }
  };


  // First-run gate: if /setup/status says models aren't on disk yet, render
  // the wizard instead of the main studio. Dismisses itself once the user
  // completes the download (or clicks "Skip" if they want to limp along).
  // Also blocks render until we've heard back from the backend at least once
  // — the frozen sidecar's cold-start import is ~5-10 s and without this we
  // flash the empty studio before the wizard has a chance to mount.
  if (!setupChecked) {
    return (
      <div className="app-container sidebar-hidden app-startup" style={{ zoom: uiScale }}>
        <div className="app-startup__title">OmniVoice Studio</div>
        <div>Starting backend…</div>
      </div>
    );
  }
  if (setupNeeded) {
    // Render outside the `app-container` grid so the wizard spans the full
    // viewport instead of getting squeezed into whatever grid cell the
    // studio layout reserves for the main content column.
    return (
      <div
        className="app-wizard-wrap"
        style={{ zoom: uiScale }}
      >
        {/* Invisible drag strip across the top 28 px of the wizard —
            matches the macOS traffic-light zone so the window can be
            dragged / double-click-zoomed from anywhere along the top. */}
        <div
          data-tauri-drag-region
          onDoubleClick={() => {
            if ('__TAURI_INTERNALS__' in window) {
              import('@tauri-apps/api/window').then(m =>
                m.getCurrentWindow().toggleMaximize()
              ).catch(() => {});
            }
          }}
          className="app-wizard-dragstrip"
        />
        <Suspense fallback={<LazyFallback />}>
          <SetupWizard onReady={() => setSetupNeeded(false)} />
        </Suspense>
        <Suspense fallback={null}>
          <LogsFooter />
        </Suspense>
      </div>
    );
  }

  // Block the main UI until Rust reports the backend is ready. In dev web
  // (no Tauri), the hook returns 'ready' immediately so this is a no-op.
  if (bootstrapStage !== 'ready') {
    return <BootstrapSplash stage={bootstrapStage} message={bootstrapMessage} />;
  }

  return (
    <div
      className={[
        'app-container',
        isSidebarCollapsed ? 'sidebar-collapsed' : '',
        hideSidebar ? 'sidebar-hidden' : '',
        navRailSide === 'right' ? 'rail-right' : '',
      ].filter(Boolean).join(' ')}
      style={{ zoom: uiScale }}
    >
      {pendingTrimFile && (
        <Suspense fallback={<LazyFallback />}>
          <AudioTrimmer
            file={pendingTrimFile}
            maxSeconds={CLONE_MAX_SECONDS}
            onCancel={() => setPendingTrimFile(null)}
            onConfirm={(trimmed) => { setPendingTrimFile(null); setRefAudio(trimmed); setSelectedProfile(null); toast.success('Trimmed audio loaded'); }}
          />
        </Suspense>
      )}
      <Toaster position="top-center" toastOptions={{
        style: { background: 'rgba(40,40,40,0.9)', backdropFilter: 'blur(10px)', color: '#ebdbb2', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.72rem', padding: '4px 8px' },
        error: { iconTheme: { primary: '#fb4934', secondary: '#fff' } },
        success: { iconTheme: { primary: '#b8bb26', secondary: '#fff' } }
      }}/>

      <FloatingPill />

      <Header
        mode={mode} setMode={setMode}
        sysStats={sysStats} modelStatus={modelStatus}
        doubleClickMaximize={doubleClickMaximize}
        activeProjectName={activeProjectName}
        onFlushMemory={async (unloadModel) => {
          try {
            const r = await apiFlushMemory(unloadModel);
            toast.success(`Flushed — RAM ${r.ram_after}G · VRAM ${r.vram_after}G${r.unloaded_model ? ' · model unloaded' : ''}`);
          } catch (e) { toast.error('Flush failed: ' + e.message); }
        }}
      />

      <NavRail mode={mode} setMode={setMode} side={navRailSide} onFlipSide={flipNavRailSide} />

      <div className="main-content">

        {/* ═══ LAUNCHPAD TAB ═══ */}
        {mode === 'settings' ? (
          <ErrorBoundary name="settings">
            <Suspense fallback={<LazyFallback />}>
              <Settings />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'voice' ? (
          <ErrorBoundary name="voice-profile">
            <Suspense fallback={<LazyFallback />}>
              <VoiceProfile
                voiceId={activeVoiceId}
                onBack={closeVoiceProfile}
                onOpenProject={(id) => { loadProject(id); }}
                onDeleted={() => {
                  loadProfiles();
                  closeVoiceProfile();
                }}
              />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'queue' ? (
          <ErrorBoundary name="batch-queue">
            <Suspense fallback={<LazyFallback />}>
              <BatchQueue onBack={() => setMode('launchpad')} />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'tools' ? (
          <ErrorBoundary name="tools">
            <Suspense fallback={<LazyFallback />}>
              <ToolsPage onBack={() => setMode('launchpad')} />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'projects' ? (
          <ErrorBoundary name="projects">
            <Suspense fallback={<LazyFallback />}>
              <ProjectsPage
                studioProjects={studioProjects}
                profiles={profiles}
                history={history}
                exportHistory={exportHistory}
                onOpenDub={(id) => { loadProject(id); setMode('dub'); }}
                onOpenProfile={(id) => { openVoiceProfile(id); }}
                onRevealExport={(path) => { exportReveal({ path }).catch(() => {}); }}
              />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'gallery' ? (
          <ErrorBoundary name="gallery">
            <Suspense fallback={<LazyFallback />}>
              <VoiceGallery />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'donate' ? (
          <ErrorBoundary name="donate">
            <Suspense fallback={<LazyFallback />}>
              <DonatePage onBack={() => setMode('launchpad')} onEnterprise={() => setMode('enterprise')} />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'enterprise' ? (
          <ErrorBoundary name="enterprise">
            <Suspense fallback={<LazyFallback />}>
              <EnterprisePage onBack={() => setMode('launchpad')} />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'launchpad' ? (
          <ErrorBoundary name="launchpad">
          <Suspense fallback={<LazyFallback />}>
            <Launchpad
              profiles={profiles}
              studioProjects={studioProjects}
              dubHistory={dubHistory}
              setMode={setMode}
              setIsCompareModalOpen={setIsCompareModalOpen}
              handleSelectProfile={handleSelectProfile}
              loadProject={loadProject}
            />
          </Suspense>
          </ErrorBoundary>
        ) : mode === 'dub' ? (
          <ErrorBoundary name="dub">
          <Suspense fallback={<LazyFallback />}>
            <DubTab
              // Non-serialisable / local state only — all pipeline fields now
              // flow through the Zustand store.
              dubVideoFile={dubVideoFile}
              dubLocalBlobUrl={dubLocalBlobUrl}
              transcribeElapsed={transcribeElapsed}
              translateProvider={translateProvider} setTranslateProvider={setTranslateProvider}
              onGlossaryChange={setGlossaryTerms}
              showTranscript={showTranscript} setShowTranscript={setShowTranscript}
              profiles={profiles}
              segmentPreviewLoading={segmentPreviewLoading}
              selectedSegIds={selectedSegIds}
              setDubVideoFile={setDubVideoFile}
              setDubLocalBlobUrl={setDubLocalBlobUrl}
              // Handlers — close over App.jsx scope so stay prop-threaded.
              handleDubAbort={handleDubAbort} handleDubUpload={handleDubUpload} handleDubIngestUrl={handleDubIngestUrl}
              handleDubRetryTranscribe={handleDubRetryTranscribe}
              handleDubStop={handleDubStop} handleDubGenerate={handleDubGenerate}
              handleDubDownload={handleDubDownload} handleDubAudioDownload={handleDubAudioDownload}
              handleAudioExport={handleAudioExport}
              speakerClones={speakerClones}
              handleSegmentPreview={handleSegmentPreview}
              onDirectSegment={openDirection}
              incrementalPlan={incrementalPlan}
              handleTranslateAll={handleTranslateAll}
              handleCleanupSegments={handleCleanupSegments}
              triggerDownload={triggerDownload}
              fileToMediaUrl={fileToMediaUrl}
              editSegments={editSegments}
              saveProject={saveProject} resetDub={resetDub}
              segmentEditField={segmentEditField} segmentDelete={segmentDelete}
              segmentRestoreOriginal={segmentRestoreOriginal}
              segmentSplit={segmentSplit} segmentMerge={segmentMerge}
              toggleSegSelect={toggleSegSelect}
              selectAllSegs={selectAllSegs} clearSegSelection={clearSegSelection}
              bulkApplyToSelected={bulkApplyToSelected}
              bulkDeleteSelected={bulkDeleteSelected}
            />
          </Suspense>
          </ErrorBoundary>
        ) : (
          <ErrorBoundary name="clone-design">
          <Suspense fallback={<LazyFallback />}>
            <CloneDesignTab
              mode={mode}
              textAreaRef={textAreaRef}
              text={text} setText={setText}
              language={language} setLanguage={setLanguage}
              steps={steps} setSteps={setSteps}
              cfg={cfg} setCfg={setCfg}
              speed={speed} setSpeed={setSpeed}
              tShift={tShift} setTShift={setTShift}
              posTemp={posTemp} setPosTemp={setPosTemp}
              classTemp={classTemp} setClassTemp={setClassTemp}
              layerPenalty={layerPenalty} setLayerPenalty={setLayerPenalty}
              duration={duration} setDuration={setDuration}
              denoise={denoise} setDenoise={setDenoise}
              postprocess={postprocess} setPostprocess={setPostprocess}
              showOverrides={showOverrides} setShowOverrides={setShowOverrides}
              isSidebarCollapsed={isSidebarCollapsed} setIsSidebarCollapsed={setIsSidebarCollapsed}
              profiles={profiles}
              selectedProfile={selectedProfile} setSelectedProfile={setSelectedProfile}
              refAudio={refAudio}
              refText={refText} setRefText={setRefText}
              instruct={instruct} setInstruct={setInstruct}
              profileName={profileName} setProfileName={setProfileName}
              showSaveProfile={showSaveProfile} setShowSaveProfile={setShowSaveProfile}
              isRecording={isRecording} isCleaning={isCleaning} recordingTime={recordingTime}
              vdStates={vdStates} setVdStates={setVdStates}
              isGenerating={isGenerating} generationTime={generationTime}
              applyPreset={applyPreset} insertTag={insertTag}
              handleSelectProfile={handleSelectProfile}
              handleDeleteProfile={handleDeleteProfile}
              handleSaveProfile={handleSaveProfile}
              handleGenerate={handleGenerate}
              startRecording={startRecording} stopRecording={stopRecording}
              ingestRefAudio={ingestRefAudio}
            />
          </Suspense>
          </ErrorBoundary>
        )}
      </div>

      {/* ── SIDEBAR ── */}
      <Suspense fallback={<LazyFallback />}>
        <Sidebar
          availableTabs={availableSidebarTabs}
          isSidebarProjectsCollapsed={isSidebarProjectsCollapsed}
          setIsSidebarProjectsCollapsed={setIsSidebarProjectsCollapsed}
          sidebarTab={sidebarTab} setSidebarTab={setSidebarTab}
          studioProjects={studioProjects}
          profiles={profiles}
          history={history}
          dubHistory={dubHistory}
          exportHistory={exportHistory}
          dubVideoFile={dubVideoFile}
          selectedProfile={selectedProfile}
          previewLoading={previewLoading}
          saveProject={saveProject}
          loadProject={loadProject}
          deleteProject={deleteProject}
          handleSelectProfile={handleSelectProfile}
          handleDeleteProfile={handleDeleteProfile}
          handleOpenVoiceProfile={openVoiceProfile}
          handleUnlockProfile={handleUnlockProfile}
          handleLockProfile={handleLockProfile}
          handlePreviewVoice={handlePreviewVoice}
          onOpenVoicePreview={(profileId) => {
            setVoicePreviewProfileId(profileId || '');
            setIsVoicePreviewOpen(true);
          }}
          restoreHistory={restoreHistory}
          restoreDubHistory={restoreDubHistory}
          handleSaveHistoryAsProfile={handleSaveHistoryAsProfile}
          handleNativeExport={handleNativeExport}
          revealInFolder={revealInFolder}
          deleteHistory={deleteHistory}
          loadHistory={loadHistory}
          loadDubHistory={loadDubHistory}
        />
      </Suspense>

      {/* ═══ DIRECTION DIALOG (Phase 4.2) ═══ */}
      <DirectionDialog
        open={!!directionSegId}
        seg={directionSegId ? dubSegments.find(s => s.id === directionSegId) : null}
        onSave={saveDirection}
        onClose={closeDirection}
      />

      {/* ═══ A/B VOICE COMPARISON MODAL ═══ */}
      {isCompareModalOpen && (
        <Suspense fallback={<LazyFallback />}>
          <CompareModal
            open={isCompareModalOpen}
            onClose={() => setIsCompareModalOpen(false)}
            profiles={profiles}
            compareText={compareText} setCompareText={setCompareText}
            compareVoiceA={compareVoiceA} setCompareVoiceA={setCompareVoiceA}
            compareVoiceB={compareVoiceB} setCompareVoiceB={setCompareVoiceB}
            compareResultA={compareResultA} setCompareResultA={setCompareResultA}
            compareResultB={compareResultB} setCompareResultB={setCompareResultB}
            compareProgress={compareProgress} setCompareProgress={setCompareProgress}
            isComparing={isComparing} setIsComparing={setIsComparing}
            steps={steps} cfg={cfg} speed={speed} denoise={denoise} postprocess={postprocess}
            fileToMediaUrl={fileToMediaUrl}
            loadHistory={loadHistory}
          />
        </Suspense>
      )}

      {/* ═══ KEYBOARD CHEATSHEET ( ? ) ═══ */}
      {showCheatsheet && (
        <Suspense fallback={null}>
          <KeyboardCheatsheet open={showCheatsheet} onClose={() => setShowCheatsheet(false)} />
        </Suspense>
      )}

      {/* ═══ VOICE PREVIEW FLOATING CARD ═══ */}
      {isVoicePreviewOpen && (
        <Suspense fallback={null}>
          <VoicePreview
            open={isVoicePreviewOpen}
            onClose={() => setIsVoicePreviewOpen(false)}
            profiles={profiles}
            initialProfileId={voicePreviewProfileId}
            fileToMediaUrl={fileToMediaUrl}
          />
        </Suspense>
      )}

      {/* ═══ BOTTOM LOGS PANEL (VSCode-style) ═══ */}
      <Suspense fallback={null}>
        <LogsFooter />
      </Suspense>

    </div>
  );
}

export default App;
