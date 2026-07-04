import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  Suspense,
  lazy,
} from 'react';
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
const ContactPage = lazy(() => import('./pages/ContactPage'));
const TranscriptionsPage = lazy(() => import('./pages/Transcriptions'));
const StoriesEditor = lazy(() => import('./components/StoriesEditor'));
const AudiobookTab = lazy(() => import('./pages/AudiobookTab'));

import Header from './components/Header';
import NavRail from './components/NavRail';
import WorkspaceHistory from './components/WorkspaceHistory';
import WorkspaceVoices from './components/WorkspaceVoices';
import WorkspaceProjects from './components/WorkspaceProjects';
import ErrorBoundary from './components/ErrorBoundary';
import FloatingPill from './components/FloatingPill';
// RemoteAuthGate is mounted at the true outermost provider in main-app.jsx so
// it covers all app states (setup check / wizard / bootstrap), not just the
// main studio return below. Do not re-wrap here — double-gating renders two
// PIN dialogs.

import { BootstrapSplash, useBootstrapStage } from './components/BootstrapSplash';

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
import { recordValueMoment } from './utils/donationMoments';
import {
  POPULAR_LANGS,
  POPULAR_ISO,
  TAGS,
  CATEGORIES,
  PRESETS,
  CLONE_MAX_SECONDS,
} from './utils/constants';
import { LANG_CODES } from './utils/languages';
import { API, apiFetch } from './api/client';
import { flushMemory as apiFlushMemory } from './api/system';
import {
  saveProject as apiSaveProject,
  loadProject as apiLoadProject,
  deleteProject as apiDeleteProject,
  renameProject as apiRenameProject,
} from './api/projects';
import { exportAction, exportReveal, exportRecord } from './api/exports';

