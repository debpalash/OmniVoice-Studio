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
import { NAV_ITEMS } from './components/navItems';
import SearchableSelect from './components/SearchableSelect';
import DirectionDialog from './components/DirectionDialog';
import ModeLifecycleBoundary from './components/ModeLifecycleBoundary';
import { resolveDubDefaultTrack } from './utils/dubDefaultTrack';

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
const UiScaleSetup = lazy(() => import('./components/UiScaleSetup'));
const KeyboardCheatsheet = lazy(() => import('./components/KeyboardCheatsheet'));
const VoicePreview = lazy(() => import('./components/VoicePreview'));
const LogsFooter = lazy(() => import('./components/LogsFooter'));
const ProjectsPage = lazy(() => import('./pages/Projects'));
const VoiceGallery = lazy(() => import('./pages/VoiceGallery'));
const SupportPage = lazy(() => import('./pages/SupportPage'));
const TranscriptionsPage = lazy(() => import('./pages/Transcriptions'));
const StoriesEditor = lazy(() => import('./components/StoriesEditor'));
const AudiobookTab = lazy(() => import('./pages/AudiobookTab'));
const ModelCataloguePage = lazy(() => import('./pages/ModelCatalogue'));

import Header from './components/Header';
import NavRail from './components/NavRail';
import TitleTabs from './components/TitleTabs';
import WorkspaceHistory from './components/WorkspaceHistory';
import WorkspaceVoices from './components/WorkspaceVoices';
import WorkspaceProjects from './components/WorkspaceProjects';
import ErrorBoundary from './components/ErrorBoundary';
import FloatingPill from './components/FloatingPill';
import GlobalAudioPlayer from './components/GlobalAudioPlayer';
import BackendCrashNotice from './components/BackendCrashNotice';
import BackendStartFailureNotice from './components/BackendStartFailureNotice';
import RemoteBackendRecovery from './components/RemoteBackendRecovery';
import AnalyticsConsentBanner from './components/AnalyticsConsentBanner';
import LanguageSwitchPrompt from './components/LanguageSwitchPrompt';
import { initAnalyticsFromConsent } from './utils/analytics';
import BackendRestartBanner from './components/BackendRestartBanner';
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
import { listenDictationNotice, showDictationNotice } from './utils/dictationNotice';
import { addBreadcrumb } from './utils/breadcrumbs';
import { appShellClasses } from './utils/appShellClasses';
import { configuredRemoteBackend, probeRemoteBackend } from './utils/remoteBackendProbe';
import { applyUiScale } from './utils/uiScaleEngine';
import { resolveUiScale, suggestUiScale } from './utils/uiScaleSuggestion';
import { recordValueMoment } from './utils/donationMoments';
import useResponsiveShellSize from './hooks/useResponsiveShellSize';
import {
  POPULAR_LANGS,
  POPULAR_ISO,
  TAGS,
  CATEGORIES,
  PRESETS,
  CLONE_MAX_SECONDS,
} from './utils/constants';
import { LANG_CODES } from './utils/languages';
import { restoreProjectExtras } from './utils/projectState';
import { castSourcesFromJob } from './utils/segments';
import { API, apiFetch, apiJson } from './api/client';
import { flushMemory as apiFlushMemory } from './api/system';
import {
  saveProject as apiSaveProject,
  loadProject as apiLoadProject,
  deleteProject as apiDeleteProject,
  renameProject as apiRenameProject,
} from './api/projects';
import { exportAction, exportReveal, exportRecord } from './api/exports';
import {
  clearHistory as apiClearHistory,
  setHistoryStarred as apiSetHistoryStarred,
  audioUrlWithCacheBust,
} from './api/generate';
import { clearDubHistory as apiClearDubHistory, dubBurnQuery } from './api/dub';

import { isTauri, doubleClickMaximize, fileToMediaUrl, playBlobAudio } from './utils/media';
import { browserDownload } from './utils/download';
import { downloadMedia } from './utils/mediaDownload';
import { checkForUpdate, fetchAppVersion } from './utils/updater';
import { syncChannel } from './utils/channelControl';
import i18n from './i18n';

