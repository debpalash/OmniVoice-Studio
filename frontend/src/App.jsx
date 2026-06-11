import React, { useState, useRef, useEffect, useCallback, Suspense, lazy } from 'react';
import './index.css';
import { useAppStore, FONT_STACKS } from './store';
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
const SupportPage = lazy(() => import('./pages/SupportPage'));
const TranscriptionsPage = lazy(() => import('./pages/Transcriptions'));
const StoriesEditor = lazy(() => import('./components/StoriesEditor'));

import Header from './components/Header';
import NavRail from './components/NavRail';
import ErrorBoundary from './components/ErrorBoundary';
import FloatingPill from './components/FloatingPill';
// RemoteAuthGate is mounted at the true outermost provider in main-app.jsx so
// it covers all app states (setup check / wizard / bootstrap), not just the
// main studio return below. Do not re-wrap here — double-gating renders two
// PIN dialogs.

import useRealtimeEvents from './hooks/useRealtimeEvents';
import { BootstrapSplash, useBootstrapStage } from './components/BootstrapSplash';

import './components/Misc.css';
import { askConfirm } from './utils/dialog';
import useRecording from './hooks/useRecording';
import useSegmentEditing from './hooks/useSegmentEditing';
import useAppData from './hooks/useAppData';
import useProfiles from './hooks/useProfiles';
import useTTS from './hooks/useTTS';
import useDubWorkflow from './hooks/useDubWorkflow';

const LazyFallback = () => <div className="app-lazy-fallback">{i18n.t('app.loading')}</div>;

import { Toaster, toast } from 'react-hot-toast';
import { toastErrorWithReport } from './utils/errorToast';
import { addBreadcrumb } from './utils/breadcrumbs';
import {
  POPULAR_LANGS, POPULAR_ISO, TAGS, CATEGORIES, PRESETS, CLONE_MAX_SECONDS,
} from './utils/constants';
import { LANG_CODES } from './utils/languages';
import { formatTime } from './utils/format';
import { API, apiPost } from './api/client';
import { flushMemory as apiFlushMemory } from './api/system';
import { saveProject as apiSaveProject, loadProject as apiLoadProject, deleteProject as apiDeleteProject } from './api/projects';
import { exportAction, exportReveal, exportRecord } from './api/exports';