import { isTauri, doubleClickMaximize, fileToMediaUrl, playBlobAudio } from './utils/media';
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
  const uiScale = useAppStore((s) => s.uiScale);

  // Responsive shell breakpoints driven off the app-container's OWN width, not
  // the viewport. The shell is sized `width: calc(100vw / --ui-scale)` then
  // `zoom: --ui-scale` (#504; the WebKitGTK no-op case is handled by the
  // data-zoom-layout probe below), so the grid lays out against `100vw/scale` —
  // which `el.clientWidth` reports. Viewport `@media` queries fire on raw
  // `100vw` and so collapse at the wrong threshold whenever the UI scale ≠ 1,
  // cramming the content into a sliver. ResizeObserver fires on both window
  // resize and scale change (the calc width changes), so this stays correct.
  const shellRef = useRef(null);
  const [shellWidth, setShellWidth] = useState(Infinity);
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setShellWidth(el.clientWidth));
    ro.observe(el);
    setShellWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Engine capability probe (#523/#524): does this WebView honor `zoom` as a
  // LAYOUT transform? Chromium (WebView2 / macOS WebKit) and modern WebKitGTK
  // do; older WebKitGTK (Linux) treats it as a no-op. The .app-container sizing
  // branches on the result (index.css) so the shell fills the window on BOTH —
  // no black band on WebKitGTK, no clipped Generate/Settings CTAs on Chromium.
  // Measuring a real zoomed element is robust where @supports(zoom)/UA-sniffing
  // aren't (both report "supported" on WebKitGTK even when zoom doesn't lay out).
  useLayoutEffect(() => {
    let honored = true;
    try {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:100px;height:100px;zoom:2';
      document.body.appendChild(probe);
      honored = Math.round(probe.getBoundingClientRect().width) >= 150;
      probe.remove();
    } catch {
      honored = true;
    } // safe default: the existing zoom path
    document.documentElement.dataset.zoomLayout = honored ? 'on' : 'off';
  }, []);
  const shellSizeClass =
    shellWidth <= 600 ? 'shell-mini' : shellWidth <= 1100 ? 'shell-narrow' : '';
  const theme = useAppStore((s) => s.theme);

  const locale = useAppStore((s) => s.locale);
  const font = useAppStore((s) => s.font);

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
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  // "Define voice" method inside the Voice (studio) workspace — replaces the
  // old clone/design navigation split (voice-studio-unification P4).
  const defineMethod = useAppStore((s) => s.defineMethod);
  const setDefineMethod = useAppStore((s) => s.setDefineMethod);
  // Breadcrumb every view change — mode names are a closed set, so this is
  // privacy-safe by construction (see utils/breadcrumbs.js).
  useEffect(() => {
    addBreadcrumb(`view:${mode}`);
  }, [mode]);
  const [navRailSide, setNavRailSide] = useState(() => {
    try {
      return localStorage.getItem('omnivoice.navRailSide') || 'left';
    } catch {
      return 'left';
    }
  });
  const showCheatsheet = useAppStore((s) => s.showCheatsheet);
  const setShowCheatsheet = useAppStore((s) => s.setShowCheatsheet);

  // Global '?' → open cheatsheet
  useEffect(() => {
    const h = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShowCheatsheet((v) => !v);
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
      } catch {
        /* not in Tauri */
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [setMode]);
  const flipNavRailSide = useCallback(() => {
    setNavRailSide((prev) => {
      const next = prev === 'left' ? 'right' : 'left';
      try {
        localStorage.setItem('omnivoice.navRailSide', next);
      } catch {}
      return next;
    });
  }, []);
  // Voice-profile navigation — slice owns "remember where I was" for Back.
  const activeVoiceId = useAppStore((s) => s.activeVoiceId);
  const openVoiceProfile = useAppStore((s) => s.openVoiceProfile);
  const closeVoiceProfile = useAppStore((s) => s.closeVoiceProfile);
  const hideSidebar =
    mode === 'launchpad' ||
    mode === 'settings' ||
    mode === 'voice' ||
    mode === 'donate' ||
    mode === 'queue' ||
    mode === 'tools' ||
    mode === 'projects' ||
    mode === 'gallery' ||
    mode === 'enterprise' ||
    mode === 'contact' ||
    mode === 'transcriptions' ||
    mode === 'stories' ||
    mode === 'audiobook' ||
    // Voice (studio) and Dub workspaces moved their saved voices /
    // projects + history into right-side panels; left sidebar dissolved.
    mode === 'studio' ||
    mode === 'dub';
  const availableSidebarTabs = [];
  // Generate-tab prefs now live in `generateSlice` (Phase 2.2). Persisted
  // knobs survive reloads via the store's `partialize`.
  const text = useAppStore((s) => s.text);
  const setText = useAppStore((s) => s.setText);
  const refText = useAppStore((s) => s.refText);
  const setRefText = useAppStore((s) => s.setRefText);
  const instruct = useAppStore((s) => s.instruct);
  const setInstruct = useAppStore((s) => s.setInstruct);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);

  const speed = useAppStore((s) => s.speed);
  const setSpeed = useAppStore((s) => s.setSpeed);
  const steps = useAppStore((s) => s.steps);
  const setSteps = useAppStore((s) => s.setSteps);
  const cfg = useAppStore((s) => s.cfg);
  const setCfg = useAppStore((s) => s.setCfg);
  const denoise = useAppStore((s) => s.denoise);
  const setDenoise = useAppStore((s) => s.setDenoise);
  const tShift = useAppStore((s) => s.tShift);
  const setTShift = useAppStore((s) => s.setTShift);
  const posTemp = useAppStore((s) => s.posTemp);
  const setPosTemp = useAppStore((s) => s.setPosTemp);
  const classTemp = useAppStore((s) => s.classTemp);
  const setClassTemp = useAppStore((s) => s.setClassTemp);
  const layerPenalty = useAppStore((s) => s.layerPenalty);
  const setLayerPenalty = useAppStore((s) => s.setLayerPenalty);
  const postprocess = useAppStore((s) => s.postprocess);
  const setPostprocess = useAppStore((s) => s.setPostprocess);
  const duration = useAppStore((s) => s.duration);
  const setDuration = useAppStore((s) => s.setDuration);
  const vdStates = useAppStore((s) => s.vdStates);
  const setVdStates = useAppStore((s) => s.setVdStates);

  // ═══ EXTRACTED HOOKS ═══
  const {
    profiles,
    history,
    dubHistory,
    studioProjects,
    exportHistory,
    showOverrides,
    setShowOverrides,
    modelStatus,
    loadProfiles,
    loadHistory,
    loadDubHistory,
    loadProjects,
    loadExportHistory,
  } = useAppData();

  const {
    selectedProfile,
    setSelectedProfile,
    showSaveProfile,
    setShowSaveProfile,
    profileName,
    setProfileName,
    previewLoading,
    segmentPreviewLoading,
    isVoicePreviewOpen,
    setIsVoicePreviewOpen,
    voicePreviewProfileId,
    setVoicePreviewProfileId,
    handleSaveProfile: _handleSaveProfile,
    handleSaveDesignProfile,
    handleDeleteProfile,
    handleSelectProfile,
    handlePreviewVoice,
    handleSegmentPreview,
    handleSaveHistoryAsProfile,
    handleLockProfile,
    handleUnlockProfile,
  } = useProfiles({ loadHistory, loadProfiles });

  const {
    refAudio,
    setRefAudio,
    pendingTrimFile,
    setPendingTrimFile,
    isGenerating,
    generationTime,
    textAreaRef,
    ingestRefAudio,
    insertTag,
    applyPreset,
    handleGenerate,
  } = useTTS({ selectedProfile, setSelectedProfile, loadHistory, profiles });

  const handleSaveProfile = () => _handleSaveProfile(refAudio, refText, instruct, language);

  // ═══ PENDING PROFILE HAND-OFF ═══
  // Views like the Gallery hand a freshly-created profile to the synthesis view
  // via store.pendingProfileId + setMode('studio'). The profile may not be in the
  // loaded list yet (it arrives via loadProfiles / the realtime `profiles` event),
  // so we wait for it to appear, select it, then clear the hand-off.
  const pendingProfileId = useAppStore((s) => s.pendingProfileId);
  const setPendingProfileId = useAppStore((s) => s.setPendingProfileId);
  // Stories projects (storiesSlice) — surfaced in the global Projects view so a
  // saved story is openable from OmniDrive, like dub projects.
  const storyProjects = useAppStore((s) => s.storyProjects);
  const loadStoryProject = useAppStore((s) => s.loadProject);
  const pendingRefreshRef = useRef(null);
  useEffect(() => {
    if (!pendingProfileId) {
      pendingRefreshRef.current = null;
      return;
    }
    const prof = profiles.find((p) => p.id === pendingProfileId);
    if (prof) {
      handleSelectProfile(prof);
      setPendingProfileId(null);
      pendingRefreshRef.current = null;
      return;
    }
    // Not loaded yet — refresh the list once; the effect re-runs when it arrives.
    if (pendingRefreshRef.current !== pendingProfileId) {
      pendingRefreshRef.current = pendingProfileId;
      loadProfiles();
    }
  }, [pendingProfileId, profiles, handleSelectProfile, loadProfiles, setPendingProfileId]);

  // A/B Voice Comparison State
  const [isCompareModalOpen, setIsCompareModalOpen] = useState(false);
  const [compareVoiceA, setCompareVoiceA] = useState('');
  const [compareVoiceB, setCompareVoiceB] = useState('');
  const [compareText, setCompareText] = useState(
    'The quick brown fox jumps over the lazy dog, proving that this voice sounds much better.',
  );
  const [compareResultA, setCompareResultA] = useState(null);
  const [compareResultB, setCompareResultB] = useState(null);
  const [isComparing, setIsComparing] = useState(false);
  const [compareProgress, setCompareProgress] = useState('');

  // ═══ MIC RECORDING ═══
  const { isRecording, isCleaning, recordingTime, startRecording, stopRecording } =
    useRecording(ingestRefAudio);

  // ═══ DUB STATE ═══
  const dubJobId = useAppStore((s) => s.dubJobId);
  const setDubJobId = useAppStore((s) => s.setDubJobId);
  const dubStep = useAppStore((s) => s.dubStep);
  const setDubStep = useAppStore((s) => s.setDubStep);
  const dubSegments = useAppStore((s) => s.dubSegments);
  const setDubSegments = useAppStore((s) => s.setDubSegments);
  const dubLang = useAppStore((s) => s.dubLang);
  const setDubLang = useAppStore((s) => s.setDubLang);
  const dubLangCode = useAppStore((s) => s.dubLangCode);
  const setDubLangCode = useAppStore((s) => s.setDubLangCode);
  const dubDialect = useAppStore((s) => s.dubDialect);
  const setDubDialect = useAppStore((s) => s.setDubDialect);
  const dubInstruct = useAppStore((s) => s.dubInstruct);
  const setDubInstruct = useAppStore((s) => s.setDubInstruct);
  const setDubProgress = useAppStore((s) => s.setDubProgress);
  const dubFilename = useAppStore((s) => s.dubFilename);
  const setDubFilename = useAppStore((s) => s.setDubFilename);
  const dubDuration = useAppStore((s) => s.dubDuration);
  const setDubDuration = useAppStore((s) => s.setDubDuration);
  const setDubError = useAppStore((s) => s.setDubError);
  const dubTracks = useAppStore((s) => s.dubTracks);
  const setDubTracks = useAppStore((s) => s.setDubTracks);
  const dubTranscript = useAppStore((s) => s.dubTranscript);
  const setDubTranscript = useAppStore((s) => s.setDubTranscript);
  const preserveBg = useAppStore((s) => s.preserveBg);
  const setPreserveBg = useAppStore((s) => s.setPreserveBg);
  const defaultTrack = useAppStore((s) => s.defaultTrack);
  const setDefaultTrack = useAppStore((s) => s.setDefaultTrack);
  const exportTracks = useAppStore((s) => s.exportTracks);
  const previewSegIds = useAppStore((s) => s.previewSegIds);
  const speakerClones = useAppStore((s) => s.speakerClones);
  const setSpeakerClones = useAppStore((s) => s.setSpeakerClones);

  const setGlossaryTerms = useAppStore((s) => s.setGlossaryTerms);
  const dualSubs = useAppStore((s) => s.dualSubs);
  const burnSubs = useAppStore((s) => s.burnSubs);

  // ── UNDO / REDO + SEGMENT EDITING ──
  // Must come before useDubWorkflow because the dub generate handler needs
  // setLastGenFingerprints to keep the incremental-regen plan in sync.
  const {
    undo,
    redo,
    editSegments,
    segmentEditField,
    segmentDelete,
    segmentRestoreOriginal,
    segmentSplit,
    segmentMerge,
    segmentMoveResize,
    timelineSelSegId,
    setTimelineSelSegId,
    selectedSegIds,
    toggleSegSelect,
    selectAllSegs,
    clearSegSelection,
    bulkApplyToSelected,
    bulkDeleteSelected,
    directionSegId,
    openDirection,
    closeDirection,
    saveDirection,
    setLastGenFingerprints,
    incrementalPlan,
    recomputeIncremental,
  } = useSegmentEditing();

  useEffect(() => {
    recomputeIncremental();
  }, [recomputeIncremental]);

  const {
    translateProvider,
    setTranslateProvider,
    showTranscript,
    setShowTranscript,
    setPreviewAudios,
    transcribeElapsed,
    handleDubUpload: _handleDubUpload,
    handleDubIngestUrl,
    handleDubAbort,
    handleDubRetryTranscribe,
    handleDubStop,
    handleDubGenerate,
    handleCleanupSegments,
    handleTranslateAll,
    handleDubImportSrt,
  } = useDubWorkflow({ loadProjects, loadProfiles, loadDubHistory, setLastGenFingerprints });

  const [dubVideoFile, setDubVideoFile] = useState(null);
  const [dubLocalBlobUrl, setDubLocalBlobUrl] = useState(null);
  const dubBlobUrlRef = useRef(null);
  useEffect(() => {
    dubBlobUrlRef.current = dubLocalBlobUrl;
  }, [dubLocalBlobUrl]);
  useEffect(
    () => () => {
      const urls = dubBlobUrlRef.current;
      if (urls?.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(urls.videoUrl);
      if (urls?.audioUrl?.startsWith('blob:') && urls.audioUrl !== urls.videoUrl)
        URL.revokeObjectURL(urls.audioUrl);
    },
    [],
  );

  const handleDubUpload = () => _handleDubUpload(dubVideoFile);

  // ═══ STUDIO PROJECTS ═══
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const activeProjectName = useAppStore((s) => s.activeProjectName);
  const setActiveProject = useAppStore((s) => s.setActiveProject);
  const sidebarTab = useAppStore((s) => s.sidebarTab);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);

  // Snap sidebar to a valid tab when view changes
  useEffect(() => {
    if (availableSidebarTabs.length && !availableSidebarTabs.includes(sidebarTab)) {
      setSidebarTab(availableSidebarTabs[0]);
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const isSidebarProjectsCollapsed = useAppStore((s) => s.isSidebarProjectsCollapsed);
  const setIsSidebarProjectsCollapsed = useAppStore((s) => s.setIsSidebarProjectsCollapsed);
  const isSidebarCollapsed = useAppStore((s) => s.isSidebarCollapsed);
  const setIsSidebarCollapsed = useAppStore((s) => s.setIsSidebarCollapsed);

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
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (!cancelled) setSetupChecked(true);
    })();
    return () => {
      cancelled = true;
    };
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
    } catch {
      /* private mode */
    }
    if (!pending) return;
    (async () => {
      try {
        const fd = new FormData();
        fd.append('text', i18n.t('firstrun.first_sound_text'));
        // Functional model prompt (not user-facing copy) — keeps the demo
        // voice warm without depending on seeded profiles.
        fd.append('instruct', 'A warm, friendly narrator voice, medium pace');
        fd.append('num_step', '16');
        const res = await apiFetch(`${API}/generate`, { method: 'POST', body: fd });
        const blob = await res.blob();
        await playBlobAudio(blob);
        toast.success(i18n.t('firstrun.first_sound_done'), { duration: 7000 });
      } catch {
        /* silent — see above */
      }
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
    // Non-blocking: surface update availability into the store so the user can
    // choose to install + restart (with a progress bar) from Settings → Updates,
    // so an update never interrupts in-flight work.
    fetchAppVersion().then((v) => useAppStore.getState().setAppVersion(v));
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
        fileToMediaUrl(file, null).then((urls) => setDubLocalBlobUrl(urls));
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
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    // Browser / Docker web build: there is no Tauri shell, so the native save
    // dialog is unavailable — invoking it throws "Cannot read properties of
    // undefined (reading 'invoke')" (issue #256). Fall back to a plain HTTP
    // blob download of the file already served at /audio/<path>.
    if (!isTauri) {
      const niceName = (fallbackName || sourceIdentifier || 'audio').split('/').pop();
      try {
        const finalName = await browserDownload(`${API}/audio/${sourceIdentifier}`, niceName);
        toast.success(i18n.t('app.toast_downloaded', { name: finalName }));
        recordValueMoment('export'); // success-only donation moment
        try {
          await exportRecord({
            filename: finalName,
            destination_path: `~/Downloads/${finalName}`,
            mode,
          });
          loadExportHistory();
        } catch (err) {
          console.warn('exportRecord (browser export path) failed:', err);
        }
      } catch (err) {
        console.error(err);
        toastErrorWithReport(
          i18n.t('app.toast_export_failed', { message: err?.message || err }),
          err,
        );
      }
      return;
    }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const ext = fallbackName.includes('.') ? fallbackName.split('.').pop() : 'wav';
      const destPath = await save({
        defaultPath: fallbackName,
        filters: [{ name: 'Media', extensions: [ext] }],
      });
      if (!destPath) return; // User cancelled

      await exportAction({ source_filename: sourceIdentifier, destination_path: destPath, mode });
      toast.success(i18n.t('app.toast_exported', { name: fallbackName }));
      recordValueMoment('export'); // success-only donation moment
      loadExportHistory();
    } catch (err) {
      console.error(err);
      toastErrorWithReport(
        i18n.t('app.toast_export_failed', { message: err?.message || err }),
        err,
      );
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
    const extGuess = (
      fallbackName.includes('.') ? fallbackName.split('.').pop() : 'bin'
    ).toLowerCase();
    const modeGuess = ['mp4', 'mov', 'mkv', 'webm'].includes(extGuess)
      ? 'video'
      : ['wav', 'mp3', 'flac'].includes(extGuess)
        ? 'audio'
        : 'file';

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
          const res = await apiFetch(url);
          const text = await res.text();
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('save_text_file', { path: destPath, contents: text });
          toast.success(i18n.t('app.toast_saved', { path: destPath }), { id: fallbackName });
          recordValueMoment('export'); // success-only donation moment
          try {
            await exportRecord({
              filename: fallbackName,
              destination_path: destPath,
              mode: modeGuess,
            });
            loadExportHistory();
          } catch (err) {
            console.warn('exportRecord (subtitle save) failed:', err);
          }
          return;
        }

        const sep = url.includes('?') ? '&' : '?';
        const res = await apiFetch(`${url}${sep}save_path=${encodeURIComponent(destPath)}`);
        // Every save_path-aware endpoint returns a JSON envelope. Guard the
        // content-type so a raw-body response surfaces as a clear error
        // instead of a cryptic JSON.parse failure (#309).
        const ctype = res.headers.get('content-type') || '';
        if (!ctype.includes('application/json')) {
          throw new Error(
            `Server returned ${ctype || 'an unknown content type'} instead of a JSON save confirmation`,
          );
        }
        const data = await res.json();
        toast.success(i18n.t('app.toast_saved', { path: data.path }), { id: fallbackName });
        recordValueMoment('export'); // success-only donation moment
        try {
          await exportRecord({
            filename: data.display_name || fallbackName,
            destination_path: data.path,
            mode: modeGuess,
          });
          loadExportHistory();
        } catch (err) {
          console.warn('exportRecord (Tauri save path) failed:', err);
        }
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
      recordValueMoment('export'); // success-only donation moment
      try {
        await exportRecord({
          filename: finalName,
          destination_path: `~/Downloads/${finalName}`,
          mode: modeGuess,
        });
        loadExportHistory();
      } catch (err) {
        console.warn('exportRecord (browser download path) failed:', err);
      }
    } catch (err) {
      console.error(err);
      toast.error(i18n.t('app.toast_download_error', { message: err.message }), {
        id: fallbackName,
      });
    }
  };
  // Pre-flight for audio/video exports. If any segments are at preview
  // quality (num_step=8, from a "Regen changed" click), re-render those at
  // full quality first so the user's exported file isn't carrying preview
  // artifacts. No-op when previewSegIds is empty.
  const finalizeTtsBeforeExport = async () => {
    if (!previewSegIds || previewSegIds.length === 0) return;
    toast(i18n.t('dub.upgrading_preview', { count: previewSegIds.length }));
    await handleDubGenerate({ regenOnly: previewSegIds, preview: false });
  };
  const handleDubDownload = async () => {
    await finalizeTtsBeforeExport();
    // Build selected tracks from all known tracks, matching the checkbox `!== false` logic
    const selected = [];
    if (exportTracks['original'] !== false) selected.push('original');
    dubTracks.forEach((t) => {
      if (exportTracks[t] !== false) selected.push(t);
    });
    const tracksParam = selected.join(',');
    const burnParam = burnSubs ? `&burn_subs=1&dual=${dualSubs ? 1 : 0}` : '';
    triggerDownload(
      `${API}/dub/download/${dubJobId}/dubbed_video.mp4?preserve_bg=${preserveBg}&default_track=${defaultTrack}&include_tracks=${encodeURIComponent(tracksParam)}${burnParam}`,
      'dubbed_video.mp4',
    );
  };
  const handleDubAudioDownload = async () => {
    await finalizeTtsBeforeExport();
    triggerDownload(
      `${API}/dub/download-audio/${dubJobId}/dubbed_audio.wav?preserve_bg=${preserveBg}`,
      'dubbed_audio.wav',
    );
  };
  // Generic audio export wrapper — MP3, Clips, Stems all need preview segs
  // upgraded before mux. Subtitle exports (SRT/VTT) skip this.
  const handleAudioExport = async (url, filename) => {
    await finalizeTtsBeforeExport();
    triggerDownload(url, filename);
  };
  const resetDub = () => {
    setDubJobId(null);
    setDubStep('idle');
    setDubSegments([]);
    setDubFilename('');
    setDubDuration(0);
    setDubError('');
    setDubVideoFile(null);
    setDubTracks([]);
    setDubProgress({ current: 0, total: 0, text: '' });
    setDubTranscript('');
    setShowTranscript(false);
    setPreviewAudios({});
    setDubLocalBlobUrl((prev) => {
      if (prev?.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(prev.videoUrl);
      if (prev?.audioUrl?.startsWith('blob:') && prev.audioUrl !== prev.videoUrl)
        URL.revokeObjectURL(prev.audioUrl);
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
        dubJobId,
        dubFilename,
        dubDuration,
        dubSegments,
        dubLang,
        dubLangCode,
        dubDialect,
        dubInstruct,
        dubTracks,
        dubStep,
        dubTranscript,
        preserveBg,
        defaultTrack,
        speakerClones,
      },
    };
    try {
      const data = await apiSaveProject(statePayload, activeProjectId);
      setActiveProject(data.id, name);
      toast.success(
        activeProjectId ? i18n.t('app.toast_project_saved') : i18n.t('app.toast_project_created'),
      );
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
      setDubSegments(
        (s.dubSegments || []).map((x) => ({
          ...x,
          text_original: x.text_original || x.text || '',
        })),
      );
      setDubLang(s.dubLang || 'Auto');
      setDubLangCode(s.dubLangCode || 'en');
      setDubDialect(s.dubDialect || '');
      setDubInstruct(s.dubInstruct || '');
      setDubTracks(s.dubTracks || []);
      setDubTranscript(s.dubTranscript || '');
      setPreserveBg(s.preserveBg !== undefined ? s.preserveBg : true);
      setDefaultTrack(s.defaultTrack !== undefined ? s.defaultTrack : 'original');
      setDubStep(s.dubStep === 'done' ? 'done' : s.dubSegments?.length ? 'editing' : 'idle');
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
    } catch (err) {
      toast.error(err.message);
    }
  };

  const renameProject = async (projectId, nextName) => {
    const name = (nextName || '').trim();
    if (!name) return;
    try {
      await apiRenameProject(projectId, name);
      if (activeProjectId === projectId) setActiveProject(projectId, name);
      loadProjects();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const restoreDubHistory = (item) => {
    try {
      if (!item.job_data) return;
      const job = JSON.parse(item.job_data);
      setMode('dub');
      setDubJobId(item.id);
      setDubFilename(job.filename || '');
      setDubDuration(job.duration || 0);
      setDubSegments(
        (job.segments || []).map((s, i) => ({
          ...s,
          id: s.id != null ? String(s.id) : String(i),
          text_original: s.text_original || s.text || '',
        })),
      );
      setDubTranscript(job.full_transcript || '');
      // Older DBs froze the language/language_code COLUMNS at the ingest-time
      // "" (the UPSERT didn't update them until #P0 fixed it), but the job_data
      // JSON always carried the value generation set. Falling back to job_data
      // restores existing rows correctly without a migration.
      setDubLang(item.language || job.language || 'Auto');
      setDubLangCode(item.language_code || job.language_code || 'und');
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
      console.error('Failed to restore job_data', e);
    }
  };

  const restoreHistory = (item) => {
    // History `mode` values stay 'clone'/'design' forever — only the
    // navigation mode id changed. Map them onto the unified 'studio'
    // workspace + its define method (voice-studio-unification P4).
    if (item.mode === 'clone' || item.mode === 'design') {
      setMode('studio');
      setDefineMethod(item.mode === 'clone' ? 'audio' : 'design');
    } else if (item.mode) {
      setMode(item.mode);
    }
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
      await apiFetch(endpoint, { method: 'DELETE' });
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
      <div className="app-wizard-wrap" style={{ zoom: uiScale }}>
        {/* Invisible drag strip across the top 28 px of the wizard —
            matches the macOS traffic-light zone so the window can be
            dragged / double-click-zoomed from anywhere along the top. */}
        {/* Double-click-to-maximize is handled globally in main.jsx for every
            drag region (splash, first-run, wizard, main) on all platforms. */}
        <div data-tauri-drag-region className="app-wizard-dragstrip" />
        <Suspense fallback={<LazyFallback />}>
          <SetupWizard
            onReady={() => {
              // First-sound handoff: the studio's first act after onboarding is
              // to speak. sessionStorage (not localStorage) so it never replays
              // on later launches — only on the run that finished the wizard.
              try {
                sessionStorage.setItem('omnivoice.firstSound', '1');
              } catch {
                /* private mode */
              }
              setSetupNeeded(false);
            }}
          />
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
      ref={shellRef}
      className={[
        'app-container',
        isSidebarCollapsed ? 'sidebar-collapsed' : '',
        hideSidebar ? 'sidebar-hidden' : '',
        navRailSide === 'right' ? 'rail-right' : '',
        shellSizeClass,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--ui-scale': uiScale }}
    >
      {pendingTrimFile && (
        <ErrorBoundary name="audio-trimmer">
          <Suspense fallback={<LazyFallback />}>
            <AudioTrimmer
              file={pendingTrimFile}
              maxSeconds={CLONE_MAX_SECONDS}
              onCancel={() => setPendingTrimFile(null)}
              onConfirm={(trimmed) => {
                setPendingTrimFile(null);
                setRefAudio(trimmed);
                setSelectedProfile(null);
                toast.success(i18n.t('app.trimmed_loaded'));
              }}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: 'rgba(40,40,40,0.9)',
            backdropFilter: 'blur(10px)',
            color: '#ebdbb2',
            border: '1px solid rgba(255,255,255,0.08)',
            fontSize: '0.72rem',
            padding: '4px 8px',
          },
          error: { iconTheme: { primary: '#fb4934', secondary: '#fff' } },
          success: { iconTheme: { primary: '#b8bb26', secondary: '#fff' } },
        }}
      />

      <FloatingPill />

      <Header
        mode={mode}
        setMode={setMode}
        modelStatus={modelStatus}
        doubleClickMaximize={doubleClickMaximize}
        activeProjectName={activeProjectName}
        onFlushMemory={async (unloadModel) => {
          try {
            const r = await apiFlushMemory(unloadModel);
            toast.success(
              i18n.t('app.toast_flushed', {
                ram: r.ram_after,
                vram: r.vram_after,
                unloaded: r.unloaded_model ? i18n.t('app.toast_model_unloaded') : '',
              }),
            );
          } catch (e) {
            toast.error(i18n.t('app.toast_flush_failed', { message: e.message }));
          }
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
                onOpenProject={(id) => {
                  loadProject(id);
                }}
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
                storyProjects={storyProjects}
                onOpenDub={(id) => {
                  loadProject(id);
                  setMode('dub');
                }}
                onOpenProfile={(id) => {
                  openVoiceProfile(id);
                }}
                onOpenStory={(id) => {
                  loadStoryProject(id);
                  setMode('stories');
                }}
                onRevealExport={(path) => {
                  exportReveal({ path }).catch(() => {});
                }}
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
        ) : mode === 'audiobook' ? (
          <ErrorBoundary name="audiobook">
            <Suspense fallback={<LazyFallback />}>
              <AudiobookTab profiles={profiles} />
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
        ) : mode === 'contact' ? (
          <ErrorBoundary name="contact">
            <Suspense fallback={<LazyFallback />}>
              <ContactPage onBack={() => setMode('launchpad')} />
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
          <div
            className={`studio-with-history ${dubStep === 'idle' ? '' : 'studio-with-history--editing'}`}
          >
            <div className="studio-with-history__main">
              <ErrorBoundary name="dub">
                <Suspense fallback={<LazyFallback />}>
                  <DubTab
                    // Non-serialisable / local state only — all pipeline fields now
                    // flow through the Zustand store.
                    dubVideoFile={dubVideoFile}
                    dubLocalBlobUrl={dubLocalBlobUrl}
                    transcribeElapsed={transcribeElapsed}
                    translateProvider={translateProvider}
                    setTranslateProvider={setTranslateProvider}
                    onGlossaryChange={setGlossaryTerms}
                    showTranscript={showTranscript}
                    setShowTranscript={setShowTranscript}
                    profiles={profiles}
                    segmentPreviewLoading={segmentPreviewLoading}
                    selectedSegIds={selectedSegIds}
                    setDubVideoFile={setDubVideoFile}
                    setDubLocalBlobUrl={setDubLocalBlobUrl}
                    // Handlers — close over App.jsx scope so stay prop-threaded.
                    handleDubAbort={handleDubAbort}
                    handleDubUpload={handleDubUpload}
                    handleDubIngestUrl={handleDubIngestUrl}
                    handleDubRetryTranscribe={handleDubRetryTranscribe}
                    handleDubStop={handleDubStop}
                    handleDubGenerate={handleDubGenerate}
                    handleDubDownload={handleDubDownload}
                    handleDubAudioDownload={handleDubAudioDownload}
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
                    saveProject={saveProject}
                    resetDub={resetDub}
                    segmentEditField={segmentEditField}
                    segmentDelete={segmentDelete}
                    segmentRestoreOriginal={segmentRestoreOriginal}
                    segmentSplit={segmentSplit}
                    segmentMerge={segmentMerge}
                    segmentMoveResize={segmentMoveResize}
                    timelineSelSegId={timelineSelSegId}
                    setTimelineSelSegId={setTimelineSelSegId}
                    toggleSegSelect={toggleSegSelect}
                    selectAllSegs={selectAllSegs}
                    clearSegSelection={clearSegSelection}
                    bulkApplyToSelected={bulkApplyToSelected}
                    bulkDeleteSelected={bulkDeleteSelected}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>
            {/* Dub home: the Projects + History landing shows only when no project
              is being edited. Opening/creating one switches to the full-width
              editor (dubStep !== 'idle'). */}
            {dubStep === 'idle' && (
              <div className="studio-right">
                <WorkspaceProjects
                  projects={studioProjects}
                  activeProjectId={activeProjectId}
                  canSave={dubStep !== 'idle' || !!dubVideoFile}
                  saveProject={saveProject}
                  loadProject={loadProject}
                  deleteProject={deleteProject}
                  renameProject={renameProject}
                />
                <WorkspaceHistory
                  variant="dub"
                  dubHistory={dubHistory}
                  restoreDubHistory={restoreDubHistory}
                  deleteHistory={deleteHistory}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="studio-with-history">
            <div className="studio-with-history__main">
              <ErrorBoundary name="clone-design">
                <Suspense fallback={<LazyFallback />}>
                  <CloneDesignTab
                    textAreaRef={textAreaRef}
                    text={text}
                    setText={setText}
                    language={language}
                    setLanguage={setLanguage}
                    steps={steps}
                    setSteps={setSteps}
                    cfg={cfg}
                    setCfg={setCfg}
                    speed={speed}
                    setSpeed={setSpeed}
                    tShift={tShift}
                    setTShift={setTShift}
                    posTemp={posTemp}
                    setPosTemp={setPosTemp}
                    classTemp={classTemp}
                    setClassTemp={setClassTemp}
                    layerPenalty={layerPenalty}
                    setLayerPenalty={setLayerPenalty}
                    duration={duration}
                    setDuration={setDuration}
                    denoise={denoise}
                    setDenoise={setDenoise}
                    postprocess={postprocess}
                    setPostprocess={setPostprocess}
                    showOverrides={showOverrides}
                    setShowOverrides={setShowOverrides}
                    isSidebarCollapsed={isSidebarCollapsed}
                    setIsSidebarCollapsed={setIsSidebarCollapsed}
                    profiles={profiles}
                    selectedProfile={selectedProfile}
                    setSelectedProfile={setSelectedProfile}
                    refAudio={refAudio}
                    refText={refText}
                    setRefText={setRefText}
                    instruct={instruct}
                    setInstruct={setInstruct}
                    profileName={profileName}
                    setProfileName={setProfileName}
                    showSaveProfile={showSaveProfile}
                    setShowSaveProfile={setShowSaveProfile}
                    isRecording={isRecording}
                    isCleaning={isCleaning}
                    recordingTime={recordingTime}
                    vdStates={vdStates}
                    setVdStates={setVdStates}
                    isGenerating={isGenerating}
                    generationTime={generationTime}
                    applyPreset={applyPreset}
                    insertTag={insertTag}
                    handleSelectProfile={handleSelectProfile}
                    handleDeleteProfile={handleDeleteProfile}
                    handleSaveProfile={handleSaveProfile}
                    handleSaveDesignProfile={handleSaveDesignProfile}
                    handleGenerate={handleGenerate}
                    startRecording={startRecording}
                    stopRecording={stopRecording}
                    ingestRefAudio={ingestRefAudio}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>
            <div className="studio-right">
              <WorkspaceVoices
                defineMethod={defineMethod}
                profiles={profiles}
                selectedProfile={selectedProfile}
                setSelectedProfile={setSelectedProfile}
                previewLoading={previewLoading}
                handleSelectProfile={handleSelectProfile}
                handleDeleteProfile={handleDeleteProfile}
                handlePreviewVoice={handlePreviewVoice}
                handleUnlockProfile={handleUnlockProfile}
                openVoiceProfile={openVoiceProfile}
                onOpenVoicePreview={(profileId) => {
                  setVoicePreviewProfileId(profileId || '');
                  setIsVoicePreviewOpen(true);
                }}
              />
              <WorkspaceHistory
                history={history}
                handleSaveHistoryAsProfile={handleSaveHistoryAsProfile}
                handleLockProfile={handleLockProfile}
                handleNativeExport={handleNativeExport}
                restoreHistory={restoreHistory}
                deleteHistory={deleteHistory}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── SIDEBAR ── */}
      <Suspense fallback={<LazyFallback />}>
        <Sidebar
          availableTabs={availableSidebarTabs}
          isSidebarProjectsCollapsed={isSidebarProjectsCollapsed}
          setIsSidebarProjectsCollapsed={setIsSidebarProjectsCollapsed}
          sidebarTab={sidebarTab}
          setSidebarTab={setSidebarTab}
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
        seg={directionSegId ? dubSegments.find((s) => s.id === directionSegId) : null}
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
            compareText={compareText}
            setCompareText={setCompareText}
            compareVoiceA={compareVoiceA}
            setCompareVoiceA={setCompareVoiceA}
            compareVoiceB={compareVoiceB}
            setCompareVoiceB={setCompareVoiceB}
            compareResultA={compareResultA}
            setCompareResultA={setCompareResultA}
            compareResultB={compareResultB}
            setCompareResultB={setCompareResultB}
            compareProgress={compareProgress}
            setCompareProgress={setCompareProgress}
            isComparing={isComparing}
            setIsComparing={setIsComparing}
            steps={steps}
            cfg={cfg}
            speed={speed}
            denoise={denoise}
            postprocess={postprocess}
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
