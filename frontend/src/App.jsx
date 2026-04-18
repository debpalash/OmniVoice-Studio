import React, { useState, useRef, useEffect, useCallback, Suspense, lazy } from 'react';
import './index.css';
import SearchableSelect from './components/SearchableSelect';

// Lazy-load heavy/conditional components so they don't bloat the initial bundle.
const AudioTrimmer = lazy(() => import('./components/AudioTrimmer'));
const Launchpad = lazy(() => import('./pages/Launchpad'));
const CloneDesignTab = lazy(() => import('./pages/CloneDesignTab'));
const DubTab = lazy(() => import('./pages/DubTab'));
const Sidebar = lazy(() => import('./components/Sidebar'));
const CompareModal = lazy(() => import('./components/CompareModal'));
const Settings = lazy(() => import('./pages/Settings'));
import Header from './components/Header';
import NavRail from './components/NavRail';

const LazyFallback = () => <div style={{ padding: 12, color: '#6b6657', fontSize: '0.7rem' }}>Loading…</div>;

import { Toaster, toast } from 'react-hot-toast';
import ALL_LANGUAGES from './languages.json';
import {
  POPULAR_LANGS, POPULAR_ISO, TAGS, CATEGORIES, PRESETS, CLONE_MAX_SECONDS,
} from './utils/constants';
import { LANG_CODES } from './utils/languages';
import { formatTime, probeAudioDuration } from './utils/format';
import { API } from './api/client';
import { sysinfo as apiSysinfo, modelStatus as apiModelStatus, cleanAudio as apiCleanAudio } from './api/system';
import { listProfiles, createProfile, deleteProfile as apiDeleteProfile, lockProfile, unlockProfile } from './api/profiles';
import { listHistory, clearHistory, generateSpeech, audioUrlWithCacheBust } from './api/generate';
import { listProjects, saveProject, loadProject as apiLoadProject, deleteProject as apiDeleteProject } from './api/projects';
import {
  dubUpload, dubAbort as apiDubAbort, dubCleanupSegments, dubTranslate, dubGenerate,
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
const _PREVIEW_API = import.meta.env.VITE_OMNIVOICE_API || 'http://localhost:8000';
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
  const [uiScale, setUiScale] = useState(1);
  const [mode, setMode] = useState('launchpad');
  const [navRailSide, setNavRailSide] = useState(() => {
    try { return localStorage.getItem('omnivoice.navRailSide') || 'left'; } catch { return 'left'; }
  });
  const flipNavRailSide = useCallback(() => {
    setNavRailSide(prev => {
      const next = prev === 'left' ? 'right' : 'left';
      try { localStorage.setItem('omnivoice.navRailSide', next); } catch {}
      return next;
    });
  }, []);
  const hideSidebar = mode === 'launchpad' || mode === 'settings';
  const availableSidebarTabs = mode === 'dub'
    ? ['projects', 'history', 'downloads']
    : (mode === 'clone' || mode === 'design')
      ? ['projects', 'history']
      : [];
  const [text, setText] = useState('');
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
  const [refText, setRefText] = useState('');
  const [instruct, setInstruct] = useState('');
  const [language, setLanguage] = useState('Auto');
  const [isGenerating, setIsGenerating] = useState(false);
  const [history, setHistory] = useState([]);
  const [exportHistory, setExportHistory] = useState([]);
  
  const [speed, setSpeed] = useState(1.0);
  const [steps, setSteps] = useState(16); // Must be ~16 to prevent ODE destabilization
  const [cfg, setCfg] = useState(2.0);
  const [showOverrides, setShowOverrides] = useState(false);
  const [denoise, setDenoise] = useState(true);
  const [tShift, setTShift] = useState(0.1);
  const [posTemp, setPosTemp] = useState(5.0);
  const [classTemp, setClassTemp] = useState(0.0);
  const [layerPenalty, setLayerPenalty] = useState(5.0);
  const [postprocess, setPostprocess] = useState(true);
  const [duration, setDuration] = useState('');
  
  const [vdStates, setVdStates] = useState({
    Gender: 'Auto', Age: 'Auto', Pitch: 'Auto', Style: 'Auto', EnglishAccent: 'Auto', ChineseDialect: 'Auto'
  });

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

  // ═══ MIC RECORDING ═══
  const [isRecording, setIsRecording] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);

  // ═══ DUB STATE ═══
  const [dubJobId, setDubJobId] = useState(null);
  const [dubStep, setDubStep] = useState('idle');
  const [dubSegments, setDubSegments] = useState([]);
  const [dubLang, setDubLang] = useState('Auto');
  const [dubLangCode, setDubLangCode] = useState('en');
  const [translateProvider, setTranslateProvider] = useState('argos');
  const [dubInstruct, setDubInstruct] = useState('');
  const [dubProgress, setDubProgress] = useState({ current: 0, total: 0, text: '' });
  const [dubFilename, setDubFilename] = useState('');
  const [dubDuration, setDubDuration] = useState(0);
  const [dubError, setDubError] = useState('');
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
  const [dubTracks, setDubTracks] = useState([]);
  const [dubTranscript, setDubTranscript] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [previewAudios, setPreviewAudios] = useState({});
  const [dubHistory, setDubHistory] = useState([]);
  const [preserveBg, setPreserveBg] = useState(true);
  const [defaultTrack, setDefaultTrack] = useState('original');
  const [exportTracks, setExportTracks] = useState({original: true}); // {original: true, es: true, de: false, ...}
  const [transcribeStart, setTranscribeStart] = useState(null);
  const [transcribeElapsed, setTranscribeElapsed] = useState(0);
  const [dubTaskId, setDubTaskId] = useState(null);

  // ═══ STUDIO PROJECTS ═══
  const [studioProjects, setStudioProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeProjectName, setActiveProjectName] = useState('');
  const [sidebarTab, setSidebarTab] = useState('projects'); // 'projects' | 'history' | 'downloads'

  // Snap sidebar to a valid tab when view changes
  useEffect(() => {
    if (availableSidebarTabs.length && !availableSidebarTabs.includes(sidebarTab)) {
      setSidebarTab(availableSidebarTabs[0]);
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const [isSidebarProjectsCollapsed, setIsSidebarProjectsCollapsed] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

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

  // ── MODEL STATUS ──
  const [modelStatus, setModelStatus] = useState('idle'); // 'idle' | 'loading' | 'ready'

  // ── LOAD DATA FROM SERVER ──
  const [sysStats, setSysStats] = useState(null);

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

  useEffect(() => {
    let interval = null;
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const [sys, ms] = await Promise.all([apiSysinfo(), apiModelStatus()]);
        if (sys) setSysStats(sys);
        if (ms) setModelStatus(ms.status);
        return true;
      } catch (e) { return false; }
    };
    // Wait for backend to be reachable before starting the polling interval
    const startPolling = async () => {
      while (!cancelled) {
        const ok = await fetchStats();
        if (ok) {
          if (!cancelled) interval = setInterval(fetchStats, 2000);
          return;
        }
        await new Promise(r => setTimeout(r, 1500));
      }
    };
    startPolling();
    return () => { cancelled = true; if (interval) clearInterval(interval); };
  }, []);

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

  const handleDubUpload = async () => {
    if (!dubVideoFile) return;
    setDubStep('uploading'); setDubError(''); setDubTracks([]);
    const ctrl = new AbortController();
    dubAbortCtrlRef.current = ctrl;
    // Generate job_id client-side so we can POST /dub/abort even during upload.
    const clientJobId = Math.random().toString(36).slice(2, 10);
    dubClientJobIdRef.current = clientJobId;
    setDubJobId(clientJobId);
    try {
      const data = await dubUpload(dubVideoFile, clientJobId, { signal: ctrl.signal });
      setDubJobId(data.job_id); setDubFilename(data.filename); setDubDuration(data.duration);
      setDubStep('transcribing');
      setTranscribeStart(Date.now());
      setDubSegments([]);

      await new Promise((resolve, reject) => {
        const evt = new EventSource(transcribeStreamUrl(data.job_id));
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
          // EventSource auto-retries on network errors; treat as fatal after final is in.
          if (gotFinal) { close(); resolve(); }
          else if (evt.readyState === EventSource.CLOSED) { reject(new Error('transcribe stream closed')); }
        });
      });

      setTranscribeStart(null);
      setDubStep('editing');
    } catch (err) {
      if (err.name === 'AbortError') {
        toast('Upload cancelled');
        setDubStep('idle');
      } else {
        setDubError(err.message); setDubStep('idle');
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
        })),
        target_lang: dubLangCode,
        provider: translateProvider,
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
        return { ...s, text: newText, translate_error: hit.error || undefined };
      }));
      if (errors.length) {
        const unique = [...new Set(errors.map(e => e.error))];
        toast.error(
          `${errors.length}/${data.translated.length} segment${errors.length === 1 ? '' : 's'} failed: ${unique[0].slice(0, 120)}`,
          { duration: 6000 }
        );
        console.warn('Translation errors:', errors);
      } else {
        toast.success(`Translated ${data.translated.length} segment${data.translated.length === 1 ? '' : 's'} → ${data.target_lang}`);
      }
    } catch (err) { setDubError('Translation failed: ' + err.message); }
    setIsTranslating(false);
  };

  const handleDubGenerate = async () => {
    setDubStep('generating');
    setDubProgress({ current: 0, total: dubSegments.length, text: '' });
    setDubError('');
    try {
      const body = {
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
          };
        }),
        language: dubLang === 'Auto' ? 'Auto' : dubLang,
        language_code: dubLangCode,
        instruct: dubInstruct,
        num_step: steps, guidance_scale: cfg, speed: speed,
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
              if (evt.type === 'progress') setDubProgress({ current: evt.current + 1, total: evt.total, text: evt.text });
              else if (evt.type === 'done') { 
                setDubStep('done'); 
                setDubTracks(evt.tracks || []); 
                if (evt.sync_scores) {
                  setDubSegments(prev => prev.map((s, idx) => ({ ...s, sync_ratio: evt.sync_scores[idx] })));
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
        playPing();
      }
    } catch (err) { setDubError(err.message); setDubStep('editing'); setDubTaskId(null); }
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
      const data = await res.json();
      toast.success(`Exported: ${fallbackName}`);
      loadExportHistory();
    } catch (err) {
      console.error(err);
      toast.error('Failed to bridge save dialog to rust/python backend.');
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
  const handleDubDownload = () => {
    // Build selected tracks from all known tracks, matching the checkbox `!== false` logic
    const selected = [];
    if (exportTracks['original'] !== false) selected.push('original');
    dubTracks.forEach(t => { if (exportTracks[t] !== false) selected.push(t); });
    const tracksParam = selected.join(',');
    triggerDownload(`${API}/dub/download/${dubJobId}/dubbed_video.mp4?preserve_bg=${preserveBg}&default_track=${defaultTrack}&include_tracks=${encodeURIComponent(tracksParam)}`, 'dubbed_video.mp4');
  };
  const handleDubAudioDownload = () => triggerDownload(`${API}/dub/download-audio/${dubJobId}/dubbed_audio.wav?preserve_bg=${preserveBg}`, 'dubbed_audio.wav');
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
    setActiveProjectId(null); setActiveProjectName('');
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
      },
    };
    try {
      const data = await saveProject(statePayload, activeProjectId);
      setActiveProjectId(data.id);
      setActiveProjectName(name);
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
      setActiveProjectId(data.id);
      setActiveProjectName(data.name);
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
        setActiveProjectId(null); setActiveProjectName('');
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

      <Header
        mode={mode} setMode={setMode}
        uiScale={uiScale} setUiScale={setUiScale}
        sysStats={sysStats} modelStatus={modelStatus}
        doubleClickMaximize={doubleClickMaximize}
        activeProjectName={activeProjectName}
      />

      <NavRail mode={mode} setMode={setMode} side={navRailSide} onFlipSide={flipNavRailSide} />

      <div className="main-content">

        {/* ═══ LAUNCHPAD TAB ═══ */}
        {mode === 'settings' ? (
          <Suspense fallback={<LazyFallback />}>
            <Settings />
          </Suspense>
        ) : mode === 'launchpad' ? (
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
        ) : mode === 'dub' ? (
          <Suspense fallback={<LazyFallback />}>
            <DubTab
              dubJobId={dubJobId} dubStep={dubStep} dubVideoFile={dubVideoFile}
              dubFilename={dubFilename} dubDuration={dubDuration}
              dubSegments={dubSegments} dubTranscript={dubTranscript}
              dubLang={dubLang} dubLangCode={dubLangCode} dubInstruct={dubInstruct}
              dubTracks={dubTracks} dubError={dubError} dubProgress={dubProgress}
              dubLocalBlobUrl={dubLocalBlobUrl}
              activeProjectName={activeProjectName}
              isSidebarCollapsed={isSidebarCollapsed} setIsSidebarCollapsed={setIsSidebarCollapsed}
              transcribeElapsed={transcribeElapsed}
              translateProvider={translateProvider} setTranslateProvider={setTranslateProvider}
              isTranslating={isTranslating}
              preserveBg={preserveBg} setPreserveBg={setPreserveBg}
              defaultTrack={defaultTrack} setDefaultTrack={setDefaultTrack}
              exportTracks={exportTracks} setExportTracks={setExportTracks}
              showTranscript={showTranscript} setShowTranscript={setShowTranscript}
              profiles={profiles}
              segmentPreviewLoading={segmentPreviewLoading}
              selectedSegIds={selectedSegIds}
              setDubVideoFile={setDubVideoFile} setDubStep={setDubStep}
              setDubLocalBlobUrl={setDubLocalBlobUrl}
              setDubSegments={setDubSegments}
              setDubLang={setDubLang} setDubLangCode={setDubLangCode}
              setDubInstruct={setDubInstruct}
              handleDubAbort={handleDubAbort} handleDubUpload={handleDubUpload}
              handleDubStop={handleDubStop} handleDubGenerate={handleDubGenerate}
              handleDubDownload={handleDubDownload} handleDubAudioDownload={handleDubAudioDownload}
              handleSegmentPreview={handleSegmentPreview}
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
        ) : (
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
        )}
      </div>

      {/* ── SIDEBAR ── */}
      <Suspense fallback={<LazyFallback />}>
        <Sidebar
          mode={mode}
          availableTabs={availableSidebarTabs}
          isSidebarCollapsed={isSidebarCollapsed}
          isSidebarProjectsCollapsed={isSidebarProjectsCollapsed}
          setIsSidebarProjectsCollapsed={setIsSidebarProjectsCollapsed}
          sidebarTab={sidebarTab} setSidebarTab={setSidebarTab}
          studioProjects={studioProjects}
          profiles={profiles}
          history={history}
          dubHistory={dubHistory}
          exportHistory={exportHistory}
          dubStep={dubStep}
          dubVideoFile={dubVideoFile}
          selectedProfile={selectedProfile}
          activeProjectId={activeProjectId}
          previewLoading={previewLoading}
          saveProject={saveProject}
          loadProject={loadProject}
          deleteProject={deleteProject}
          handleSelectProfile={handleSelectProfile}
          handleDeleteProfile={handleDeleteProfile}
          handleUnlockProfile={handleUnlockProfile}
          handleLockProfile={handleLockProfile}
          handlePreviewVoice={handlePreviewVoice}
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

    </div>
  );
}

export default App;