import { isTauri, doubleClickMaximize, fileToMediaUrl, playBlobAudio, playPing } from './utils/media';
import { browserDownload } from './utils/download';
import { checkForUpdate, fetchAppVersion } from './utils/updater';
import { syncChannel } from './utils/channelControl';
import i18n from './i18n';

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
  const theme = useAppStore(s => s.theme);

  const locale = useAppStore(s => s.locale);
  const font = useAppStore(s => s.font);

  // Hydrate the theme, locale & font so persisted preferences take effect after
  // zustand persist rehydrates (async from localStorage) and when the user
  // changes them at runtime.
  useEffect(() => {
    if (theme && theme !== 'gruvbox') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    if (locale) {
      i18n.changeLanguage(locale);
    }
    // Re-apply the global font the same way setFont does, so a persisted
    // non-default font takes effect on launch.
    const fontStack = FONT_STACKS[font];
    if (fontStack) document.documentElement.style.setProperty('--font-sans', fontStack);
    else document.documentElement.style.removeProperty('--font-sans');
  }, [locale, theme, font]);
  const mode = useAppStore(s => s.mode);
  const setMode = useAppStore(s => s.setMode);
  // Breadcrumb every view change — mode names are a closed set, so this is
  // privacy-safe by construction (see utils/breadcrumbs.js).
  useEffect(() => { addBreadcrumb(`view:${mode}`); }, [mode]);
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





  // Listen for tray navigation events (Tauri desktop)
  useEffect(() => {
    let unlisten;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('tray-navigate', (ev) => {
          if (ev.payload) setMode(ev.payload);
        });
      } catch { /* not in Tauri */ }
    })();
    return () => { if (unlisten) unlisten(); };
  }, [setMode]);
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
    || mode === 'queue' || mode === 'tools' || mode === 'projects' || mode === 'gallery' || mode === 'enterprise' || mode === 'transcriptions'
    || mode === 'stories';
  const availableSidebarTabs = mode === 'dub'
    ? ['projects', 'history', 'downloads']
    : (mode === 'clone' || mode === 'design')
      ? ['projects', 'history']
      : [];
  // Generate-tab prefs now live in `generateSlice` (Phase 2.2). Persisted
  // knobs survive reloads via the store's `partialize`.
  const text              = useAppStore(s => s.text);
  const setText           = useAppStore(s => s.setText);
  const refText         = useAppStore(s => s.refText);
  const setRefText      = useAppStore(s => s.setRefText);
  const instruct        = useAppStore(s => s.instruct);
  const setInstruct     = useAppStore(s => s.setInstruct);
  const language        = useAppStore(s => s.language);
  const setLanguage     = useAppStore(s => s.setLanguage);

  const speed           = useAppStore(s => s.speed);
  const setSpeed        = useAppStore(s => s.setSpeed);
  const steps           = useAppStore(s => s.steps);
  const setSteps        = useAppStore(s => s.setSteps);
  const cfg             = useAppStore(s => s.cfg);
  const setCfg          = useAppStore(s => s.setCfg);
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

  // ═══ EXTRACTED HOOKS ═══
  const {
    profiles, history, dubHistory, studioProjects, exportHistory,
    showOverrides, setShowOverrides,
    sysStats, modelStatus,
    loadProfiles, loadHistory, loadDubHistory, loadProjects, loadExportHistory,
  } = useAppData();

  const {
    selectedProfile, setSelectedProfile,
    showSaveProfile, setShowSaveProfile,
    profileName, setProfileName,
    previewLoading, segmentPreviewLoading,
    isVoicePreviewOpen, setIsVoicePreviewOpen,
    voicePreviewProfileId, setVoicePreviewProfileId,
    handleSaveProfile: _handleSaveProfile,
    handleDeleteProfile, handleSelectProfile,
    handlePreviewVoice, handleSegmentPreview,
    handleSaveHistoryAsProfile, handleLockProfile, handleUnlockProfile,
  } = useProfiles({ loadHistory, loadProfiles });

  const {
    refAudio, setRefAudio,
    pendingTrimFile, setPendingTrimFile,
    isGenerating, generationTime,
    textAreaRef,
    ingestRefAudio, insertTag, applyPreset,
    handleGenerate,
  } = useTTS({ selectedProfile, setSelectedProfile, loadHistory });

  const handleSaveProfile = () => _handleSaveProfile(refAudio, refText, instruct, language);

  // A/B Voice Comparison State
  const [isCompareModalOpen, setIsCompareModalOpen] = useState(false);
  const [compareVoiceA, setCompareVoiceA] = useState("");
  const [compareVoiceB, setCompareVoiceB] = useState("");
  const [compareText, setCompareText] = useState("The quick brown fox jumps over the lazy dog, proving that this voice sounds much better.");
  const [compareResultA, setCompareResultA] = useState(null);
  const [compareResultB, setCompareResultB] = useState(null);
  const [isComparing, setIsComparing] = useState(false);
  const [compareProgress, setCompareProgress] = useState("");

  // ═══ MIC RECORDING ═══
  const {
    isRecording, isCleaning, recordingTime,
    startRecording, stopRecording,
  } = useRecording(ingestRefAudio);

  // ═══ DUB STATE ═══
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

  // ── UNDO / REDO + SEGMENT EDITING ──
  // Must come before useDubWorkflow because the dub generate handler needs
  // setLastGenFingerprints to keep the incremental-regen plan in sync.
  const {
    undo, redo, editSegments,
    segmentEditField, segmentDelete, segmentRestoreOriginal,
    segmentSplit, segmentMerge,
    selectedSegIds, setSelectedSegIds,
    toggleSegSelect, selectAllSegs, clearSegSelection,
    bulkApplyToSelected, bulkDeleteSelected,
    directionSegId, openDirection, closeDirection, saveDirection,
    lastGenFingerprints, setLastGenFingerprints,
    incrementalPlan, setIncrementalPlan,
    recomputeIncremental,
  } = useSegmentEditing();

  useEffect(() => { recomputeIncremental(); }, [recomputeIncremental]);

  const {
    translateProvider, setTranslateProvider,
    showTranscript, setShowTranscript,
    previewAudios, setPreviewAudios,
    transcribeElapsed,
    handleDubUpload: _handleDubUpload, handleDubIngestUrl,
    handleDubAbort, handleDubRetryTranscribe,
    handleDubStop, handleDubGenerate,
    handleCleanupSegments, handleTranslateAll,
    handleDubImportSrt,
  } = useDubWorkflow({ loadProjects, loadProfiles, loadDubHistory, setLastGenFingerprints });

  const [dubVideoFile, setDubVideoFile] = useState(null);
  const [dubLocalBlobUrl, setDubLocalBlobUrl] = useState(null);
  const dubBlobUrlRef = useRef(null);
  useEffect(() => { dubBlobUrlRef.current = dubLocalBlobUrl; }, [dubLocalBlobUrl]);
  useEffect(() => () => {
    const urls = dubBlobUrlRef.current;
    if (urls?.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(urls.videoUrl);
    if (urls?.audioUrl?.startsWith('blob:') && urls.audioUrl !== urls.videoUrl) URL.revokeObjectURL(urls.audioUrl);
  }, []);

  const handleDubUpload = () => _handleDubUpload(dubVideoFile);

  // ═══ STUDIO PROJECTS ═══
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
    // Gate the probe on the bootstrap being 'ready' — before that there is
    // no backend to answer. Probing from mount burned the 30-attempt ceiling
    // during the setup/installing acts (minutes long on a first run), so the
    // wizard was silently skipped straight into the studio once the install
    // finished. Keyed on bootstrapStage: the probe (re)runs the moment the
    // backend becomes reachable.
    if (bootstrapStage !== 'ready') return undefined;
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
  }, [bootstrapStage]);

  // ── First sound ──
  // Onboarding should end with the product doing the thing: the moment the
  // studio mounts after the wizard, generate one short line locally and play
  // it. Best-effort by design — a first impression must never surface an
  // error, so every failure path is silent.
  useEffect(() => {
    if (!setupChecked || setupNeeded || bootstrapStage !== 'ready') return;
    let pending = false;
    try {
      pending = sessionStorage.getItem('omnivoice.firstSound') === '1';
      if (pending) sessionStorage.removeItem('omnivoice.firstSound');
    } catch { /* private mode */ }
    if (!pending) return;
    (async () => {
      try {
        const fd = new FormData();
        fd.append('text', i18n.t('firstrun.first_sound_text'));
        // Functional model prompt (not user-facing copy) — keeps the demo
        // voice warm without depending on seeded profiles.
        fd.append('instruct', 'A warm, friendly narrator voice, medium pace');
        fd.append('num_step', '16');
        const res = await fetch(`${API}/generate`, { method: 'POST', body: fd });
        if (!res.ok) return;
        const blob = await res.blob();
        await playBlobAudio(blob);
        toast.success(i18n.t('firstrun.first_sound_done'), { duration: 7000 });
      } catch { /* silent — see above */ }
    })();
  }, [setupChecked, setupNeeded, bootstrapStage]);

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
    // Non-blocking: surface availability into the store. The UpdateStatusChip
    // in LogsFooter lets the user install + restart when they choose (with a
    // progress bar), so an update never interrupts in-flight work.
    fetchAppVersion().then(v => useAppStore.getState().setAppVersion(v));
    syncChannel(useAppStore.getState());
    checkForUpdate(useAppStore.getState());
    // Re-check periodically so a long-running session still gets notified, not
    // only at boot. checkForUpdate no-ops while a download/restart is already
    // in flight, so this can't interrupt an install.
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const id = setInterval(() => checkForUpdate(useAppStore.getState()), SIX_HOURS);
    return () => clearInterval(id);
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

  const handleNativeExport = async (e, sourceIdentifier, fallbackName, mode) => {
    addBreadcrumb('export');
    if (e) { e.preventDefault(); e.stopPropagation(); }
    // Browser / Docker web build: there is no Tauri shell, so the native save
    // dialog is unavailable — invoking it throws "Cannot read properties of
    // undefined (reading 'invoke')" (issue #256). Fall back to a plain HTTP
    // blob download of the file already served at /audio/<path>.
    if (!isTauri) {
      const niceName = (fallbackName || sourceIdentifier || 'audio').split('/').pop();
      try {
        const finalName = await browserDownload(`${API}/audio/${sourceIdentifier}`, niceName);
        toast.success(i18n.t('app.toast_downloaded', { name: finalName }));
        try {
          await exportRecord({ filename: finalName, destination_path: `~/Downloads/${finalName}`, mode });
          loadExportHistory();
        } catch (err) { console.warn('exportRecord (browser export path) failed:', err); }
      } catch (err) {
        console.error(err);
        toastErrorWithReport(i18n.t('app.toast_export_failed', { message: err?.message || err }), err);
      }
      return;
    }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const ext = fallbackName.includes('.') ? fallbackName.split('.').pop() : 'wav';
      const destPath = await save({ defaultPath: fallbackName, filters: [{ name: 'Media', extensions: [ext] }] });
      if (!destPath) return; // User cancelled

      await exportAction({ source_filename: sourceIdentifier, destination_path: destPath, mode });
      toast.success(i18n.t('app.toast_exported', { name: fallbackName }));
      loadExportHistory();
    } catch (err) {
      console.error(err);
      toastErrorWithReport(i18n.t('app.toast_export_failed', { message: err?.message || err }), err);
    }
  };
  const revealInFolder = async (filePath) => {
    try {
      await exportReveal({ path: filePath });
    } catch (err) {
      toast.error(i18n.t('app.toast_open_folder_failed', { message: err.message }));
    }
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
        toast.loading(i18n.t('app.toast_saving', { name: fallbackName }), { id: fallbackName });

        // Subtitles are small text bodies: fetch them raw and write from this
        // (trusted) process via the save_text_file command — the user's dialog
        // pick is the write authorization, and the backend never handles a
        // destination path (#309).
        if (['srt', 'vtt'].includes(extGuess)) {
          const res = await fetch(url);
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Save failed');
          }
          const text = await res.text();
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('save_text_file', { path: destPath, contents: text });
          toast.success(i18n.t('app.toast_saved', { path: destPath }), { id: fallbackName });
          try {
            await exportRecord({ filename: fallbackName, destination_path: destPath, mode: modeGuess });
            loadExportHistory();
          } catch (err) { console.warn('exportRecord (subtitle save) failed:', err); }
          return;
        }

        const sep = url.includes('?') ? '&' : '?';
        const res = await fetch(`${url}${sep}save_path=${encodeURIComponent(destPath)}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || 'Save failed');
        }
        // Every save_path-aware endpoint returns a JSON envelope. Guard the
        // content-type so a raw-body response surfaces as a clear error
        // instead of a cryptic JSON.parse failure (#309).
        const ctype = res.headers.get('content-type') || '';
        if (!ctype.includes('application/json')) {
          throw new Error(`Server returned ${ctype || 'an unknown content type'} instead of a JSON save confirmation`);
        }
        const data = await res.json();
        toast.success(i18n.t('app.toast_saved', { path: data.path }), { id: fallbackName });
        try {
          await exportRecord({ filename: data.display_name || fallbackName, destination_path: data.path, mode: modeGuess });
          loadExportHistory();
        } catch (err) { console.warn('exportRecord (Tauri save path) failed:', err); }
      } catch (err) {
        console.error(err);
        toast.error(i18n.t('app.toast_save_error', { message: err.message }), { id: fallbackName });
      }
      return;
    }

    // Browser path: standard blob download.
    try {
      toast.loading(i18n.t('app.toast_processing', { name: fallbackName }), { id: fallbackName });
      const finalName = await browserDownload(url, fallbackName);
      toast.success(i18n.t('app.toast_downloaded', { name: finalName }), { id: fallbackName });
      try {
        await exportRecord({ filename: finalName, destination_path: `~/Downloads/${finalName}`, mode: modeGuess });
        loadExportHistory();
      } catch (err) { console.warn('exportRecord (browser download path) failed:', err); }
    } catch (err) {
      console.error(err);
      toast.error(i18n.t('app.toast_download_error', { message: err.message }), { id: fallbackName });
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
      toast.error(i18n.t('app.toast_upload_first'));
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
      toast.success(activeProjectId ? i18n.t('app.toast_project_saved') : i18n.t('app.toast_project_created'));
      loadProjects();
    } catch (err) {
      toast.error(i18n.t('app.toast_save_failed', { message: err.message }));
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
      toast.success(i18n.t('app.toast_opened', { name: data.name }));
    } catch (err) {
      toast.error(err.message);
    }
  };

  const deleteProject = async (projectId, e) => {
    if (e) e.stopPropagation();
    if (!(await askConfirm('Delete this project? This cannot be undone.'))) return;
    try {
      await apiDeleteProject(projectId);
      if (activeProjectId === projectId) {
        setActiveProject(null);
      }
      loadProjects();
      toast.success(i18n.t('app.toast_project_deleted'));
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
    if (item.profile_id) setSelectedProfile(item.profile_id);
    
    // Switch to studio tab
    setSidebarTab('projects');
    toast.success(i18n.t('app.toast_restored_state'));
  };

  const deleteHistory = async (id, type) => {
    if (!(await askConfirm('Delete this history item?'))) return;
    try {
      const endpoint = type === 'dub' ? `${API}/dub/history/${id}` : `${API}/history/${id}`;
      await fetch(endpoint, { method: 'DELETE' });
      if (type === 'dub') {
        loadDubHistory();
      } else {
        loadHistory();
      }
      toast.success(i18n.t('app.toast_history_deleted'));
    } catch (err) {
      toast.error(err.message);
    }
  };


  // Install-plan screen outranks everything — both on a true first run and
  // when explicitly requested via `--setup`. Without this, a live backend
  // answering /setup/status would route straight to the model wizard and the
  // awaiting_setup stage would never get to render.
  if (bootstrapStage === 'awaiting_setup') {
    return (
      <div style={{ zoom: uiScale }}>
        <BootstrapSplash stage={bootstrapStage} message={bootstrapMessage} />
      </div>
    );
  }
  // First-run gate: if /setup/status says models aren't on disk yet, render
  // the wizard instead of the main studio. Dismisses itself once the user
  // completes the download (or clicks "Skip" if they want to limp along).
  // Also blocks render until we've heard back from the backend at least once
  // — the frozen sidecar's cold-start import is ~5-10 s and without this we
  // flash the empty studio before the wizard has a chance to mount.
  if (!setupChecked) {
    return (
      <div style={{ zoom: uiScale }}>
        <BootstrapSplash stage={bootstrapStage} message={bootstrapMessage} />
        <Suspense fallback={null}>
          <LogsFooter />
        </Suspense>
      </div>
    );
  }
  if (setupNeeded && bootstrapStage === 'ready') {
    // Render outside the `app-container` grid so the wizard spans the full
    // viewport instead of getting squeezed into whatever grid cell the
    // studio layout reserves for the main content column. Gated on the
    // bootstrap being 'ready': while the stage is still settling (checking /
    // awaiting_setup racing the first poll), the wizard must not steal the
    // mount from the install-plan screen.
    return (
      <div
        className="app-wizard-wrap"
        style={{ zoom: uiScale }}
      >
        {/* Invisible drag strip across the top 28 px of the wizard —
            matches the macOS traffic-light zone so the window can be
            dragged / double-click-zoomed from anywhere along the top. */}
        {/* Double-click-to-maximize is handled globally in main.jsx for every
            drag region (splash, first-run, wizard, main) on all platforms. */}
        <div
          data-tauri-drag-region
          className="app-wizard-dragstrip"
        />
        <Suspense fallback={<LazyFallback />}>
          <SetupWizard onReady={() => {
            // First-sound handoff: the studio's first act after onboarding is
            // to speak. sessionStorage (not localStorage) so it never replays
            // on later launches — only on the run that finished the wizard.
            try { sessionStorage.setItem('omnivoice.firstSound', '1'); } catch { /* private mode */ }
            setSetupNeeded(false);
          }} />
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
        <ErrorBoundary name="audio-trimmer">
          <Suspense fallback={<LazyFallback />}>
            <AudioTrimmer
              file={pendingTrimFile}
              maxSeconds={CLONE_MAX_SECONDS}
              onCancel={() => setPendingTrimFile(null)}
              onConfirm={(trimmed) => { setPendingTrimFile(null); setRefAudio(trimmed); setSelectedProfile(null); toast.success(i18n.t('app.trimmed_loaded')); }}
            />
          </Suspense>
        </ErrorBoundary>
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
            toast.success(i18n.t('app.toast_flushed', {
              ram: r.ram_after,
              vram: r.vram_after,
              unloaded: r.unloaded_model ? i18n.t('app.toast_model_unloaded') : '',
            }));
          } catch (e) { toast.error(i18n.t('app.toast_flush_failed', { message: e.message })); }
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
        ) : mode === 'transcriptions' ? (
          <ErrorBoundary name="transcriptions">
            <Suspense fallback={<LazyFallback />}>
              <TranscriptionsPage />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'stories' ? (
          <ErrorBoundary name="stories">
            <Suspense fallback={<LazyFallback />}>
              <StoriesEditor profiles={profiles} />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'donate' ? (
          <ErrorBoundary name="donate">
            <Suspense fallback={<LazyFallback />}>
              <SupportPage initialView="support" onBack={() => setMode('launchpad')} />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'enterprise' ? (
          <ErrorBoundary name="enterprise">
            <Suspense fallback={<LazyFallback />}>
              <SupportPage initialView="license" onBack={() => setMode('launchpad')} />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'launchpad' ? (
          <ErrorBoundary name="launchpad">
          <Suspense fallback={<LazyFallback />}>
            <Launchpad
              profiles={profiles}
              studioProjects={studioProjects}
              dubHistory={dubHistory}
              exportHistory={exportHistory}
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
              handleDubImportSrt={handleDubImportSrt}
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