function App() {
  // First-run bootstrap: Rust spawns uv sync in a background thread and
  // publishes progress via the `bootstrap_status` Tauri command. Hook below
  // polls every 1 s; until `ready`, we render BootstrapSplash instead of the
  // normal app shell, so the user sees real progress instead of a hung UI.
  const { stage: bootstrapStage, message: bootstrapMessage } = useBootstrapStage();
  // Read once, like api/client.ts. Saving or disabling a remote backend reloads
  // the app, so this value and API's module-level base always move together.
  const [remoteBackend] = useState(() => configuredRemoteBackend());

  // UI navigation state now lives in the Zustand `uiSlice` (Phase 2.2).
  // Mode + uiScale + sidebar-collapsed persist across reloads automatically
  // via the store's `partialize`; active project / voice ids stay transient.
  const uiScale = useAppStore((s) => s.uiScale);
  const uiScaleConfigured = useAppStore((s) => s.uiScaleConfigured);
  const uiScalePreviewed = useAppStore((s) => s.uiScalePreviewed);
  const setUiScale = useAppStore((s) => s.setUiScale);
  const setUiScaleConfigured = useAppStore((s) => s.setUiScaleConfigured);
  const setUiScalePreviewed = useAppStore((s) => s.setUiScalePreviewed);
  const [storeHydrated, setStoreHydrated] = useState(
    () => useAppStore.persist?.hasHydrated?.() ?? true,
  );

  useEffect(() => {
    if (storeHydrated) return undefined;
    const unsubscribe = useAppStore.persist?.onFinishHydration?.(() => setStoreHydrated(true));
    if (useAppStore.persist?.hasHydrated?.()) setStoreHydrated(true);
    return unsubscribe;
  }, [storeHydrated]);

  // Latched on first render — "startup" is the contract, not a per-render read.
  // Tauri's native zoom keeps the CSS viewport equal to the visible window
  // (utils/uiScaleEngine.js), so applying a scale changes `window.innerWidth`.
  // Re-measuring here on every render made this value depend on the zoom it
  // itself produces, which is the other half of the first-run oscillation
  // fixed in UiScaleSetup.jsx — see the long comment there. A live read also
  // can't be the "startup" suggestion by definition.
  const [startupSuggestedScale] = useState(() =>
    suggestUiScale({
      width: typeof window === 'undefined' ? 1440 : window.innerWidth,
      height: typeof window === 'undefined' ? 900 : window.innerHeight,
    }),
  );
  const effectiveUiScale = resolveUiScale({
    configured: uiScaleConfigured,
    previewed: uiScalePreviewed,
    selected: uiScale,
    suggested: startupSuggestedScale,
  });
  const [uiScaleEngine, setUiScaleEngine] = useState(() =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'native' : 'css',
  );

  // Desktop UI scale belongs at the webview boundary. A CSS `zoom` probe can
  // report the expected bounding box on WebKitGTK even when the painted shell
  // still occupies only the upper-left of the window. Tauri's native zoom keeps
  // layout and paint in agreement; browser/dev sessions retain the CSS path.
  useLayoutEffect(() => {
    let cancelled = false;
    void applyUiScale(effectiveUiScale).then((engine) => {
      if (!cancelled) setUiScaleEngine(engine);
    });
    return () => {
      cancelled = true;
    };
  }, [effectiveUiScale]);
  const { observeShell, shellSizeClass } = useResponsiveShellSize(effectiveUiScale, uiScaleEngine);
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
  // Navigation skin: the icon rail (default) or titlebar tabs (Settings →
  // Appearance). Only one of the two renders at a time.
  const navStyle = useAppStore((s) => s.navStyle);
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

  // Dictation failures are raised in the widget window, which is never shown —
  // this is the only place they can reach the user. Without it, a hotkey press
  // that can't paste (Accessibility ungranted) or can't record (mic denied)
  // would be indistinguishable from a hotkey that isn't working at all.
  useEffect(() => {
    let unlisten;
    let cancelled = false;
    (async () => {
      const stop = await listenDictationNotice(showDictationNotice);
      // The await above can outlive the effect (StrictMode double-mount, or a
      // fast unmount) — drop the subscription rather than leaking a listener
      // that would double every later toast.
      if (cancelled) stop();
      else unlisten = stop;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
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
    mode === 'batch' ||
    mode === 'tools' ||
    mode === 'projects' ||
    mode === 'gallery' ||
    mode === 'enterprise' ||
    mode === 'contact' ||
    mode === 'transcriptions' ||
    mode === 'catalogue' ||
    mode === 'stories' ||
    mode === 'audiobook' ||
    // Voice (studio) and Dub workspaces moved their saved voices /
    // projects + history into workspace rails; global sidebar dissolved.
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
  const clearSelectedProfile = useCallback(() => setSelectedProfile(null), [setSelectedProfile]);

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
  const {
    isRecording,
    isCleaning,
    recordingTime,
    audioInputs,
    selectedAudioInputId,
    setSelectedAudioInputId,
    channelMode,
    setChannelMode,
    inputLevelStore,
    startRecording,
    stopRecording,
  } = useRecording(ingestRefAudio);

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
  const dubSourceLangCode = useAppStore((s) => s.dubSourceLangCode);
  const setDubSourceLangCode = useAppStore((s) => s.setDubSourceLangCode);
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
  const setExportTracks = useAppStore((s) => s.setExportTracks);
  const previewSegIds = useAppStore((s) => s.previewSegIds);
  const speakerClones = useAppStore((s) => s.speakerClones);
  const setSpeakerClones = useAppStore((s) => s.setSpeakerClones);
  // Multi-language batch picks (P1.4) — saved with the project payload.
  const multiLangMode = useAppStore((s) => s.multiLangMode);
  const setMultiLangMode = useAppStore((s) => s.setMultiLangMode);
  const multiLangs = useAppStore((s) => s.multiLangs);
  const setMultiLangs = useAppStore((s) => s.setMultiLangs);

  const setGlossaryTerms = useAppStore((s) => s.setGlossaryTerms);
  const dualSubs = useAppStore((s) => s.dualSubs);
  const burnSubs = useAppStore((s) => s.burnSubs);
  const karaokeSubs = useAppStore((s) => s.karaokeSubs);

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
    pasteTranslations,
    segmentSplit,
    segmentMerge,
    segmentInsert,
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
    fingerprintsByLang,
    setFingerprintsByLang,
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
    transcribeProgress,
    asrInstall,
    handleDubUpload: _handleDubUpload,
    handleDubIngestUrl,
    handleDubAbort,
    handleDubRetryTranscribe,
    handleInstallMissingAsr,
    handleDubStop,
    handleDubGenerate,
    handleCleanupSegments,
    handleTranslateAll,
    handleDubImportSrt,
  } = useDubWorkflow({
    loadProjects,
    loadProfiles,
    loadDubHistory,
    setLastGenFingerprints,
  });

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
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);

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
  const [remoteFailure, setRemoteFailure] = useState(null);
  const [remoteProbeAttempt, setRemoteProbeAttempt] = useState(0);
  const retryRemoteBackend = useCallback(() => {
    setRemoteFailure(null);
    setSetupChecked(false);
    setRemoteProbeAttempt((attempt) => attempt + 1);
  }, []);
  const openRemoteBackendSettings = useCallback(() => {
    setRemoteFailure(null);
    openSettingsTab('sharing');
  }, [openSettingsTab]);
  const backendReady = remoteBackend ? setupChecked && !remoteFailure : bootstrapStage === 'ready';

  // Analytics remains off until the selected backend has passed its startup
  // gate. Starting this request on mount leaked connection/CORS noise from a
  // stale remote URL before the recovery screen could explain or repair it.
  useEffect(() => {
    if (!backendReady) return;
    void initAnalyticsFromConsent(() => apiJson('/api/settings/analytics'));
  }, [backendReady]);

  useEffect(() => {
    // A local backend cannot answer before Rust reports ready. A configured
    // remote is independent of the local bootstrap and must be probed at once;
    // otherwise a first-run shell parks at awaiting_setup forever.
    if (!remoteBackend && bootstrapStage !== 'ready') return undefined;
    let cancelled = false;
    (async () => {
      if (remoteBackend) {
        const result = await probeRemoteBackend(remoteBackend.url);
        if (cancelled) return;
        setRemoteFailure(result.ok ? null : result);
        setSetupNeeded(false);
        setSetupChecked(true);
        return;
      }
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
  }, [bootstrapStage, remoteBackend, remoteProbeAttempt]);

  // ── First sound ──
  // Onboarding should end with the product doing the thing: the moment the
  // studio mounts after the wizard, generate one short line locally and play
  // it. Best-effort by design — a first impression must never surface an
  // error, so every failure path is silent.
  useEffect(() => {
    if (!setupChecked || setupNeeded || !backendReady) return;
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
        const res = await apiFetch(`${API}/generate`, {
          method: 'POST',
          body: fd,
        });
        const blob = await res.blob();
        await playBlobAudio(blob, { label: i18n.t('player.generated_audio') });
        toast.success(i18n.t('firstrun.first_sound_done'), { duration: 7000 });
      } catch {
        /* silent — see above */
      }
    })();
  }, [setupChecked, setupNeeded, backendReady]);

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
      // In-webview navigation only: using DOM keydown keeps this identical in
      // browser, macOS, Windows and Linux builds (unlike OS-level hotkeys).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === 'e') {
          e.preventDefault();
          window.dispatchEvent(new Event('engine-quick-switch'));
          return;
        }
        const index = Number(key);
        if (index >= 1 && index <= NAV_ITEMS.length) {
          e.preventDefault();
          setMode(NAV_ITEMS[index - 1].id);
          return;
        }
      }
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
      const { invoke } = await import('@tauri-apps/api/core');
      const selection = await invoke('authorize_host_path', {
        kind: 'dub_export',
        suggestedName: fallbackName,
      });
      if (!selection) return; // User cancelled

      await exportAction({
        source_filename: sourceIdentifier,
        authorization: selection.authorization,
        mode,
      });
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
  // Save a dynamic export — dub video/audio/subtitles — to
  // disk. The parity-safe dialog + server-side copy vs browser-blob branch now
  // lives in the shared `downloadMedia` util (#1218) so audiobook/story exports
  // reuse the exact same path and never fall back to a webview-hijacking
  // `<a href download>`. App-specific niceties are passed as callbacks.
  const triggerDownload = (url, fallbackName) =>
    downloadMedia(url, fallbackName, {
      onValueMoment: () => recordValueMoment('export'), // success-only donation
      onHistoryChanged: loadExportHistory,
    });
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
    const burnParam = dubBurnQuery(burnSubs, dualSubs, karaokeSubs);
    const resolvedDefaultTrack = resolveDubDefaultTrack(defaultTrack, dubLangCode, dubTracks);
    triggerDownload(
      `${API}/dub/download/${dubJobId}/dubbed_video.mp4?preserve_bg=${preserveBg}&default_track=${resolvedDefaultTrack}&include_tracks=${encodeURIComponent(tracksParam)}${burnParam}`,
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
    setDubSourceLangCode('auto');
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
        dubSourceLangCode,
        dubDialect,
        dubInstruct,
        dubTracks,
        dubStep,
        dubTranscript,
        preserveBg,
        defaultTrack,
        speakerClones,
        // P1.4 — multi-language batch setup + export-track prefs travel with
        // the project. Additive: loaders default them when absent (see
        // utils/projectState.js).
        multiLangMode,
        multiLangs,
        exportTracks,
        // P1.3 — per-language segment fingerprints, so reopening a project
        // keeps every track's "Regen N changed" plan. Additive: legacy
        // loaders ignore the key; segments' `translations` maps ride along
        // inside dubSegments above.
        segHashesByLang: fingerprintsByLang,
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
      setDubSourceLangCode(s.dubSourceLangCode || 'auto');
      setDubDialect(s.dubDialect || '');
      setDubInstruct(s.dubInstruct || '');
      setDubTracks(s.dubTracks || []);
      setDubTranscript(s.dubTranscript || '');
      setPreserveBg(s.preserveBg !== undefined ? s.preserveBg : true);
      setDefaultTrack(s.defaultTrack !== undefined ? s.defaultTrack : '');
      setDubStep(s.dubStep === 'done' ? 'done' : s.dubSegments?.length ? 'editing' : 'idle');
      // Phase 4.5 — rehydrate per-segment fingerprints. The incremental plan
      // immediately shows "N segments changed" for any segments edited after
      // the last generate. P1.3: prefer the per-language map; a legacy flat
      // `segHashes` can only describe the project's saved target language.
      if (
        s.segHashesByLang &&
        typeof s.segHashesByLang === 'object' &&
        !Array.isArray(s.segHashesByLang)
      ) {
        setFingerprintsByLang(s.segHashesByLang);
      } else {
        setLastGenFingerprints(s.segHashes || {}, s.dubLangCode || 'en');
      }
      setSpeakerClones(s.speakerClones || {});
      // P1.4 — restore multi-lang picks; legacy payloads default to off/empty
      // and leave the in-session exportTracks untouched (null sentinel).
      const extras = restoreProjectExtras(s);
      setMultiLangMode(extras.multiLangMode);
      setMultiLangs(extras.multiLangs);
      if (extras.exportTracks) setExportTracks(extras.exportTracks);
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
      setDubSourceLangCode(job.source_lang_override || job.source_lang || 'auto');
      setDubTracks(Object.keys(job.dubbed_tracks || {}));
      setDubStep(Object.keys(job.dubbed_tracks || {}).length > 0 ? 'done' : 'editing');
      // Phase 4.5 — seg_hashes are written per successful segment by
      // dub_generate.py. Reloading a half-generated dub lets the "Regen N
      // changed" button resume right where the crash happened. P1.3: prefer
      // the per-language map (multi-track jobs); a legacy flat map belongs to
      // the job's last-generated language — the code restored just above.
      if (
        job.seg_hashes_by_lang &&
        typeof job.seg_hashes_by_lang === 'object' &&
        !Array.isArray(job.seg_hashes_by_lang)
      ) {
        setFingerprintsByLang(job.seg_hashes_by_lang);
      } else {
        setLastGenFingerprints(
          job.seg_hashes || {},
          item.language_code || job.language_code || 'und',
        );
      }
      // Rehydrate path-free cast sources. Legacy heuristic jobs may have only
      // per-segment references; castSourcesFromJob recovers those too.
      setSpeakerClones(castSourcesFromJob(job));
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

  // Generation takes: star/unstar a take so it survives the retention cap and
  // never ages off the rail. Optimistic errors only — the WS
  // generation_history event refreshes the list on success.
  const toggleStarHistory = async (item) => {
    try {
      await apiSetHistoryStarred(item.id, !item.starred);
      loadHistory();
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Load a past take back as the active output: fetch its WAV and hand it to
  // the same global mini-player a fresh generation plays through.
  const playTakeAsOutput = async (item) => {
    try {
      const res = await apiFetch(audioUrlWithCacheBust(item.audio_path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await playBlobAudio(blob, {
        label: item.text || i18n.t('player.generated_audio'),
      });
    } catch (err) {
      toast.error(i18n.t('history.load_take_failed', { message: err.message || '' }));
    }
  };

  const deleteHistory = async (id, type) => {
    if (!(await askConfirm(i18n.t('history.delete_confirm')))) return;
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

  // Clear-all for the workspace history panels (#1032). The control lived in
  // the old left Sidebar; the workspace UX overhaul (#374) moved history into
  // the right-side WorkspaceHistory panels and the button was dropped in the
  // move — restore it, scoped per workspace (voice = synth rows, dub = dubs).
  const clearWorkspaceHistory = async (type) => {
    const count = type === 'dub' ? dubHistory.length : history.length;
    if (!(await askConfirm(i18n.t('sidebar.clear_confirm', { count })))) return;
    try {
      if (type === 'dub') {
        await apiClearDubHistory();
        loadDubHistory();
      } else {
        await apiClearHistory();
        loadHistory();
      }
      toast.success(i18n.t('sidebar.history_cleared'));
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Install-plan screen outranks everything — both on a true first run and
  // when explicitly requested via `--setup`. Without this, a live backend
  // answering /setup/status would route straight to the model wizard and the
  // awaiting_setup stage would never get to render.
  if (!remoteBackend && bootstrapStage === 'awaiting_setup') {
    return (
      <div className="app-bootstrap-scale" style={{ '--ui-scale': effectiveUiScale }}>
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
  if (!setupChecked || !storeHydrated) {
    return (
      <div className="app-bootstrap-scale" style={{ '--ui-scale': effectiveUiScale }}>
        <BootstrapSplash stage={bootstrapStage} message={bootstrapMessage} />
      </div>
    );
  }
  if (remoteFailure) {
    return (
      <div className="app-bootstrap-scale" style={{ '--ui-scale': effectiveUiScale }}>
        <RemoteBackendRecovery
          failure={remoteFailure}
          onRetry={retryRemoteBackend}
          onOpenSettings={openRemoteBackendSettings}
        />
      </div>
    );
  }
  if (!uiScaleConfigured && backendReady) {
    return (
      <div className="app-wizard-wrap" style={{ '--ui-scale': effectiveUiScale }}>
        <div data-tauri-drag-region className="app-wizard-dragstrip" />
        <Suspense fallback={<LazyFallback />}>
          <UiScaleSetup
            uiScale={uiScale}
            setUiScale={setUiScale}
            setUiScaleConfigured={setUiScaleConfigured}
            setUiScalePreviewed={setUiScalePreviewed}
          />
        </Suspense>
      </div>
    );
  }
  if (setupNeeded && backendReady) {
    // Render outside the `app-container` grid so the wizard spans the full
    // viewport instead of getting squeezed into whatever grid cell the
    // studio layout reserves for the main content column. Gated on the
    // bootstrap being 'ready': while the stage is still settling (checking /
    // awaiting_setup racing the first poll), the wizard must not steal the
    // mount from the install-plan screen.
    // `--ui-scale`, NOT a bare inline `zoom`: the CSS shrinks the box by the
    // scale and zooms it back (#504 contract, same as .app-container). An
    // inline zoom on top of a full-viewport box pushed the pinned
    // Continue/HF-token row below the window at any scale > 1.
    return (
      <div className="app-wizard-wrap" style={{ '--ui-scale': effectiveUiScale }}>
        {/* Invisible drag strip across the top 28 px of the wizard —
            matches the macOS traffic-light zone so the window can be
            dragged / double-click-zoomed from anywhere along the top. */}
        {/* Double-click-to-maximize is handled globally in main.jsx for every
            drag region (splash, first-run, wizard, main) on all platforms. */}
        <div data-tauri-drag-region className="app-wizard-dragstrip" />
        {/* The wizard is where the multi-GB downloads happen — a mid-download
            backend restart needs its banner here too, not only in the studio. */}
        <BackendRestartBanner />
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
      </div>
    );
  }

  // Block the main UI until Rust reports the backend is ready. In dev web
  // (no Tauri), the hook returns 'ready' immediately so this is a no-op.
  if (!backendReady) {
    return (
      <div className="app-bootstrap-scale" style={{ '--ui-scale': effectiveUiScale }}>
        <BootstrapSplash stage={bootstrapStage} message={bootstrapMessage} />
      </div>
    );
  }

  return (
    <div
      ref={observeShell}
      className={appShellClasses({
        navStyle,
        navRailSide,
        isSidebarCollapsed,
        hideSidebar,
        shellSizeClass,
      })}
      style={{ '--ui-scale': effectiveUiScale }}
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

      {/* #941: honest surfacing of backend process crashes (exit code +
          stderr tail from the shell's crash marker), with ack-on-view. */}
      <BackendCrashNotice />

      {/* #1177: the shell's `Failed { message }` diagnosis for a backend that
          could not START, surfaced after the splash is gone — the case that
          used to collapse into the evidence-free "can't reach the backend". */}
      <BackendStartFailureNotice />

      {/* One-time analytics consent ask for installs that predate the
          first-run consent step. Renders nothing once any choice was made.
          Source builds get it too since #1193 (in-repo default token). */}
      <AnalyticsConsentBanner />

      {/* First-run-only offer to switch the UI to English (#1215). Shows only
          when the auto-detected language isn't English AND the user hasn't
          chosen a language — renders nothing otherwise. UI convenience only. */}
      <LanguageSwitchPrompt />

      {/* #567's visible half: while the shell auto-restarts a dead backend
          (10–20 s), say so once — instead of every request surfacing its own
          "Can't reach the backend" toast. */}
      <BackendRestartBanner />

      <Header
        mode={mode}
        setMode={setMode}
        navStyle={navStyle}
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

      {navStyle === 'tabs' ? null : (
        <NavRail mode={mode} setMode={setMode} side={navRailSide} onFlipSide={flipNavRailSide} />
      )}

      <ModeLifecycleBoundary mode={mode}>
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
        ) : mode === 'batch' ? (
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
              <VoiceGallery clearSelectedProfile={clearSelectedProfile} />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'transcriptions' ? (
          <ErrorBoundary name="transcriptions">
            <Suspense fallback={<LazyFallback />}>
              <TranscriptionsPage />
            </Suspense>
          </ErrorBoundary>
        ) : mode === 'catalogue' ? (
          <ErrorBoundary name="catalogue">
            <Suspense fallback={<LazyFallback />}>
              <ModelCataloguePage />
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
              {/* Same page as donate / enterprise — it scrolls to the contact
                  section. Three routes, one destination. */}
              <SupportPage initialView="contact" onBack={() => setMode('launchpad')} />
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
            {dubStep === 'idle' && (
              <div className="studio-projects">
                <WorkspaceProjects
                  projects={studioProjects}
                  activeProjectId={activeProjectId}
                  canSave={false}
                  saveProject={saveProject}
                  loadProject={loadProject}
                  deleteProject={deleteProject}
                  renameProject={renameProject}
                />
              </div>
            )}
            <div className="studio-with-history__main">
              <ErrorBoundary name="dub">
                <Suspense fallback={<LazyFallback />}>
                  <DubTab
                    // Non-serialisable / local state only — all pipeline fields now
                    // flow through the Zustand store.
                    dubVideoFile={dubVideoFile}
                    dubLocalBlobUrl={dubLocalBlobUrl}
                    transcribeElapsed={transcribeElapsed}
                    transcribeProgress={transcribeProgress}
                    asrInstall={asrInstall}
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
                    handleInstallMissingAsr={handleInstallMissingAsr}
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
                    pasteTranslations={pasteTranslations}
                    segmentSplit={segmentSplit}
                    segmentMerge={segmentMerge}
                    segmentInsert={segmentInsert}
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
                <WorkspaceHistory
                  variant="dub"
                  dubHistory={dubHistory}
                  restoreDubHistory={restoreDubHistory}
                  deleteHistory={deleteHistory}
                  clearHistory={() => clearWorkspaceHistory('dub')}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="studio-with-history">
            <div className="studio-voices">
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
            </div>
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
                    audioInputs={audioInputs}
                    selectedAudioInputId={selectedAudioInputId}
                    setSelectedAudioInputId={setSelectedAudioInputId}
                    channelMode={channelMode}
                    setChannelMode={setChannelMode}
                    inputLevelStore={inputLevelStore}
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
              <WorkspaceHistory
                history={history}
                handleSaveHistoryAsProfile={handleSaveHistoryAsProfile}
                handleLockProfile={handleLockProfile}
                handleNativeExport={handleNativeExport}
                restoreHistory={restoreHistory}
                deleteHistory={deleteHistory}
                clearHistory={() => clearWorkspaceHistory('synth')}
                toggleStarHistory={toggleStarHistory}
                playTakeAsOutput={playTakeAsOutput}
              />
            </div>
          </div>
        )}
      </ModeLifecycleBoundary>

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

      {/* ═══ GLOBAL AUDIO MINI-PLAYER (grid row 3, above the footer) ═══
          Subsumes the #1032 PlaybackStopPill: waveform + seek + time + stop
          for every playBlobAudio playback that has no on-screen player. As a
          real grid row it can never overlap row-2 content or the footer. */}
      <GlobalAudioPlayer />

      {/* ═══ BOTTOM LOGS PANEL (VSCode-style) ═══ */}
      <Suspense fallback={null}>
        <LogsFooter />
      </Suspense>
    </div>
  );
}

export default App;
