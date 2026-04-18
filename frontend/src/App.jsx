import React, { useState, useRef, useEffect, useCallback } from 'react';
import './index.css';
import WaveformTimeline from './components/WaveformTimeline';
import SearchableSelect from './components/SearchableSelect';

const POPULAR_LANGS = ['English','Spanish','French','German','Italian','Portuguese','Russian','Chinese','Japanese','Korean','Arabic','Hindi'];
const POPULAR_ISO = ['en','es','fr','de','it','pt','ru','zh','ja','ko','ar','hi'];
import { Toaster, toast } from 'react-hot-toast';
import ALL_LANGUAGES from './languages.json';
import { 
  Sparkles, Fingerprint, Wand2, SlidersHorizontal, UserSquare2, ShieldCheck, 
  Download as DownloadIcon, History, Command, Globe, Volume2, UploadCloud, 
  Settings2, ChevronDown, ChevronUp, Play, Search, Film, Trash2,
  FileText, Loader, Check, AlertCircle, Plus, User, Save, Languages, Headphones,
  FolderOpen, FolderPlus, Pencil, Clock, Lock, Unlock, Mic, MicOff, Square,
  CheckCircle, Circle, ChevronRight, Target, PanelLeftClose, PanelLeftOpen, Scale,
  Layers, Music, Package, DownloadCloud, RefreshCw
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

const TAGS = [
  '[laughter]', '[sigh]', '[confirmation-en]', '[question-en]', 
  '[question-ah]', '[question-oh]', '[question-ei]', '[question-yi]',
  '[surprise-ah]', '[surprise-oh]', '[surprise-wa]', '[surprise-yo]',
  '[dissatisfaction-hnn]'
];

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

const CATEGORIES = {
  Gender: ["Auto", "male", "female"],
  Age: ["Auto", "child", "teenager", "young adult", "middle-aged", "elderly"],
  Pitch: ["Auto", "very low pitch", "low pitch", "moderate pitch", "high pitch", "very high pitch"],
  Style: ["Auto", "whisper"],
  EnglishAccent: ["Auto", "american accent", "british accent", "australian accent", "canadian accent", "indian accent", "chinese accent", "korean accent", "japanese accent", "portuguese accent", "russian accent"],
  ChineseDialect: ["Auto", "河南话", "陕西话", "四川话", "贵州话", "云南话", "桂林话", "济南话", "石家庄话", "甘肃话", "宁夏话", "青岛话", "东北话"]
};

const PRESETS = [
  { id: 'narrator', name: '🎙️ Authoritative', tags: '', attrs: {Gender:'male', Age:'middle-aged', Pitch:'low pitch', Style:'Auto', EnglishAccent:'british accent', ChineseDialect:'Auto'} },
  { id: 'excited_child', name: '🧒 Excited Child', tags: '[laughter] ', attrs: {Gender:'Auto', Age:'child', Pitch:'high pitch', Style:'Auto', EnglishAccent:'Auto', ChineseDialect:'Auto'} },
  { id: 'anxious_whisper', name: '🤫 Whisper', tags: '[question-en] ', attrs: {Gender:'Auto', Age:'young adult', Pitch:'Auto', Style:'whisper', EnglishAccent:'Auto', ChineseDialect:'Auto'} },
  { id: 'surprised_woman', name: '😲 Surprised', tags: '[surprise-wa] ', attrs: {Gender:'female', Age:'young adult', Pitch:'high pitch', Style:'Auto', EnglishAccent:'Auto', ChineseDialect:'Auto'} },
  { id: 'elderly_story', name: '👴 Elder', tags: '[sigh] ', attrs: {Gender:'male', Age:'elderly', Pitch:'very low pitch', Style:'Auto', EnglishAccent:'Auto', ChineseDialect:'Auto'} },
  { id: 'sichuan', name: '🌶️ 四川话', tags: '', attrs: {Gender:'female', Age:'young adult', Pitch:'moderate pitch', Style:'Auto', EnglishAccent:'Auto', ChineseDialect:'四川话'} },
];

const LANG_CODES = [
  {code: 'af', label: 'Afrikaans'}, {code: 'sq', label: 'Albanian'}, {code: 'am', label: 'Amharic'},
  {code: 'ar', label: 'Arabic'}, {code: 'hy', label: 'Armenian'}, {code: 'az', label: 'Azerbaijani'},
  {code: 'eu', label: 'Basque'}, {code: 'be', label: 'Belarusian'}, {code: 'bn', label: 'Bengali'},
  {code: 'bs', label: 'Bosnian'}, {code: 'bg', label: 'Bulgarian'}, {code: 'my', label: 'Burmese'},
  {code: 'ca', label: 'Catalan'}, {code: 'cmn-Hans', label: 'Chinese (Simplified)'}, {code: 'cmn-Hant', label: 'Chinese (Traditional)'},
  {code: 'hr', label: 'Croatian'}, {code: 'cs', label: 'Czech'}, {code: 'da', label: 'Danish'},
  {code: 'nl', label: 'Dutch'}, {code: 'en', label: 'English'}, {code: 'et', label: 'Estonian'},
  {code: 'fi', label: 'Finnish'}, {code: 'fr', label: 'French'}, {code: 'gl', label: 'Galician'},
  {code: 'ka', label: 'Georgian'}, {code: 'de', label: 'German'}, {code: 'el', label: 'Greek'},
  {code: 'gu', label: 'Gujarati'}, {code: 'ht', label: 'Haitian Creole'}, {code: 'ha', label: 'Hausa'},
  {code: 'haw', label: 'Hawaiian'}, {code: 'he', label: 'Hebrew'}, {code: 'hi', label: 'Hindi'},
  {code: 'hu', label: 'Hungarian'}, {code: 'is', label: 'Icelandic'}, {code: 'id', label: 'Indonesian'},
  {code: 'it', label: 'Italian'}, {code: 'ja', label: 'Japanese'}, {code: 'jw', label: 'Javanese'},
  {code: 'kn', label: 'Kannada'}, {code: 'kk', label: 'Kazakh'}, {code: 'km', label: 'Khmer'},
  {code: 'ko', label: 'Korean'}, {code: 'ku', label: 'Kurdish'}, {code: 'ky', label: 'Kyrgyz'},
  {code: 'lo', label: 'Lao'}, {code: 'la', label: 'Latin'}, {code: 'lv', label: 'Latvian'},
  {code: 'lt', label: 'Lithuanian'}, {code: 'mk', label: 'Macedonian'}, {code: 'ms', label: 'Malay'},
  {code: 'ml', label: 'Malayalam'}, {code: 'mt', label: 'Maltese'}, {code: 'mi', label: 'Maori'},
  {code: 'mr', label: 'Marathi'}, {code: 'mn', label: 'Mongolian'}, {code: 'ne', label: 'Nepali'},
  {code: 'no', label: 'Norwegian'}, {code: 'ps', label: 'Pashto'}, {code: 'fa', label: 'Persian'},
  {code: 'pl', label: 'Polish'}, {code: 'pt', label: 'Portuguese'}, {code: 'pa', label: 'Punjabi'},
  {code: 'ro', label: 'Romanian'}, {code: 'ru', label: 'Russian'}, {code: 'sm', label: 'Samoan'},
  {code: 'gd', label: 'Scots Gaelic'}, {code: 'sr', label: 'Serbian'}, {code: 'sn', label: 'Shona'},
  {code: 'sd', label: 'Sindhi'}, {code: 'si', label: 'Sinhala'}, {code: 'sk', label: 'Slovak'},
  {code: 'sl', label: 'Slovenian'}, {code: 'so', label: 'Somali'}, {code: 'es', label: 'Spanish'},
  {code: 'su', label: 'Sundanese'}, {code: 'sw', label: 'Swahili'}, {code: 'sv', label: 'Swedish'},
  {code: 'tg', label: 'Tajik'}, {code: 'ta', label: 'Tamil'}, {code: 'te', label: 'Telugu'},
  {code: 'th', label: 'Thai'}, {code: 'tr', label: 'Turkish'}, {code: 'uk', label: 'Ukrainian'},
  {code: 'ur', label: 'Urdu'}, {code: 'uz', label: 'Uzbek'}, {code: 'vi', label: 'Vietnamese'},
  {code: 'cy', label: 'Welsh'}, {code: 'xh', label: 'Xhosa'}, {code: 'yi', label: 'Yiddish'},
  {code: 'yo', label: 'Yoruba'}, {code: 'zu', label: 'Zulu'}
];

const API = import.meta.env.DEV ? "http://localhost:8000" : "";

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${m}:${sec.padStart(4, '0')}`;
}

function App() {
  const [uiScale, setUiScale] = useState(1);
  const [mode, setMode] = useState('launchpad');
  const [text, setText] = useState('');
  const [refAudio, setRefAudio] = useState(null);
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
  const [sidebarTab, setSidebarTab] = useState('projects'); // 'projects' | 'history'
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
        const [sysRes, modelRes] = await Promise.all([
          fetch(`${API}/sysinfo`),
          fetch(`${API}/model/status`),
        ]);
        if (sysRes.ok) setSysStats(await sysRes.json());
        if (modelRes.ok) {
          const ms = await modelRes.json();
          setModelStatus(ms.status);
        }
        return true; // success
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
    try {
      const res = await fetch(`${API}/profiles`);
      if (res.ok) setProfiles(await res.json());
    } catch (e) {}
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API}/history`);
      if (res.ok) setHistory(await res.json());
    } catch (e) {}
  }, []);

  const loadDubHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API}/dub/history`);
      if (res.ok) setDubHistory(await res.json());
    } catch (e) {}
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch(`${API}/projects`);
      if (res.ok) setStudioProjects(await res.json());
    } catch (e) {}
  }, []);

  const loadExportHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API}/export/history`);
      if (res.ok) setExportHistory(await res.json());
    } catch (e) {}
  }, []);

  useEffect(() => {
    // Wait for backend to come alive before loading data (handles Tauri startup race)
    let cancelled = false;
    const loadAll = async () => {
      // Retry until backend responds (exponential backoff: 1s, 2s, 4s max)
      let delay = 1000;
      while (!cancelled) {
        try {
          const res = await fetch(`${API}/model/status`);
          if (res.ok) break; // backend is alive
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
      if (saved.dubSegments) setDubSegments(saved.dubSegments);
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

      const response = await fetch(`${API}/generate`, { method: "POST", body: formData });
      if (!response.ok) throw new Error(await response.text());

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
      const res = await fetch(`${API}/profiles`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
      setShowSaveProfile(false);
      setProfileName('');
      await loadProfiles();
    } catch (e) { toast.error(e.message); }
  };

  const handleDeleteProfile = async (id) => {
    if (!confirm('Delete this voice profile?')) return;
    await fetch(`${API}/profiles/${id}`, { method: "DELETE" });
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
      const res = await fetch(`${API}/generate`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
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
      
      const res = await fetch(`${API}/generate`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
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
      
      const response = await fetch(`${API}/audio/${item.audio_path}?t=${Date.now()}`);
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

      const res = await fetch(`${API}/profiles`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
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
      const res = await fetch(`${API}/profiles/${profileId}/lock`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
      toast.success("🔒 Voice locked! Identity is now consistent across all generations.");
      await loadProfiles();
    } catch (e) {
      toast.error(e.message || "Failed to lock profile");
    }
  };

  const handleUnlockProfile = async (profileId) => {
    try {
      const res = await fetch(`${API}/profiles/${profileId}/unlock`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
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
          const res = await fetch(`${API}/clean-audio`, { method: "POST", body: formData });
          if (!res.ok) throw new Error(await res.text());

          const cleanBlob = await res.blob();
          const cleanFilename = res.headers.get("X-Clean-Filename") || "recording_clean.wav";
          const cleanFile = new File([cleanBlob], cleanFilename, { type: "audio/wav" });

          setRefAudio(cleanFile);
          setSelectedProfile(null);
          toast.success("🎙️ Recording cleaned & loaded!");
        } catch (e) {
          // Fallback: use raw recording without denoising
          const rawFile = new File([blob], "recording.webm", { type: "audio/webm" });
          setRefAudio(rawFile);
          setSelectedProfile(null);
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
      const fd = new FormData();
      fd.append("video", dubVideoFile);
      fd.append("job_id", clientJobId);
      const res = await fetch(`${API}/dub/upload`, { method: "POST", body: fd, signal: ctrl.signal });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDubJobId(data.job_id); setDubFilename(data.filename); setDubDuration(data.duration);
      setDubStep('transcribing');
      setTranscribeStart(Date.now());
      const tRes = await fetch(`${API}/dub/transcribe/${data.job_id}`, { method: "POST", signal: ctrl.signal });
      if (!tRes.ok) throw new Error(await tRes.text());
      const tData = await tRes.json();
      setDubSegments(tData.segments.map((s, i) => ({ ...s, id: i })));
      setDubTranscript(tData.full_transcript || '');
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
      try { await fetch(`${API}/dub/abort/${jobId}`, { method: 'POST' }); } catch (_) {}
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
      const res = await fetch(`${API}/dub/cleanup-segments/${dubJobId}`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
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
      const res = await fetch(`${API}/dub/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments: dubSegments.map(s => ({ id: s.id, text: s.text, target_lang: s.target_lang })),
          target_lang: dubLangCode,
          provider: translateProvider,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const translatedMap = {};
      data.translated.forEach(t => { translatedMap[t.id] = t.text; });
      setDubSegments(dubSegments.map(s => ({ ...s, text: translatedMap[s.id] || s.text })));
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
      const res = await fetch(`${API}/dub/generate/${dubJobId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to start generation");

      setDubTaskId(data.task_id);

      // Connect to background task SSE stream
      const streamRes = await fetch(`${API}/tasks/stream/${data.task_id}`);
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
      await fetch(`${API}/tasks/cancel/${dubTaskId}`, { method: 'POST' });
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

      // Tell Python backend to natively execute the copy bypassing Blob serialization!
      const res = await fetch(`${API}/export`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ source_filename: sourceIdentifier, destination_path: destPath, mode })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Export failed');
      }
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
      const res = await fetch(`${API}/export/reveal`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ path: filePath })
      });
      if (!res.ok) throw new Error('Failed to open folder');
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
          await fetch(`${API}/export/record`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ filename: data.display_name || fallbackName, destination_path: data.path, mode: modeGuess })
          });
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
        await fetch(`${API}/export/record`, {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ filename: finalName, destination_path: `~/Downloads/${finalName}`, mode: modeGuess })
        });
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
      let res;
      if (activeProjectId) {
        res = await fetch(`${API}/projects/${activeProjectId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(statePayload),
        });
      } else {
        res = await fetch(`${API}/projects`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(statePayload),
        });
      }
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
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
      const res = await fetch(`${API}/projects/${pid}`);
      if (!res.ok) throw new Error('Failed to load project');
      const data = await res.json();
      const s = data.state || {};
      setMode('dub');
      setActiveProjectId(data.id);
      setActiveProjectName(data.name);
      setDubJobId(s.dubJobId || null);
      setDubFilename(s.dubFilename || data.video_path || '');
      setDubDuration(s.dubDuration || data.duration || 0);
      setDubSegments(s.dubSegments || []);
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
      await fetch(`${API}/projects/${projectId}`, { method: 'DELETE' });
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
      setDubSegments((job.segments || []).map((s, i) => ({ ...s, id: s.id !== undefined ? s.id : i })));
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
    <div className={`app-container${isSidebarCollapsed ? ' sidebar-collapsed' : ''}`} style={{ zoom: uiScale }}>
      <Toaster position="top-center" toastOptions={{
        style: { background: 'rgba(40,40,40,0.9)', backdropFilter: 'blur(10px)', color: '#ebdbb2', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.72rem', padding: '4px 8px' },
        error: { iconTheme: { primary: '#fb4934', secondary: '#fff' } },
        success: { iconTheme: { primary: '#b8bb26', secondary: '#fff' } }
      }}/>
      <div className="header-area" data-tauri-drag-region onDoubleClick={doubleClickMaximize} style={{display:'grid', gridTemplateColumns:'1fr auto 1fr', alignItems:'center', gridColumn: '1 / -1', gridRow: '1', cursor: 'default', paddingRight:'8px'}}>
        {/* Left cluster: traffic light buffer + tabs + dev panel */}
        <div style={{display:'flex', alignItems:'center', gap:'16px', justifySelf:'start', minWidth:0}}>
          <div style={{minWidth: 80, flexShrink:0}}></div>
          <div className="tabs" style={{marginBottom: 0, flexShrink: 0}}>
            <button className={`tab ${mode === 'launchpad' ? 'active' : ''}`} style={{whiteSpace:'nowrap'}} onClick={() => setMode('launchpad')}><Globe size={11}/> Launchpad</button>
            <button className={`tab ${mode === 'clone' ? 'active' : ''}`} style={{whiteSpace:'nowrap'}} onClick={() => setMode('clone')}><Fingerprint size={11}/> Clone</button>
            <button className={`tab ${mode === 'design' ? 'active' : ''}`} style={{whiteSpace:'nowrap'}} onClick={() => setMode('design')}><Wand2 size={11}/> Design</button>
            <button className={`tab ${mode === 'dub' ? 'active' : ''}`} style={{whiteSpace:'nowrap'}} onClick={() => setMode('dub')}><Film size={11}/> Dub</button>
          </div>
          {import.meta.env.DEV && (
            <button onClick={() => window.location.reload()} title="Force Reload UI" style={{display:'flex', alignItems:'center', gap:4, background:'transparent', border:'1px solid rgba(250,189,47,0.3)', color:'#fabd2f', padding:'3px 8px', borderRadius:4, fontSize:'0.55rem', cursor:'pointer', flexShrink:0}}>
              <RefreshCw size={9}/> Reload
            </button>
          )}
        </div>

        {/* Center: logo */}
        <div style={{display:'flex', alignItems:'center', gap:'6px', justifySelf:'center', pointerEvents:'none', whiteSpace:'nowrap'}}>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d3869b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" opacity="0.15" fill="#d3869b"/>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v12" />
            <path d="M8 9v6" />
            <path d="M16 9v6" />
          </svg>
          <span style={{fontSize:'0.85rem', fontWeight:700, color:'#ebdbb2', letterSpacing:'-0.01em', fontFamily:'Outfit, sans-serif'}}>OmniVoice</span>
        </div>

        {/* Right cluster: scale + stats */}
        <div style={{display: 'flex', alignItems: 'center', justifyContent:'flex-end', gap: '6px', justifySelf:'end', minWidth:0, overflow:'hidden'}}>
          <div style={{display:'flex', gap:1, background:'rgba(0,0,0,0.25)', padding:2, borderRadius:4, border:'1px solid rgba(255,255,255,0.04)', flexShrink:0}}>
            <button onClick={() => setUiScale(1)} style={{fontSize:'0.55rem', padding:'1px 4px', border:'none', borderRadius:3, cursor:'pointer', background: uiScale === 1 ? 'rgba(255,255,255,0.1)' : 'transparent', color: uiScale === 1 ? '#fff' : '#665c54', whiteSpace:'nowrap'}}>S</button>
            <button onClick={() => setUiScale(1.3)} style={{fontSize:'0.55rem', padding:'1px 4px', border:'none', borderRadius:3, cursor:'pointer', background: uiScale === 1.3 ? 'rgba(255,255,255,0.1)' : 'transparent', color: uiScale === 1.3 ? '#fff' : '#665c54', whiteSpace:'nowrap'}}>M</button>
            <button onClick={() => setUiScale(1.5)} style={{fontSize:'0.55rem', padding:'1px 4px', border:'none', borderRadius:3, cursor:'pointer', background: uiScale === 1.5 ? 'rgba(255,255,255,0.1)' : 'transparent', color: uiScale === 1.5 ? '#fff' : '#665c54', whiteSpace:'nowrap'}}>L</button>
          </div>
          {sysStats && (
            <div style={{display:'flex', gap:'6px', fontSize:'0.52rem', color:'#665c54', background:'rgba(0,0,0,0.25)', padding:'2px 6px', borderRadius:'4px', border:'1px solid rgba(255,255,255,0.04)', whiteSpace:'nowrap', flexShrink:0, alignItems:'center'}}>
              <span><b style={{color:'#a89984', fontWeight:500}}>RAM</b> {sysStats.ram.toFixed(1)}/{sysStats.total_ram.toFixed(0)}G</span>
              <span><b style={{color:'#a89984', fontWeight:500}}>CPU</b> {sysStats.cpu.toFixed(0)}%</span>
              <span style={{borderLeft:'1px solid rgba(255,255,255,0.06)', paddingLeft:5}}>
                <b style={{color: sysStats.gpu_active ? '#8ec07c' : '#a89984', fontWeight:500}}>VRAM</b> {sysStats.vram.toFixed(1)}G
              </span>
              <span style={{borderLeft:'1px solid rgba(255,255,255,0.06)', paddingLeft:5, display:'flex', alignItems:'center', gap:3}}>
                <span style={{
                  width:5, height:5, borderRadius:'50%', display:'inline-block',
                  background: modelStatus === 'ready' ? '#8ec07c' : modelStatus === 'loading' ? '#fabd2f' : '#504945',
                  boxShadow: modelStatus === 'loading' ? '0 0 4px rgba(250,189,47,0.4)' : 'none',
                  animation: modelStatus === 'loading' ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }}/>
                <span style={{color: modelStatus === 'ready' ? '#8ec07c' : modelStatus === 'loading' ? '#fabd2f' : '#504945'}}>
                  {modelStatus === 'ready' ? 'Ready' : modelStatus === 'loading' ? 'Loading…' : 'Idle'}
                </span>
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="main-content">

        {/* ═══ LAUNCHPAD TAB ═══ */}
        {mode === 'launchpad' ? (
          <div className="launchpad">
            {/* Hero */}
            <div className="lp-hero">
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start'}}>
                <div>
                  <div style={{display:'flex', alignItems:'center', gap:'10px', marginBottom:'6px'}}>
                    {/* Animated waveform decoration */}
                    <div style={{display:'flex', alignItems:'center', gap:'2px', height:'24px'}}>
                      {[14,20,10,24,16,22,12,18].map((h,i) => (
                        <span key={i} className="lp-wave-bar" style={{
                          height: h, background: `linear-gradient(to top, #d3869b, #fabd2f)`,
                          animationDelay: `${i * 0.15}s`, opacity: 0.6 + (i % 3) * 0.15
                        }}/>
                      ))}
                    </div>
                    <span style={{fontSize:'0.6rem', fontWeight:600, letterSpacing:'0.12em', textTransform:'uppercase', color:'#665c54'}}>Studio</span>
                  </div>
                  <h1>OmniVoice Studio</h1>
                  <p>Clone any voice. Design new ones. Dub video in 646 languages.</p>
                </div>
                <button className="btn-primary" onClick={() => setIsCompareModalOpen(true)} style={{display:'flex', alignItems:'center', gap:6, padding:'8px 16px', fontSize:'0.75rem', width:'auto', marginTop:8, borderRadius:8, flexShrink:0}}>
                  <Scale size={14}/> A/B Compare
                </button>
              </div>

              {/* Progress Steps */}
              <div style={{display:'flex', alignItems:'center', gap:0, marginTop:'24px'}}>
                <div className={`lp-step ${profiles.length > 0 ? 'completed' : ''}`}>
                  <div className="lp-step-num">{profiles.length > 0 ? <Check size={11}/> : '1'}</div>
                  <div>
                    <div style={{fontSize:'0.68rem', fontWeight:600, color: profiles.length > 0 ? '#b8bb26' : '#a89984'}}>Create Voice</div>
                    <div style={{fontSize:'0.55rem', color:'#504945'}}>Clone or design</div>
                  </div>
                </div>
                <div className="lp-step-connector"/>
                <div className={`lp-step ${studioProjects.length > 0 ? 'completed' : ''}`}>
                  <div className="lp-step-num">{studioProjects.length > 0 ? <Check size={11}/> : '2'}</div>
                  <div>
                    <div style={{fontSize:'0.68rem', fontWeight:600, color: studioProjects.length > 0 ? '#b8bb26' : '#a89984'}}>Upload Video</div>
                    <div style={{fontSize:'0.55rem', color:'#504945'}}>Transcribe audio</div>
                  </div>
                </div>
                <div className="lp-step-connector"/>
                <div className={`lp-step ${dubHistory.length > 0 ? 'completed' : ''}`}>
                  <div className="lp-step-num">{dubHistory.length > 0 ? <Check size={11}/> : '3'}</div>
                  <div>
                    <div style={{fontSize:'0.68rem', fontWeight:600, color: dubHistory.length > 0 ? '#b8bb26' : '#a89984'}}>Generate Dub</div>
                    <div style={{fontSize:'0.55rem', color:'#504945'}}>Export dubbed video</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Action Cards */}
            <div className="lp-actions">
              <div className="lp-action-card lp-animate" onClick={() => setMode('clone')}
                style={{'--card-accent':'rgba(211,134,155,0.1)', '--card-border':'rgba(211,134,155,0.25)'}}>
                {profiles.filter(p => !p.instruct).length > 0 && <span className="card-count" style={{background:'rgba(211,134,155,0.12)', color:'#d3869b'}}>{profiles.filter(p => !p.instruct).length}</span>}
                <div className="card-icon" style={{background:'rgba(211,134,155,0.1)'}}>
                  <Fingerprint size={18} color="#d3869b"/>
                </div>
                <h3>Voice Clone</h3>
                <p className="card-desc">Upload a reference audio and clone any voice with a single sample. Instant identity capture.</p>
              </div>

              <div className="lp-action-card lp-animate" onClick={() => setMode('design')}
                style={{'--card-accent':'rgba(142,192,124,0.1)', '--card-border':'rgba(142,192,124,0.25)'}}>
                {profiles.filter(p => !!p.instruct).length > 0 && <span className="card-count" style={{background:'rgba(142,192,124,0.12)', color:'#8ec07c'}}>{profiles.filter(p => !!p.instruct).length}</span>}
                <div className="card-icon" style={{background:'rgba(142,192,124,0.1)'}}>
                  <Wand2 size={18} color="#8ec07c"/>
                </div>
                <h3>Voice Design</h3>
                <p className="card-desc">Craft entirely new voices from text instructions. Control gender, age, accent, and emotion.</p>
              </div>

              <div className="lp-action-card lp-animate" onClick={() => setMode('dub')}
                style={{'--card-accent':'rgba(254,128,25,0.1)', '--card-border':'rgba(254,128,25,0.25)'}}>
                {studioProjects.length > 0 && <span className="card-count" style={{background:'rgba(254,128,25,0.12)', color:'#fe8019'}}>{studioProjects.length}</span>}
                <div className="card-icon" style={{background:'rgba(254,128,25,0.1)'}}>
                  <Film size={18} color="#fe8019"/>
                </div>
                <h3>Video Dubbing</h3>
                <p className="card-desc">Transcribe, translate, and re-voice any video with speaker-level control and timeline editing.</p>
              </div>
            </div>

            {/* Recent Projects */}
            {(profiles.length > 0 || studioProjects.length > 0) && (
              <div className="lp-section">
                <div style={{display:'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px'}}>
                  
                  {/* Cloned voices */}
                  {profiles.filter(p => !p.instruct).length > 0 && (
                    <div>
                      <div className="lp-section-title"><Fingerprint size={12} color="#d3869b"/> Cloned Voices</div>
                      <div style={{display:'flex', flexDirection:'column', gap:'8px'}}>
                        {profiles.filter(p => !p.instruct).map(p => (
                          <div key={p.id} className="lp-project-card">
                            <div className="proj-icon" style={{background:'rgba(211,134,155,0.1)'}}><Fingerprint size={14} color="#d3869b"/></div>
                            <div className="proj-info">
                              <div className="proj-name">{p.name}</div>
                              <div className="proj-meta">{p.ref_audio_path}</div>
                            </div>
                            <button className="proj-action" onClick={() => { setMode('clone'); handleSelectProfile(p); }}>Open</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Designed voices */}
                  {profiles.filter(p => !!p.instruct).length > 0 && (
                    <div>
                      <div className="lp-section-title"><Wand2 size={12} color="#8ec07c"/> Designed Voices</div>
                      <div style={{display:'flex', flexDirection:'column', gap:'8px'}}>
                        {profiles.filter(p => !!p.instruct).map(p => (
                          <div key={p.id} className="lp-project-card">
                            <div className="proj-icon" style={{background: p.is_locked ? 'rgba(184,187,38,0.1)' : 'rgba(142,192,124,0.1)'}}>
                              {p.is_locked ? <Lock size={14} color="#b8bb26"/> : <Wand2 size={14} color="#8ec07c"/>}
                            </div>
                            <div className="proj-info">
                              <div className="proj-name">{p.name}</div>
                              <div className="proj-meta" style={{fontStyle:'italic'}}>{p.instruct}</div>
                            </div>
                            {p.is_locked && <span style={{fontSize:'0.5rem', padding:'1px 6px', borderRadius:4, background:'rgba(184,187,38,0.12)', color:'#b8bb26', fontWeight:600}}>LOCKED</span>}
                            <button className="proj-action" onClick={() => { setMode('design'); handleSelectProfile(p); }}>Open</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Dubbing projects */}
                  {studioProjects.length > 0 && (
                    <div>
                      <div className="lp-section-title"><Film size={12} color="#fe8019"/> Dubbing Projects</div>
                      <div style={{display:'flex', flexDirection:'column', gap:'8px'}}>
                        {studioProjects.map(proj => (
                          <div key={proj.id} className="lp-project-card">
                            <div className="proj-icon" style={{background:'rgba(254,128,25,0.1)'}}><Film size={14} color="#fe8019"/></div>
                            <div className="proj-info">
                              <div className="proj-name">{proj.name}</div>
                              <div className="proj-meta">{proj.video_path || "Audio Only"}</div>
                            </div>
                            <button className="proj-action" onClick={() => { setMode('dub'); loadProject(proj.id); }}>Open</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Empty state */}
            {profiles.length === 0 && studioProjects.length === 0 && (
              <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', position:'relative', zIndex:1}}>
                <div style={{textAlign:'center', maxWidth:360}}>
                  <div style={{display:'flex', justifyContent:'center', gap:'3px', marginBottom:'16px', opacity:0.3}}>
                    {[8,14,22,18,26,14,20,10,16].map((h,i) => (
                      <span key={i} className="lp-wave-bar" style={{
                        height: h, background:'#665c54', animationDelay: `${i * 0.12}s`
                      }}/>
                    ))}
                  </div>
                  <p style={{fontSize:'0.8rem', color:'#504945', margin:0}}>No projects yet. Click a card above to get started.</p>
                </div>
              </div>
            )}
          </div>
        ) : mode === 'dub' ? (
          <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0}}>
            {/* ── Idle: show full editor skeleton with drop zone ── */}
            {!(dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done')) && (
              <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0}}>
                {/* Header bar (matches editing layout) */}
                <div className="glass-panel" style={{padding:'4px 8px', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0}}>
                  <div className="label-row" style={{marginBottom:0, alignItems: 'center'}}>
                    <button 
                      onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                      style={{display:'flex', alignItems:'center', justifyContent:'center', padding:'3px', marginRight:'6px', background: isSidebarCollapsed ? 'rgba(211,134,155,0.1)' : 'rgba(255,255,255,0.05)', border:`1px solid ${isSidebarCollapsed ? 'rgba(211,134,155,0.3)' : 'rgba(255,255,255,0.08)'}`, color: isSidebarCollapsed ? '#d3869b' : '#a89984', borderRadius:4, cursor:'pointer'}}
                      title="Toggle Sidebar"
                    >
                      {isSidebarCollapsed ? <PanelLeftOpen size={12}/> : <PanelLeftClose size={12}/>}
                    </button>
                    <Film className="label-icon" size={11}/> <span style={{fontWeight:600}}>{dubVideoFile ? dubVideoFile.name : 'Video Dubbing Studio'}</span>
                    {dubVideoFile && <span style={{color:'#a89984', fontWeight:400}}> · {(dubVideoFile.size/1024/1024).toFixed(1)} MB</span>}
                    {activeProjectName && <span style={{color:'#b8bb26', marginLeft:6}}>— {activeProjectName}</span>}
                  </div>
                  <div style={{display:'flex', gap:4, alignItems:'center'}}>
                    <button disabled style={{background:'none', border:'1px solid rgba(184,187,38,0.15)', color:'#665c54', fontSize:'0.62rem', padding:'2px 6px', borderRadius:3, cursor:'default', display:'flex', alignItems:'center', gap:3}}>
                      <Save size={9}/> Save
                    </button>
                    <button disabled style={{background:'none', border:'1px solid rgba(251,73,52,0.12)', color:'#665c54', fontSize:'0.62rem', padding:'2px 6px', borderRadius:3, cursor:'default'}}>Reset</button>
                  </div>
                </div>

                {/* ═══ SPLIT LAYOUT skeleton ═══ */}
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, flex:1, minHeight:0}}>

                  {/* LEFT: Video area as drop zone / waveform placeholder */}
                  <div className="glass-panel" style={{marginBottom:0, overflow:'hidden', display:'flex', flexDirection:'column'}}>
                    {dubVideoFile ? (
                      <>
                        <WaveformTimeline
                          audioSrc={dubLocalBlobUrl?.audioUrl}
                          videoSrc={dubLocalBlobUrl?.videoUrl}
                          segments={[]}
                          onSegmentsChange={() => {}}
                          disabled={true}
                          overlayContent={
                            dubStep === 'uploading' ? (
                              <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:10}}>
                                <Loader className="spinner" size={20} color="#d3869b"/>
                                <span style={{color:'#ebdbb2', fontWeight:500, fontSize:'0.85rem'}}>Extracting audio…</span>
                                <button onClick={handleDubAbort} style={{
                                  display:'flex', alignItems:'center', gap:6, padding:'5px 12px',
                                  background:'rgba(251,73,52,0.15)', border:'1px solid rgba(251,73,52,0.4)',
                                  color:'#fb4934', borderRadius:6, fontSize:'0.75rem', cursor:'pointer',
                                }}><Square size={11}/> Stop</button>
                              </div>
                            ) : dubStep === 'transcribing' ? (
                              <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:10, width:'100%'}}>
                                <div style={{display:'flex', alignItems:'center', gap:8}}>
                                  <Loader className="spinner" size={18} color="#d3869b"/>
                                  <span style={{color:'#ebdbb2', fontWeight:500, fontSize:'0.85rem'}}>Transcribing with Whisper…</span>
                                </div>
                                <div style={{display:'flex', gap:14, fontSize:'0.78rem', color:'#a89984'}}>
                                  <span>⏱ {Math.floor(transcribeElapsed/60)}:{String(transcribeElapsed%60).padStart(2,'0')} elapsed</span>
                                  {dubDuration > 0 && (() => {
                                    const est = Math.max(10, Math.ceil(dubDuration/60)*3+8);
                                    return <span>~{Math.max(0, est - transcribeElapsed)}s remaining</span>;
                                  })()}
                                </div>
                                {dubDuration > 0 && (
                                  <div className="progress-container" style={{width:'80%', maxWidth:340}}>
                                    <div className="progress-fill" style={{
                                      width:`${Math.min(95,(transcribeElapsed/Math.max(10,Math.ceil(dubDuration/60)*3+8))*100)}%`
                                    }}/>
                                  </div>
                                )}
                                <button onClick={handleDubAbort} style={{
                                  display:'flex', alignItems:'center', gap:6, padding:'5px 12px',
                                  background:'rgba(251,73,52,0.15)', border:'1px solid rgba(251,73,52,0.4)',
                                  color:'#fb4934', borderRadius:6, fontSize:'0.75rem', cursor:'pointer',
                                }}><Square size={11}/> Stop</button>
                              </div>
                            ) : null
                          }
                        />
                        {/* Action row */}
                        <div style={{display:'flex', gap:8, marginTop:8, alignItems:'center'}}>
                          <label htmlFor="video-upload" style={{
                            display:'flex', alignItems:'center', gap:6, padding:'6px 12px',
                            background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)',
                            borderRadius:6, cursor:'pointer', fontSize:'0.8rem', color:'#a89984',
                          }}>
                            <Film size={13}/> Change file
                          </label>
                          <button className="btn-primary" style={{flex:1, marginTop:0}}
                            onClick={handleDubUpload}
                            disabled={dubStep === 'uploading' || dubStep === 'transcribing'}>
                            {dubStep === 'uploading' || dubStep === 'transcribing'
                              ? <><Loader className="spinner" size={14}/> Processing…</>
                              : <><Sparkles size={14}/> Upload &amp; Transcribe</>}
                          </button>
                        </div>
                      </>
                    ) : (
                      /* Empty video drop zone that fills the panel */
                      <label htmlFor="video-upload" style={{
                        flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                        gap:14, cursor:'pointer', border:'2px dashed rgba(255,255,255,0.06)',
                        borderRadius:8, transition:'all 0.3s', margin:4,
                      }}
                      onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor='#d3869b'; e.currentTarget.style.background='rgba(211,134,155,0.05)'; }}
                      onDragLeave={e => { e.currentTarget.style.borderColor='rgba(255,255,255,0.06)'; e.currentTarget.style.background='transparent'; }}
                      onDrop={e => {
                        e.preventDefault();
                        e.currentTarget.style.borderColor='rgba(255,255,255,0.06)';
                        e.currentTarget.style.background='transparent';
                        const file = e.dataTransfer.files[0];
                        if (file && file.type.startsWith('video/')) {
                          setDubVideoFile(file);
                          setDubStep('idle');
                          fileToMediaUrl(file, null).then(urls => setDubLocalBlobUrl(urls));
                        }
                      }}>
                        <div style={{width:60, height:60, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(211,134,155,0.06)', border:'1px solid rgba(211,134,155,0.1)'}}>
                          <UploadCloud color="#d3869b" size={28}/>
                        </div>
                        <div style={{textAlign:'center'}}>
                          <div style={{fontSize:'0.9rem', color:'#ebdbb2', fontWeight:500, marginBottom:4}}>Drop video here</div>
                          <div style={{fontSize:'0.7rem', color:'#665c54'}}>MP4 · MOV · MKV · WEBM</div>
                        </div>
                      </label>
                    )}

                    <input type="file" accept="video/*" id="video-upload" style={{display:'none'}}
                      onChange={e => {
                        const file = e.target.files[0];
                        if (!file) return;
                        setDubVideoFile(file);
                        setDubStep('idle');
                        setDubLocalBlobUrl(prev => { fileToMediaUrl(file, prev).then(urls => setDubLocalBlobUrl(urls)); return prev; });
                      }}/>

                    {/* Ghost cast row */}
                    <div style={{marginTop:4, padding:'3px 6px', background:'rgba(255,255,255,0.015)', borderRadius:4, border:'1px solid rgba(255,255,255,0.03)'}}>
                      <div style={{display:'flex', gap:8, alignItems:'center'}}>
                        <span style={{fontSize:'0.62rem', color:'#504945', fontWeight:600}}>CAST</span>
                        <span style={{fontSize:'0.62rem', color:'#504945'}}>Speaker 1:</span>
                        <span style={{fontSize:'0.62rem', color:'#504945', padding:'1px 4px', background:'rgba(255,255,255,0.02)', borderRadius:2}}>Default</span>
                      </div>
                    </div>
                  </div>

                  {/* RIGHT: Ghost settings + segment table */}
                  <div className="glass-panel" style={{marginBottom:0, display:'flex', flexDirection:'column', overflow:'hidden'}}>
                    {/* Settings row (disabled) */}
                    <div style={{display:'flex', gap:4, marginBottom:4, flexWrap:'wrap', alignItems:'flex-end', opacity:0.4}}>
                      <div style={{flex:1, minWidth:90}}>
                        <div className="label-row"><Globe className="label-icon" size={9}/> Language</div>
                        <select className="input-base" disabled style={{fontSize:'0.65rem'}}>
                          <option>Auto</option>
                        </select>
                      </div>
                      <div style={{flex:1, minWidth:80}}>
                        <div className="label-row">ISO Code</div>
                        <select className="input-base" disabled style={{fontSize:'0.65rem'}}>
                          <option>en — English</option>
                        </select>
                      </div>
                      <div style={{flex:1, minWidth:90}}>
                        <div className="label-row"><UserSquare2 className="label-icon" size={9}/> Style</div>
                        <input className="input-base" disabled placeholder="e.g. female" style={{fontSize:'0.65rem'}}/>
                      </div>
                      <button disabled style={{padding:'3px 8px', background:'rgba(131,165,152,0.08)', border:'1px solid rgba(131,165,152,0.12)', color:'#504945', borderRadius:4, fontSize:'0.62rem', display:'flex', alignItems:'center', gap:3, whiteSpace:'nowrap'}}>
                        <Languages size={10}/> Translate All
                      </button>
                    </div>

                    {/* Ghost transcript toggle */}
                    <div style={{marginBottom:4}}>
                      <div className="override-toggle" style={{marginTop:0, padding:'2px 6px', fontSize:'0.65rem', opacity:0.3, cursor:'default'}}>
                        <span><FileText size={10} style={{verticalAlign:'middle', marginRight:3}}/> Transcript</span>
                        <ChevronDown size={10}/>
                      </div>
                    </div>

                    {/* Ghost segment table */}
                    <div className="segment-table" style={{flex:1, maxHeight:'none', overflowY:'auto', minHeight:0}}>
                      <div className="segment-header">
                        <span style={{width:55}}>Time</span>
                        <span style={{width:50}}>Spkr</span>
                        <span style={{flex:1}}>Text</span>
                        <span style={{width:90}}>Voice</span>
                        <span style={{width:40}}></span>
                      </div>
                      {/* Placeholder ghost rows */}
                      {[1,2,3,4,5,6,7,8].map(i => (
                        <div key={i} className="segment-row" style={{opacity: 0.15 + (0.04 * (8-i))}}>
                          <span className="segment-time" style={{width:55}}>0:00.0–0:00.0</span>
                          <span style={{width:50, fontSize:'0.58rem', color:'#504945'}}>Speaker 1</span>
                          <div style={{flex:1, height:18, background:'rgba(255,255,255,0.03)', borderRadius:3}}/>
                          <span style={{width:90, fontSize:'0.6rem', color:'#504945'}}>Default</span>
                          <div style={{display:'flex', gap:1, width:40}}>
                            <span className="segment-del" style={{opacity:0.3}}><Trash2 size={9}/></span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* ═══ Ghost footer bar ═══ */}
                <div className="glass-panel" style={{padding:'4px 8px', flexShrink:0}}>
                  <div style={{display:'flex', gap:4}}>
                    <button className="btn-primary" disabled style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem', opacity:0.4}}>
                      <Play size={11}/> Generate Dub
                    </button>
                    <button className="btn-primary" disabled style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem', opacity:0.4}}>
                      <DownloadIcon size={11}/> MP4
                    </button>
                    <button className="btn-primary" disabled style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem', opacity:0.4}}>
                      <Volume2 size={11}/> WAV
                    </button>
                    <button className="btn-primary" disabled style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem', opacity:0.4}}>
                      <FileText size={11}/> SRT
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── After transcription: side-by-side editor ── */}
            {dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done') && (
              <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0}}>
                {/* Header bar */}
                <div className="glass-panel" style={{padding:'4px 8px', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0}}>
                  <div className="label-row" style={{marginBottom:0, alignItems: 'center'}}>
                    <button 
                      onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                      style={{display:'flex', alignItems:'center', justifyContent:'center', padding:'3px', marginRight:'6px', background: isSidebarCollapsed ? 'rgba(211,134,155,0.1)' : 'rgba(255,255,255,0.05)', border:`1px solid ${isSidebarCollapsed ? 'rgba(211,134,155,0.3)' : 'rgba(255,255,255,0.08)'}`, color: isSidebarCollapsed ? '#d3869b' : '#a89984', borderRadius:4, cursor:'pointer'}}
                      title="Toggle Sidebar"
                    >
                      {isSidebarCollapsed ? <PanelLeftOpen size={12}/> : <PanelLeftClose size={12}/>}
                    </button>
                    <FileText className="label-icon" size={11}/> <span style={{fontWeight:600}}>{dubFilename}</span>
                    <span style={{color:'#a89984', fontWeight:400}}> · {formatTime(dubDuration)} · {dubSegments.length} segs</span>
                    {activeProjectName && <span style={{color:'#b8bb26', marginLeft:6}}>— {activeProjectName}</span>}
                  </div>
                  <div style={{display:'flex', gap:4, alignItems:'center'}}>
                    <button onClick={saveProject} style={{background:'none', border:'1px solid rgba(184,187,38,0.3)', color:'#b8bb26', fontSize:'0.62rem', padding:'2px 6px', borderRadius:3, cursor:'pointer', display:'flex', alignItems:'center', gap:3}}>
                      <Save size={9}/> Save
                    </button>
                    <button onClick={resetDub} style={{background:'none', border:'1px solid rgba(251,73,52,0.25)', color:'#fb4934', fontSize:'0.62rem', padding:'2px 6px', borderRadius:3, cursor:'pointer'}}>Reset</button>
                  </div>
                </div>

                {/* ═══ SPLIT LAYOUT: Waveform | Segments ═══ */}
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, flex:1, minHeight:0}}>

                  {/* LEFT: Waveform + Video */}
                  <div className="glass-panel" style={{marginBottom:0, overflow:'hidden', display:'flex', flexDirection:'column'}}>
                    <WaveformTimeline
                      audioSrc={`${API}/dub/audio/${dubJobId}`}
                      videoSrc={`${API}/dub/media/${dubJobId}`}
                      segments={dubSegments}
                      onSegmentsChange={setDubSegments}
                      disabled={dubStep === 'generating' || dubStep === 'stopping'}
                      overlayContent={(dubStep === 'generating' || dubStep === 'stopping') ? (
                        <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:6, width:'100%'}}>
                          <div style={{display:'flex', alignItems:'center', gap:6}}>
                            {dubStep === 'stopping' ? <Loader className="spinner" size={14} color="#a89984"/> : <Sparkles className="spinner" size={14} color="#d3869b"/>}
                            <span style={{color: dubStep === 'stopping' ? '#a89984' : '#ebdbb2', fontWeight:500, fontSize:'0.72rem'}}>
                              {dubStep === 'stopping' ? 'Stopping…' : `Dubbing ${dubProgress.current}/${dubProgress.total}…`}
                            </span>
                          </div>
                          {dubStep === 'generating' && (
                            <>
                              <div className="progress-container" style={{width:'80%', maxWidth:240}}>
                                <div className="progress-fill" style={{
                                  width:`${dubProgress.total ? (dubProgress.current/dubProgress.total)*100 : 0}%`
                                }}/>
                              </div>
                              {dubProgress.text && <span style={{fontSize:'0.65rem', color:'#a89984'}}>{dubProgress.text}</span>}
                            </>
                          )}
                        </div>
                      ) : null}
                    />

                    {/* Cast Diarization — compact inline */}
                    {dubSegments.some(s => s.speaker_id) && (
                      <div style={{marginTop:4, padding:'3px 6px', background:'rgba(255,255,255,0.02)', borderRadius:4, border:'1px solid rgba(255,255,255,0.04)'}}>
                      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
                          <span style={{fontSize:'0.62rem', color:'#a89984', fontWeight:600}} title="Assign a voice profile to each speaker detected in the video">SPEAKER VOICES</span>
                          {[...new Set(dubSegments.map(s => s.speaker_id).filter(Boolean))].map(spk => (
                            <div key={spk} style={{display:'flex', alignItems:'center', gap:3}}>
                              <span style={{fontSize:'0.62rem', color:'#ebdbb2'}}>{spk}:</span>
                              <select className="input-base" style={{width:100, padding:'1px 4px', fontSize:'0.62rem'}}
                                value={dubSegments.find(s => s.speaker_id === spk)?.profile_id || ''}
                                onChange={e => {
                                  const val = e.target.value;
                                  setDubSegments(dubSegments.map(s => s.speaker_id === spk ? { ...s, profile_id: val } : s));
                                }}>
                                <option value="">Default</option>
                                {profiles.length > 0 && (
                                  <optgroup label="Clone Profiles">
                                    {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                  </optgroup>
                                )}
                                {PRESETS.length > 0 && (
                                  <optgroup label="Design Presets">
                                    {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>)}
                                  </optgroup>
                                )}
                              </select>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* RIGHT: Settings + Segment Table */}
                  <div className="glass-panel" style={{marginBottom:0, display:'flex', flexDirection:'column', overflow:'hidden'}}>
                    {/* Compact settings row */}
                    <div style={{display:'flex', gap:4, marginBottom:4, flexWrap:'wrap', alignItems:'flex-end'}}>
                      <div style={{flex:1, minWidth:90}}>
                        <div className="label-row"><Globe className="label-icon" size={9}/> Language</div>
                        <SearchableSelect
                          size="sm"
                          value={dubLang}
                          options={ALL_LANGUAGES}
                          popular={POPULAR_LANGS}
                          recentsKey="omnivoice.recents.dubLang"
                          onChange={(lang) => {
                            setDubLang(lang);
                            const match = LANG_CODES.find(lc => lc.label.toLowerCase() === lang.toLowerCase());
                            if (match) setDubLangCode(match.code);
                          }}
                        />
                      </div>
                      <div style={{flex:1, minWidth:80}}>
                        <div className="label-row">ISO Code</div>
                        <SearchableSelect
                          size="sm"
                          value={dubLangCode}
                          options={LANG_CODES.map(lc => ({ value: lc.code, label: `${lc.code} — ${lc.label}` }))}
                          popular={POPULAR_ISO}
                          recentsKey="omnivoice.recents.dubIso"
                          onChange={setDubLangCode}
                        />
                      </div>
                      <div style={{flex:1, minWidth:90}}>
                        <div className="label-row"><UserSquare2 className="label-icon" size={9}/> Style</div>
                        <input className="input-base" placeholder="e.g. female" value={dubInstruct} onChange={e => setDubInstruct(e.target.value)} style={{fontSize:'0.65rem'}}/>
                      </div>
                      <div style={{flex:1, minWidth:90}}>
                        <div className="label-row">Engine</div>
                        <select className="input-base" value={translateProvider} onChange={e => setTranslateProvider(e.target.value)} style={{fontSize:'0.65rem', padding: '5px 8px'}}>
                          {[{id: 'argos', name: 'Argos (Fast Local)'}, {id: 'nllb', name: 'NLLB (Heavy Local)'}, {id: 'google', name: 'Google (Online)'}, {id: 'openai', name: 'OpenAI (LLM)'}].map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                      <button onClick={handleTranslateAll} disabled={isTranslating || !dubSegments.length}
                        style={{padding:'3px 8px', background:'rgba(131,165,152,0.12)', border:'1px solid rgba(131,165,152,0.25)', color:'#83a598', borderRadius:4, cursor:'pointer', fontSize:'0.62rem', fontWeight:500, display:'flex', alignItems:'center', gap:3, whiteSpace:'nowrap'}}>
                        {isTranslating ? <Loader className="spinner" size={9}/> : <Languages size={10}/>}
                        {isTranslating ? 'Translating…' : 'Translate All'}
                      </button>
                      <button onClick={handleCleanupSegments} disabled={!dubSegments.length || !dubJobId}
                        title="Merge tiny fragments and adjacent short segments"
                        style={{padding:'3px 8px', background:'rgba(250,189,47,0.10)', border:'1px solid rgba(250,189,47,0.22)', color:'#fabd2f', borderRadius:4, cursor:'pointer', fontSize:'0.62rem', fontWeight:500, display:'flex', alignItems:'center', gap:3, whiteSpace:'nowrap'}}>
                        <Wand2 size={10}/> Clean Up
                      </button>
                    </div>

                    {/* Full transcript toggle */}
                    {dubTranscript && (
                      <div style={{marginBottom:4}}>
                        <div className="override-toggle" onClick={() => setShowTranscript(!showTranscript)} style={{marginTop:0, padding:'2px 6px', fontSize:'0.65rem'}}>
                          <span><FileText size={10} style={{verticalAlign:'middle', marginRight:3}}/> Transcript</span>
                          {showTranscript ? <ChevronUp size={10}/> : <ChevronDown size={10}/>}
                        </div>
                        {showTranscript && (
                          <div style={{background:'rgba(0,0,0,0.15)', border:'1px solid rgba(255,255,255,0.04)', borderTop:'none', borderRadius:'0 0 4px 4px', padding:6, fontSize:'0.65rem', color:'var(--text-secondary)', lineHeight:1.5, maxHeight:80, overflowY:'auto'}}>
                            {dubTranscript}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Apply voice to all segments */}
                    {dubSegments.length > 0 && profiles.length > 0 && (
                      <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:4, padding:'3px 6px', background:'rgba(142,192,124,0.06)', border:'1px solid rgba(142,192,124,0.12)', borderRadius:4}}>
                        <User size={10} color="#8ec07c"/>
                        <span style={{fontSize:'0.62rem', color:'#8ec07c', fontWeight:600, whiteSpace:'nowrap'}}>Apply Voice to All:</span>
                        <select className="input-base" style={{flex:1, fontSize:'0.62rem', padding:'2px 4px'}}
                          value=""
                          onChange={e => {
                            const val = e.target.value;
                            if (val === '__reset__') {
                              setDubSegments(dubSegments.map(s => ({ ...s, profile_id: '' })));
                            } else if (val) {
                              setDubSegments(dubSegments.map(s => ({ ...s, profile_id: val })));
                            }
                          }}>
                          <option value="">— Select profile —</option>
                          <option value="__reset__">⊘ Default (reset all)</option>
                          {profiles.filter(p => !p.instruct).length > 0 && (
                            <optgroup label="Clone Profiles">
                              {profiles.filter(p => !p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </optgroup>
                          )}
                          {profiles.filter(p => !!p.instruct).length > 0 && (
                            <optgroup label="Designed Voices">
                              {profiles.filter(p => !!p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}{p.is_locked ? ' 🔒' : ''}</option>)}
                            </optgroup>
                          )}
                        </select>
                      </div>
                    )}

                    {/* Segment table — fills remaining space */}
                    <div className="segment-table" style={{flex:1, maxHeight:'none', overflowY:'auto', minHeight:0}}>
                      <div className="segment-header">
                        <span style={{width:55}}>Time</span>
                        <span style={{width:50}}>Spkr</span>
                        <span style={{flex:1}}>Text</span>
                        <span style={{width:45}}>Lang</span>
                        <span style={{width:90}}>Voice</span>
                        <span style={{width:30}} title="Volume (0-200%)">Vol</span>
                        <span style={{width:40}}></span>
                      </div>
                      {dubSegments.map((seg, idx) => (
                        <div key={seg.id} className={`segment-row ${(dubStep==='generating'||dubStep==='stopping')&&dubProgress.current===idx+1?'segment-active':''} ${(dubStep==='generating'||dubStep==='stopping')&&dubProgress.current>idx+1?'segment-done':''}`}>
                          <span className="segment-time" style={{width:55, display:'flex', flexDirection:'column'}}>
                            <span>
                              {formatTime(seg.start)}–{formatTime(seg.end)}
                              {seg.speed && seg.speed !== 1.0 && (
                                <span style={{fontSize:'0.55rem', color: seg.speed > 1 ? '#d3869b' : '#8ec07c', marginLeft:2}}>
                                  {seg.speed.toFixed(2)}x
                                </span>
                              )}
                            </span>
                            {seg.sync_ratio !== undefined && (
                              <span style={{
                                fontSize: '0.5rem', 
                                marginTop: 2,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 2,
                                color: seg.sync_ratio >= 0.95 && seg.sync_ratio <= 1.05 ? '#b8bb26' : 
                                       seg.sync_ratio > 1.25 ? '#fb4934' : '#fabd2f'
                              }} title={`Generated audio is ${Math.round(seg.sync_ratio * 100)}% the duration of original`}>
                                {seg.sync_ratio >= 0.95 && seg.sync_ratio <= 1.05 ? <CheckCircle size={8}/> :
                                 seg.sync_ratio > 1.25 ? <AlertCircle size={8}/> : <Circle size={8}/>}
                                Sync: {Math.round(seg.sync_ratio * 100)}%
                              </span>
                            )}
                          </span>
                          <span style={{width:50, fontSize:'0.58rem', color:'#a89984'}}>{seg.speaker_id || ''}</span>
                          <input className="input-base segment-input" value={seg.text}
                            onChange={e => editSegments(dubSegments.map(s => s.id===seg.id?{...s,text:e.target.value}:s))}
                            disabled={dubStep==='generating'||dubStep==='stopping'}/>
                          <select className="input-base segment-input" style={{width:45, fontSize:'0.55rem', padding:'1px 2px'}}
                            value={seg.target_lang||''} disabled={dubStep==='generating'||dubStep==='stopping'}
                            onChange={e => editSegments(dubSegments.map(s => s.id===seg.id?{...s,target_lang:e.target.value}:s))}>
                            <option value="">(Def)</option>
                            {LANG_CODES.map(lc => <option key={lc.code} value={lc.code}>{lc.code.toUpperCase()}</option>)}
                          </select>
                          <select className="input-base" style={{width:90, fontSize:'0.6rem', padding:'1px 3px'}}
                            value={seg.profile_id||''} disabled={dubStep==='generating'||dubStep==='stopping'}
                            onChange={e => editSegments(dubSegments.map(s => s.id===seg.id?{...s,profile_id:e.target.value}:s))}>
                            <option value="">Default</option>
                            {profiles.length > 0 && (
                              <optgroup label="Clone Profiles">
                                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </optgroup>
                            )}
                            {PRESETS.length > 0 && (
                              <optgroup label="Design Presets">
                                {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>)}
                              </optgroup>
                            )}
                          </select>
                          <input type="range" min="0" max="200" value={Math.round((seg.gain ?? 1.0) * 100)} title={`${Math.round((seg.gain ?? 1.0) * 100)}%`}
                            disabled={dubStep==='generating'||dubStep==='stopping'}
                            onChange={e => editSegments(dubSegments.map(s => s.id===seg.id?{...s,gain:Number(e.target.value)/100}:s))}
                            style={{width:30, height:2, padding:0, margin:0, accentColor: (seg.gain ?? 1.0) > 1.2 ? '#fb4934' : (seg.gain ?? 1.0) < 0.5 ? '#83a598' : '#a89984'}}
                          />
                          <div style={{display:'flex', gap:1, width:40}}>
                            <button className="segment-play" disabled={dubStep==='generating'||dubStep==='stopping'} title="Live Preview" onClick={(e) => handleSegmentPreview(seg, e)}>
                              {segmentPreviewLoading === seg.id ? <Loader className="spinner" size={9}/> : <Headphones size={9}/>}
                            </button>
                            <button className="segment-del" disabled={dubStep==='generating'||dubStep==='stopping'}
                              onClick={() => editSegments(dubSegments.filter(s=>s.id!==seg.id))}><Trash2 size={9}/></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* ═══ Actions footer bar ═══ */}
                <div className="glass-panel" style={{padding:'4px 8px', flexShrink:0}}>
                  {dubStep==='done' && (
                    <div style={{display:'flex', alignItems:'center', gap:4, marginBottom:4, padding:'3px 6px', background:'rgba(142,192,124,0.08)', border:'1px solid rgba(142,192,124,0.2)', borderRadius:4}}>
                      <Check size={10} color="#8ec07c"/>
                      <span style={{color:'#8ec07c', fontSize:'0.65rem'}}>Done! Tracks: {dubTracks.join(', ')}</span>
                    </div>
                  )}
                  {dubError && (
                    <div style={{marginBottom:4, padding:'3px 6px', background:'rgba(251,73,52,0.08)', border:'1px solid rgba(251,73,52,0.2)', borderRadius:4}}>
                      <span style={{color:'#fb4934', fontSize:'0.62rem'}}>{dubError}</span>
                    </div>
                  )}
                  <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:4, padding:'0 4px', fontSize:'0.65rem', color:'#a89984', flexWrap:'wrap'}}>
                    <span style={{fontWeight:600, color:'#ebdbb2'}}>Output Options:</span>
                    <label style={{display:'flex', alignItems:'center', gap:3, cursor:'pointer'}}>
                      <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} style={{cursor:'pointer'}}/> Mix BG Audio
                    </label>
                    <label style={{display:'flex', alignItems:'center', gap:4}}>
                      Default Track:
                      <select className="input-base" value={defaultTrack} onChange={e => setDefaultTrack(e.target.value)} style={{fontSize:'0.6rem', padding:'2px 4px', width:'120px'}}>
                        <option value="original">Original</option>
                        {dubLangCode && <option value={dubLangCode}>{dubLangCode} (Selected Dub)</option>}
                        {dubTracks.filter(t => t !== dubLangCode).map(t => (
                          <option key={t} value={t}>{t} (Dub)</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {dubTracks.length > 0 && (
                    <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8, padding:'4px 6px', fontSize:'0.62rem', color:'#a89984', background:'rgba(0,0,0,0.15)', borderRadius:4, border:'1px solid rgba(255,255,255,0.04)', flexWrap:'wrap'}}>
                      <span style={{fontWeight:600, color:'#ebdbb2', fontSize:'0.62rem'}}>Export Tracks:</span>
                      <label style={{display:'flex', alignItems:'center', gap:3, cursor:'pointer', color: exportTracks['original'] ? '#ebdbb2' : '#665c54'}}>
                        <input type="checkbox" checked={exportTracks['original'] !== false} onChange={e => setExportTracks(prev => ({...prev, original: e.target.checked}))} style={{cursor:'pointer', accentColor:'#a89984'}}/>
                        <span>Original</span>
                      </label>
                      {dubTracks.map(t => (
                        <label key={t} style={{display:'flex', alignItems:'center', gap:3, cursor:'pointer', color: exportTracks[t] !== false ? '#8ec07c' : '#665c54'}}>
                          <input type="checkbox" checked={exportTracks[t] !== false} onChange={e => setExportTracks(prev => ({...prev, [t]: e.target.checked}))} style={{cursor:'pointer', accentColor:'#8ec07c'}}/>
                          <span style={{textTransform:'uppercase'}}>{t}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div style={{display:'flex', gap:4}}>
                    {dubStep==='stopping' ? (
                      <button className="btn-primary" disabled style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem', background:'linear-gradient(135deg,#504945,#3c3836)', opacity:0.8}}>
                        <Loader className="spinner" size={9}/> Stopping…
                      </button>
                    ) : dubStep==='generating' ? (
                      <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem', background:'linear-gradient(135deg,#fb4934,#cc241d)'}}
                        onClick={handleDubStop}>
                        <Square size={9}/> Stop ({dubProgress.current}/{dubProgress.total})
                      </button>
                    ) : (
                      <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem'}} onClick={handleDubGenerate} disabled={!dubSegments.length}>
                        <Play size={11}/> Generate Dub
                      </button>
                    )}
                    <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem', background:dubStep==='done'?'linear-gradient(135deg,#8ec07c,#689d6a)':undefined}}
                      onClick={handleDubDownload} disabled={dubStep!=='done'}>
                      <DownloadIcon size={11}/> MP4
                    </button>
                    <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem', background:dubStep==='done'?'linear-gradient(135deg,#83a598,#458588)':undefined}}
                      onClick={handleDubAudioDownload} disabled={dubStep!=='done'}>
                      <Volume2 size={11}/> WAV
                    </button>
                    <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem', background:dubSegments.length?'linear-gradient(135deg,#d3869b,#b16286)':undefined}}
                      onClick={() => triggerDownload(`${API}/dub/srt/${dubJobId}/subtitles.srt`, 'subtitles.srt')} disabled={!dubSegments.length}>
                      <FileText size={11}/> SRT
                    </button>
                  </div>
                  {/* Advanced Export Row */}
                  <div style={{display:'flex', gap:4, marginTop:4}}>
                    <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 7px', fontSize:'0.62rem', background:dubSegments.length?'linear-gradient(135deg,#b8bb26,#98971a)':undefined}}
                      onClick={() => triggerDownload(`${API}/dub/vtt/${dubJobId}/subtitles.vtt`, 'subtitles.vtt')} disabled={!dubSegments.length}>
                      <FileText size={10}/> VTT
                    </button>
                    <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 7px', fontSize:'0.62rem', background:dubStep==='done'?'linear-gradient(135deg,#fabd2f,#d79921)':undefined}}
                      onClick={() => triggerDownload(`${API}/dub/download-mp3/${dubJobId}/audio.mp3?preserve_bg=${preserveBg}`, 'dubbed_audio.mp3')} disabled={dubStep!=='done'}>
                      <Music size={10}/> MP3
                    </button>
                    <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 7px', fontSize:'0.62rem', background:dubStep==='done'?'linear-gradient(135deg,#fe8019,#d65d0e)':undefined}}
                      onClick={() => triggerDownload(`${API}/dub/export-segments/${dubJobId}`, 'segments.zip')} disabled={dubStep!=='done'}>
                      <Package size={10}/> Clips
                    </button>
                    <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 7px', fontSize:'0.62rem', background:dubStep==='done'?'linear-gradient(135deg,#d3869b,#b16286)':undefined}}
                      onClick={() => triggerDownload(`${API}/dub/export-stems/${dubJobId}`, 'stems.zip')} disabled={dubStep!=='done'}>
                      <Layers size={10}/> Stems
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (

          <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0}}>
            {/* ═══ CLONE / DESIGN ═══ */}
            <div className="glass-panel" style={{flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0}}>
              <div className="label-row" style={{alignItems: 'center'}}>
                <button 
                  onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                  style={{display:'flex', alignItems:'center', justifyContent:'center', padding:'3px', marginRight:'6px', background: isSidebarCollapsed ? 'rgba(211,134,155,0.1)' : 'rgba(255,255,255,0.05)', border:`1px solid ${isSidebarCollapsed ? 'rgba(211,134,155,0.3)' : 'rgba(255,255,255,0.08)'}`, color: isSidebarCollapsed ? '#d3869b' : '#a89984', borderRadius:4, cursor:'pointer'}}
                  title="Toggle Sidebar"
                >
                  {isSidebarCollapsed ? <PanelLeftOpen size={12}/> : <PanelLeftClose size={12}/>}
                </button>
                <Command className="label-icon" size={14}/> Prompt
              </div>
              {mode === 'design' && (
                <div className="preset-grid">
                  {PRESETS.map(p => <button key={p.id} className="preset-btn" onClick={() => applyPreset(p)}>{p.name}</button>)}
                </div>
              )}
              <textarea ref={textAreaRef} className="input-base" style={{flex: 1, resize: 'none', minHeight: 60, marginBottom: '6px'}}
                placeholder="Type script here..." value={text} onChange={e => setText(e.target.value)}/>
              <div className="tags-container" style={{marginBottom: '6px'}}>
                {TAGS.map(tag => <button key={tag} className="tag-btn" onClick={() => insertTag(tag)}>{tag}</button>)}
                <button className="tag-btn" style={{borderColor:'#b8bb26', color:'#b8bb26'}} onClick={() => insertTag('[B EY1 S]')}>[CMU]</button>
              </div>
              <div className="grid-2">
                <div>
                  <div className="label-row"><Globe className="label-icon" size={14}/> Language ({ALL_LANGUAGES.length - 1})</div>
                  <SearchableSelect
                    value={language}
                    options={ALL_LANGUAGES}
                    popular={POPULAR_LANGS}
                    recentsKey="omnivoice.recents.genLang"
                    onChange={setLanguage}
                  />
                </div>
                <div>
                  <div className="label-row" style={{justifyContent:'space-between'}}>
                    <span className="label-row" style={{marginBottom:0}}><SlidersHorizontal className="label-icon" size={14}/> Steps</span>
                    <span className="val-bubble">{steps}</span>
                  </div>
                  <input type="range" min="8" max="64" value={steps} onChange={e => setSteps(Number(e.target.value))} />
                </div>
              </div>
            </div>

            <div className="glass-panel" style={{flexShrink: 0}}>
              {mode === 'clone' ? (
                <div>
                  <div className="label-row"><Volume2 className="label-icon" size={14}/> Voice Source</div>

                  {/* ── VOICE PROFILES ── */}
                  {profiles.length > 0 && (
                    <div style={{marginBottom:10}}>
                      <div className="label-row" style={{fontSize:'0.7rem', marginBottom:4}}><User size={12}/> Saved Profiles</div>
                      <div className="preset-grid">
                        {profiles.map(p => (
                          <div key={p.id} className={`preset-btn ${selectedProfile === p.id ? 'profile-active' : ''}`}
                            onClick={() => handleSelectProfile(p)} style={{position:'relative'}}>
                            <User size={10}/> {p.name}
                            <button onClick={(e) => { e.stopPropagation(); handleDeleteProfile(p.id); }}
                              style={{position:'absolute', top:2, right:2, background:'none', border:'none', color:'#fb4934', cursor:'pointer', padding:0}}>
                              <Trash2 size={10}/>
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {!selectedProfile && (
                    <>
                      <div style={{display:'flex', gap:'8px', alignItems:'stretch'}}>
                        <input type="file" accept="audio/*" onChange={e => { setRefAudio(e.target.files[0]); setSelectedProfile(null); }} style={{display:'none'}} id="audio-upload" />
                        <label htmlFor="audio-upload" className="file-drag" style={{padding: '6px', flex:1}}
                          onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor='#d3869b'; e.currentTarget.style.background='rgba(211,134,155,0.05)'; }}
                          onDragLeave={e => { e.currentTarget.style.borderColor=''; e.currentTarget.style.background=''; }}
                          onDrop={e => {
                            e.preventDefault();
                            e.currentTarget.style.borderColor=''; e.currentTarget.style.background='';
                            const file = e.dataTransfer.files[0];
                            if (file && file.type.startsWith('audio/')) { setRefAudio(file); setSelectedProfile(null); }
                          }}>
                          <UploadCloud color="#a89984" size={18}/>
                          <p>{refAudio ? <span style={{color:'#ebdbb2'}}>{refAudio.name}</span> : "Drop audio or click · WAV / MP3"}</p>
                        </label>

                        {/* Mic Record Button */}
                        {isCleaning ? (
                          <div style={{display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'8px 16px', background:'rgba(184,187,38,0.1)', border:'1px solid rgba(184,187,38,0.2)', borderRadius:8, gap:4, minWidth:70}}>
                            <Loader size={18} color="#b8bb26" style={{animation:'spin 1s linear infinite'}}/>
                            <span style={{fontSize:'0.6rem', color:'#b8bb26'}}>Cleaning...</span>
                          </div>
                        ) : isRecording ? (
                          <button onClick={stopRecording} style={{
                            display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:4,
                            padding:'8px 16px', background:'rgba(251,73,52,0.15)', border:'2px solid #fb4934',
                            borderRadius:8, cursor:'pointer', color:'#fb4934', minWidth:70,
                            animation:'pulse 1s ease-in-out infinite',
                          }}>
                            <Square size={18} fill="#fb4934"/>
                            <span style={{fontSize:'0.65rem', fontWeight:600}}>{recordingTime}s</span>
                          </button>
                        ) : (
                          <button onClick={startRecording} style={{
                            display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:4,
                            padding:'8px 16px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.1)',
                            borderRadius:8, cursor:'pointer', color:'#a89984', minWidth:70,
                            transition:'all 0.2s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor='#fb4934'; e.currentTarget.style.color='#fb4934'; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; e.currentTarget.style.color='#a89984'; }}
                          title="Record your voice for cloning">
                            <Mic size={18}/>
                            <span style={{fontSize:'0.6rem'}}>Record</span>
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {selectedProfile && (
                    <div style={{padding:8, background:'rgba(142,192,124,0.08)', border:'1px solid rgba(142,192,124,0.2)', borderRadius:6, fontSize:'0.8rem', marginBottom:8}}>
                      <span style={{color:'#8ec07c'}}>Using profile: {profiles.find(p=>p.id===selectedProfile)?.name}</span>
                      <button onClick={() => setSelectedProfile(null)} style={{marginLeft:8, background:'none', border:'none', color:'#a89984', cursor:'pointer', fontSize:'0.75rem', textDecoration:'underline'}}>clear</button>
                    </div>
                  )}

                  <div className="grid-2" style={{marginTop:6}}>
                    <div><div className="label-row">Transcript</div><input type="text" className="input-base" value={refText} onChange={e => setRefText(e.target.value)} placeholder="(Optional)"/></div>
                    <div><div className="label-row">Style</div><input type="text" className="input-base" value={instruct} onChange={e => setInstruct(e.target.value)} placeholder="e.g. whisper"/></div>
                  </div>

                  {/* Save as profile */}
                  {refAudio && !selectedProfile && (
                    <div style={{marginTop:8}}>
                      {!showSaveProfile ? (
                        <button onClick={() => setShowSaveProfile(true)} style={{background:'none', border:'1px solid rgba(142,192,124,0.3)', color:'#8ec07c', fontSize:'0.75rem', padding:'4px 10px', borderRadius:6, cursor:'pointer', display:'flex', alignItems:'center', gap:4}}>
                          <Save size={12}/> Save as Voice Profile
                        </button>
                      ) : (
                        <div style={{display:'flex', gap:6, alignItems:'center'}}>
                          <input className="input-base" style={{flex:1, fontSize:'0.8rem', padding:'4px 8px'}} placeholder="Profile name..." value={profileName} onChange={e => setProfileName(e.target.value)}/>
                          <button onClick={handleSaveProfile} style={{background:'rgba(142,192,124,0.2)', border:'1px solid rgba(142,192,124,0.4)', color:'#8ec07c', fontSize:'0.75rem', padding:'4px 10px', borderRadius:6, cursor:'pointer'}}>Save</button>
                          <button onClick={() => setShowSaveProfile(false)} style={{background:'none', border:'none', color:'#a89984', cursor:'pointer', fontSize:'0.75rem'}}>Cancel</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="label-row"><UserSquare2 className="label-icon" size={14}/> Voice Profile</div>
                  <div className="grid-3">
                    {Object.entries(CATEGORIES).map(([key, options]) => (
                      <div key={key}>
                        <div className="label-row" style={{fontSize:'0.7rem'}}>{key}</div>
                        <select className="input-base" value={vdStates[key]} onChange={e => setVdStates({...vdStates, [key]: e.target.value})}>
                          {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="override-toggle" onClick={() => setShowOverrides(!showOverrides)}>
                <span><Settings2 size={14} style={{verticalAlign:'middle', marginRight:4}}/> Production Overrides</span>
                {showOverrides ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
              </div>
              {showOverrides && (
                <div className="override-content">
                  <div className="grid-4">
                    <div><div className="label-row" style={{justifyContent:'space-between'}}><span>CFG</span><span className="val-bubble">{cfg}</span></div><input type="range" min="1.0" max="4.0" step="0.1" value={cfg} onChange={e => setCfg(Number(e.target.value))}/></div>
                    <div><div className="label-row" style={{justifyContent:'space-between'}}><span>Speed</span><span className="val-bubble">{speed}x</span></div><input type="range" min="0.5" max="2.0" step="0.1" value={speed} onChange={e => setSpeed(Number(e.target.value))}/></div>
                    <div><div className="label-row" style={{justifyContent:'space-between'}}><span>t_shift</span><span className="val-bubble">{tShift}</span></div><input type="range" min="0" max="1.0" step="0.05" value={tShift} onChange={e => setTShift(Number(e.target.value))}/></div>
                    <div><div className="label-row" style={{justifyContent:'space-between'}}><span>Pos Temp</span><span className="val-bubble">{posTemp}</span></div><input type="range" min="0" max="10" step="0.5" value={posTemp} onChange={e => setPosTemp(Number(e.target.value))}/></div>
                    <div><div className="label-row" style={{justifyContent:'space-between'}}><span>Class Temp</span><span className="val-bubble">{classTemp}</span></div><input type="range" min="0" max="2" step="0.1" value={classTemp} onChange={e => setClassTemp(Number(e.target.value))}/></div>
                    <div><div className="label-row" style={{justifyContent:'space-between'}}><span>Layer Pen</span><span className="val-bubble">{layerPenalty}</span></div><input type="range" min="0" max="10" step="0.5" value={layerPenalty} onChange={e => setLayerPenalty(Number(e.target.value))}/></div>
                    <div><div className="label-row"><span>Duration</span></div><input type="text" className="input-base" value={duration} onChange={e => setDuration(e.target.value)} placeholder="Auto" style={{fontSize:'0.8rem'}}/></div>
                    <div style={{display:'flex', flexDirection:'column', gap:6}}>
                      <label style={{fontSize:'0.75rem', display:'flex', alignItems:'center', gap:6, cursor:'pointer'}}><input type="checkbox" checked={denoise} onChange={e => setDenoise(e.target.checked)}/> Denoise</label>
                      <label style={{fontSize:'0.75rem', display:'flex', alignItems:'center', gap:6, cursor:'pointer'}}><input type="checkbox" checked={postprocess} onChange={e => setPostprocess(e.target.checked)}/> Postprocess</label>
                    </div>
                  </div>
                </div>
              )}

              <button className="btn-primary" onClick={handleGenerate} disabled={isGenerating}>
                {isGenerating ? <Sparkles className="spinner" size={16}/> : <Play size={16}/>}
                {isGenerating ? `Synthesizing... (${generationTime}s)` : 'Synthesize Audio'}
              </button>
              {isGenerating && <div className="progress-container"><div className="progress-fill" style={{width: `${Math.min((generationTime/8)*100,95)}%`}}></div></div>}
            </div>
          </div>
        )}
      </div>

      {/* ── SIDEBAR ── */}
      {
        <div className="glass-panel history-panel" style={{display:'flex', flexDirection:'column'}}>
          <div style={{display:'flex', gap:6, padding:'6px 8px', borderBottom:'1px solid var(--glass-border)', background:'rgba(0,0,0,0.15)', flexShrink:0, flexDirection: isSidebarCollapsed ? 'column' : 'row', justifyContent: 'center'}}>
            <button onClick={() => setSidebarTab('projects')} style={{
              flex:1, height: '26px', maxWidth: isSidebarCollapsed ? '100%' : '60px', cursor:'pointer', border:'1px solid',
              borderColor: sidebarTab === 'projects' ? 'rgba(184,187,38,0.35)' : 'rgba(255,255,255,0.06)',
              background: sidebarTab === 'projects' ? 'rgba(184,187,38,0.15)' : 'rgba(0,0,0,0.2)',
              color: sidebarTab === 'projects' ? '#b8bb26' : '#a89984',
              borderRadius:6, transition:'all 0.2s ease', display:'flex', justifyContent:'center', alignItems:'center'
            }} title={`Projects (${mode === 'dub' ? studioProjects.length : (mode === 'clone' ? profiles.filter(p => !p.instruct).length : profiles.filter(p => !!p.instruct).length)})`}><FolderOpen size={13}/>
            </button>
            <button onClick={() => setSidebarTab('history')} style={{
              flex:1, height: '26px', maxWidth: isSidebarCollapsed ? '100%' : '60px', cursor:'pointer', border:'1px solid',
              borderColor: sidebarTab === 'history' ? 'rgba(211,134,155,0.35)' : 'rgba(255,255,255,0.06)',
              background: sidebarTab === 'history' ? 'rgba(211,134,155,0.15)' : 'rgba(0,0,0,0.2)',
              color: sidebarTab === 'history' ? '#d3869b' : '#a89984',
              borderRadius:6, transition:'all 0.2s ease', display:'flex', justifyContent:'center', alignItems:'center'
            }} title={`History (${history.length + dubHistory.length})`}><History size={13}/>
            </button>
            <button onClick={() => setSidebarTab('downloads')} style={{
              flex:1, height: '26px', maxWidth: isSidebarCollapsed ? '100%' : '60px', cursor:'pointer', border:'1px solid',
              borderColor: sidebarTab === 'downloads' ? 'rgba(142,192,124,0.35)' : 'rgba(255,255,255,0.06)',
              background: sidebarTab === 'downloads' ? 'rgba(142,192,124,0.15)' : 'rgba(0,0,0,0.2)',
              color: sidebarTab === 'downloads' ? '#8ec07c' : '#a89984',
              borderRadius:6, transition:'all 0.2s ease', display:'flex', justifyContent:'center', alignItems:'center'
            }} title={`Exports (${exportHistory.length})`}><DownloadCloud size={13}/>
            </button>
          </div>

        <div style={{flex:1, overflowY:'auto', padding: isSidebarCollapsed ? '8px 4px' : '8px', display: 'flex', flexDirection: 'column', alignItems: isSidebarCollapsed ? 'center' : 'stretch', gap: isSidebarCollapsed ? 8 : 0}}>
        {/* ── PROJECTS TAB ── */}
        {sidebarTab === 'projects' && (
          <>
            {/* Save current work as dub project button (only in dub mode) */}
            {mode === 'dub' && (dubStep !== 'idle' || dubVideoFile) && !isSidebarCollapsed && (
              <button onClick={saveProject} style={{
                width:'100%', marginBottom:10, padding:'7px 12px', display:'flex', alignItems:'center', justifyContent:'center', gap:6,
                background: activeProjectId ? 'rgba(184,187,38,0.15)' : 'rgba(131,165,152,0.15)',
                border: `1px solid ${activeProjectId ? 'rgba(184,187,38,0.35)' : 'rgba(131,165,152,0.3)'}`,
                borderRadius:6, cursor:'pointer', fontSize:'0.78rem', fontWeight:500,
                color: activeProjectId ? '#b8bb26' : '#83a598',
              }}>
                <Save size={13}/> {activeProjectId ? 'Save Dub Project' : 'Save as New Dub Project'}
              </button>
            )}
            {mode === 'dub' && (dubStep !== 'idle' || dubVideoFile) && isSidebarCollapsed && (
              <button onClick={saveProject} title={activeProjectId ? 'Save Dub Project' : 'Save as New Dub Project'} style={{
                width:'32px', height:'32px', padding:0, display:'flex', alignItems:'center', justifyContent:'center', marginBottom:8, flexShrink:0,
                background: activeProjectId ? 'rgba(184,187,38,0.15)' : 'rgba(131,165,152,0.15)', border: `1px solid ${activeProjectId ? 'rgba(184,187,38,0.35)' : 'rgba(131,165,152,0.3)'}`,
                borderRadius:6, cursor:'pointer', color: activeProjectId ? '#b8bb26' : '#83a598',
              }}><Save size={14}/></button>
            )}

            {!isSidebarCollapsed && (
              <div style={{fontSize:'0.68rem', color:'var(--text-secondary)', marginBottom:8, display:'flex', justifyContent:'space-between', alignItems:'center', cursor:'pointer', padding:'2px 0'}} onClick={() => setIsSidebarProjectsCollapsed(!isSidebarProjectsCollapsed)}>
                <span>{mode === 'dub' ? 'Studio Projects (Dubbing)' : (mode === 'clone' ? 'Voice Clones (Audio)' : 'Designed Voices (Synthetic)')}</span>
                {isSidebarProjectsCollapsed ? <ChevronDown size={12}/> : <ChevronUp size={12}/>}
              </div>
            )}

            {!isSidebarProjectsCollapsed && !isSidebarCollapsed && (
              <>
                {mode === 'dub' && (
                  <>
                    {studioProjects.length === 0 ? (
                      <div style={{color:'var(--text-secondary)', textAlign:'center', padding:'24px 12px'}}>
                        <Film size={28} style={{opacity:0.3, marginBottom:8}} />
                        <p style={{fontSize:'0.78rem', margin:0, marginBottom:4}}>No saved dub projects</p>
                        <p style={{fontSize:'0.62rem', margin:0, opacity:0.6}}>Upload a video and click Save to keep your work.</p>
                      </div>
                    ) : (
                      studioProjects.map(proj => (
                        <div key={proj.id} className={`history-item ${activeProjectId === proj.id ? 'project-active' : ''}`} style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div className="history-header" style={{ marginBottom: 0 }}>
                            <span style={{ fontSize: '0.55rem', fontWeight: 600, color: activeProjectId === proj.id ? '#b8bb26' : '#83a598', letterSpacing: '0.02em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <Film size={10}/> DUB PROJECT
                            </span>
                            <div style={{fontSize:'0.6rem', color:'#665c54', margin:0, opacity:0.8}}>
                              <Clock size={8} style={{verticalAlign:'middle', marginRight:2, marginTop:-1}}/>
                              {new Date(proj.updated_at * 1000).toLocaleString([], {hour: '2-digit', minute:'2-digit', month: 'short', day: 'numeric'})}
                            </div>
                          </div>
                          <div style={{fontSize:'0.72rem', color:'var(--text-primary)', wordWrap:'break-word', fontWeight:500, lineHeight: 1.2}}>
                            {proj.name}
                          </div>
                          <div style={{display:'flex', gap:6, fontSize:'0.58rem', color:'var(--text-secondary)'}}>
                            {proj.duration && <span>{Math.round(proj.duration)}s</span>}
                            {proj.video_path && <span style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>· {proj.video_path.split(/[\\/]/).pop()}</span>}
                          </div>
                          <div style={{display:'flex', gap:'6px', marginTop:'2px'}}>
                            <button onClick={() => loadProject(proj.id)} className="btn-base" style={{flex:1, padding:'4px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.05)', color:'var(--text-secondary)', borderRadius:'4px', fontSize:'0.65rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px', transition:'all 0.15s ease'}}
                              onMouseEnter={e => { e.currentTarget.style.color='#ebdbb2'; e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; }}
                              onMouseLeave={e => { e.currentTarget.style.color='var(--text-secondary)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.05)'; }}>
                              <FolderOpen size={10}/> Load Project
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); deleteProject(proj.id); }} style={{padding:'4px 8px', background:'rgba(251,73,52,0.05)', border:'1px solid transparent', color:'#fb4934', opacity:0.6, borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0, transition:'all 0.15s ease'}}
                              onMouseEnter={e => { e.currentTarget.style.opacity=1; e.currentTarget.style.background='rgba(251,73,52,0.15)'; e.currentTarget.style.borderColor='rgba(251,73,52,0.3)'; }}
                              onMouseLeave={e => { e.currentTarget.style.opacity=0.6; e.currentTarget.style.background='rgba(251,73,52,0.05)'; e.currentTarget.style.borderColor='transparent'; }}>
                              <Trash2 size={10}/>
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </>
                )}

                {(mode === 'clone' || mode === 'design') && (
                  <>
                    {(mode === 'clone' ? profiles.filter(p => !p.instruct) : profiles.filter(p => !!p.instruct)).length === 0 ? (
                      <div style={{color:'var(--text-secondary)', textAlign:'center', padding:'24px 12px'}}>
                        {mode === 'clone' ? <Fingerprint size={28} style={{opacity:0.3, marginBottom:8}} /> : <Wand2 size={28} style={{opacity:0.3, marginBottom:8}} />}
                        <p style={{fontSize:'0.78rem', margin:0, marginBottom:4}}>No {mode === 'clone' ? 'voice clones' : 'designed voices'} yet</p>
                        <p style={{fontSize:'0.62rem', margin:0, opacity:0.6}}>{mode === 'clone' ? 'Record or upload audio, then click Save as Voice Profile.' : 'Generate a voice and save it from History.'}</p>
                      </div>
                    ) : (
                      (mode === 'clone' ? profiles.filter(p => !p.instruct) : profiles.filter(p => !!p.instruct)).map(proj => (
                        <div key={proj.id} className={`history-item ${selectedProfile === proj.id ? 'project-active' : ''}`} style={{ borderLeft: proj.is_locked ? '2px solid #b8bb26' : undefined, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div className="history-header" style={{ marginBottom: 0 }}>
                            <span style={{ fontSize: '0.55rem', fontWeight: 600, color: proj.is_locked ? '#b8bb26' : (mode === 'clone' ? '#d3869b' : '#8ec07c'), letterSpacing: '0.02em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
                              {proj.is_locked ? <Lock size={10}/> : (mode === 'clone' ? <Fingerprint size={10}/> : <Wand2 size={10}/>)} {proj.is_locked ? 'LOCKED' : (mode === 'clone' ? 'CLONE' : 'DESIGN')}
                            </span>
                            {proj.is_locked && (
                              <div style={{fontSize:'0.55rem', color:'#b8bb26', fontStyle:'italic', margin:0}}>Consistent</div>
                            )}
                          </div>
                          <div style={{fontSize:'0.72rem', color:'var(--text-primary)', wordWrap:'break-word', fontWeight:500, lineHeight: 1.2}}>
                            {proj.name}
                          </div>
                          {proj.instruct && <div style={{fontSize:'0.6rem', color:'var(--text-secondary)', fontStyle:'italic'}}>{proj.instruct}</div>}
                          
                          <div style={{display:'flex', gap:'6px', marginTop:'2px'}}>
                             <button onClick={(e) => handlePreviewVoice(proj, e)} style={{padding:'4px 8px', background:'rgba(211,134,155,0.05)', border:'1px solid transparent', color:'#d3869b', opacity: 0.8, borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0, transition:'all 0.15s ease'}} title="Preview voice"
                               onMouseEnter={e => { e.currentTarget.style.opacity=1; e.currentTarget.style.background='rgba(211,134,155,0.15)'; e.currentTarget.style.borderColor='rgba(211,134,155,0.3)'; }}
                               onMouseLeave={e => { e.currentTarget.style.opacity=0.8; e.currentTarget.style.background='rgba(211,134,155,0.05)'; e.currentTarget.style.borderColor='transparent'; }}>
                               {previewLoading === proj.id ? <Loader className="spinner" size={10}/> : <Play size={10}/>}
                             </button>
                             <button onClick={() => handleSelectProfile(proj)} style={{flex:1, padding:'4px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.05)', color:'var(--text-secondary)', borderRadius:'4px', fontSize:'0.65rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px', transition:'all 0.15s ease'}}
                               onMouseEnter={e => { e.currentTarget.style.color='#ebdbb2'; e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; }}
                               onMouseLeave={e => { e.currentTarget.style.color='var(--text-secondary)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.05)'; }}>
                               <Check size={10}/> Select
                             </button>
                             {proj.is_locked && (
                               <button onClick={(e) => { e.stopPropagation(); handleUnlockProfile(proj.id); }} style={{padding:'4px 8px', background:'rgba(184,187,38,0.05)', border:'1px solid transparent', color:'#b8bb26', opacity: 0.8, borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'2px', flexShrink:0, transition:'all 0.15s ease'}} title="Unlock: voice will vary between generations"
                                 onMouseEnter={e => { e.currentTarget.style.opacity=1; e.currentTarget.style.background='rgba(184,187,38,0.15)'; e.currentTarget.style.borderColor='rgba(184,187,38,0.3)'; }}
                                 onMouseLeave={e => { e.currentTarget.style.opacity=0.8; e.currentTarget.style.background='rgba(184,187,38,0.05)'; e.currentTarget.style.borderColor='transparent'; }}>
                                 <Unlock size={10}/>
                               </button>
                             )}
                             <button onClick={(e) => { e.stopPropagation(); handleDeleteProfile(proj.id); }} style={{padding:'4px 8px', background:'rgba(251,73,52,0.05)', border:'1px solid transparent', color:'#fb4934', opacity: 0.6, borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0, transition:'all 0.15s ease'}} title="Delete"
                               onMouseEnter={e => { e.currentTarget.style.opacity=1; e.currentTarget.style.background='rgba(251,73,52,0.15)'; e.currentTarget.style.borderColor='rgba(251,73,52,0.3)'; }}
                               onMouseLeave={e => { e.currentTarget.style.opacity=0.6; e.currentTarget.style.background='rgba(251,73,52,0.05)'; e.currentTarget.style.borderColor='transparent'; }}>
                               <Trash2 size={10}/>
                             </button>
                          </div>
                        </div>
                      ))
                    )}
                  </>
                )}
              </>
            )}

            {isSidebarCollapsed && mode === 'dub' && studioProjects.map(proj => (
              <div key={proj.id} title={`Load: ${proj.name}`} onClick={() => loadProject(proj.id)} style={{
                width:'32px', height:'32px', flexShrink:0, display:'flex', justifyContent:'center', alignItems:'center', borderRadius:'6px', cursor:'pointer',
                background: activeProjectId === proj.id ? 'rgba(184,187,38,0.2)' : 'rgba(255,255,255,0.05)', border:`1px solid ${activeProjectId === proj.id ? 'rgba(184,187,38,0.5)' : 'transparent'}`,
                color: activeProjectId === proj.id ? '#b8bb26' : '#a89984'
              }}>
                <Film size={14}/>
              </div>
            ))}

            {isSidebarCollapsed && (mode === 'clone' || mode === 'design') && (mode === 'clone' ? profiles.filter(p => !p.instruct) : profiles.filter(p => !!p.instruct)).map(proj => (
              <div key={proj.id} title={`Select: ${proj.name}`} onClick={() => handleSelectProfile(proj)} style={{
                width:'32px', height:'32px', flexShrink:0, display:'flex', justifyContent:'center', alignItems:'center', borderRadius:'6px', cursor:'pointer', position:'relative',
                background: selectedProfile === proj.id ? 'rgba(184,187,38,0.2)' : 'rgba(255,255,255,0.05)', border:`1px solid ${selectedProfile === proj.id ? 'rgba(184,187,38,0.5)' : 'transparent'}`,
                color: selectedProfile === proj.id ? '#b8bb26' : '#a89984'
              }}>
                {mode === 'clone' ? <Fingerprint size={14}/> : <Wand2 size={14}/>}
                {proj.is_locked && <Lock size={8} style={{position:'absolute', bottom:2, right:2, color:'#b8bb26'}}/>}
              </div>
            ))}
          </>
        )}

        {/* ── HISTORY TAB ── */}
        {sidebarTab === 'history' && (
          <>
            {!isSidebarCollapsed && <div style={{fontSize:'0.68rem', color:'var(--text-secondary)', marginBottom:8}}>Generation history · Stored in SQLite</div>}
            {(history.length + dubHistory.length) === 0 ? (
              <div style={{color:'var(--text-secondary)', textAlign:'center', padding:'24px 12px'}}>
                <History size={28} style={{opacity:0.3, marginBottom:8}} />
                <p style={{fontSize:'0.78rem', margin:0, marginBottom:4}}>No generation history</p>
                <p style={{fontSize:'0.62rem', margin:0, opacity:0.6}}>Synthesize audio or dub a video — results will appear here.</p>
              </div>
            ) : (
              <>
                {/* Dub history */}
                {!isSidebarCollapsed && dubHistory.map(item => (
                  <div key={`dub-${item.id}`} className="history-item" style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="history-header" style={{ marginBottom: 0 }}>
                      <span style={{ fontSize: '0.55rem', fontWeight: 600, color: '#83a598', letterSpacing: '0.02em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Film size={10}/> DUB
                      </span>
                      <div className="history-time" style={{margin:0, opacity:0.6}}>{item.segments_count} segs</div>
                    </div>
                    <div style={{fontSize:'0.72rem', color:'var(--text-primary)', wordWrap:'break-word', fontWeight:500, lineHeight: 1.2}}>
                      {item.filename}
                    </div>
                    <div style={{display:'flex', gap:4, flexWrap:'wrap'}}>
                      <span style={{fontSize:'0.6rem', padding:'2px 6px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.05)', color:'var(--text-secondary)', borderRadius:4}}>
                        {item.language} ({item.language_code})
                      </span>
                      <span style={{fontSize:'0.6rem', padding:'2px 6px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.05)', color:'var(--text-secondary)', borderRadius:4}}>
                        {Math.round(item.duration)}s
                      </span>
                    </div>
                    <div style={{display:'flex', gap:'6px', marginTop:'2px'}}>
                      <button onClick={() => restoreDubHistory(item)} className="btn-base" style={{flex:1, padding:'4px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.05)', color:'var(--text-secondary)', borderRadius:'4px', fontSize:'0.65rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px', transition:'all 0.15s ease'}}
                        onMouseEnter={e => { e.currentTarget.style.color='#ebdbb2'; e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; }}
                        onMouseLeave={e => { e.currentTarget.style.color='var(--text-secondary)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.05)'; }}>
                        <FolderOpen size={10}/> Load Project
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); deleteHistory(item.id, 'dub'); }} style={{padding:'4px 8px', background:'rgba(251,73,52,0.05)', border:'1px solid transparent', color:'#fb4934', opacity:0.6, borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0, transition:'all 0.15s ease'}}
                        onMouseEnter={e => { e.currentTarget.style.opacity=1; e.currentTarget.style.background='rgba(251,73,52,0.15)'; e.currentTarget.style.borderColor='rgba(251,73,52,0.3)'; }}
                        onMouseLeave={e => { e.currentTarget.style.opacity=0.6; e.currentTarget.style.background='rgba(251,73,52,0.05)'; e.currentTarget.style.borderColor='transparent'; }}>
                        <Trash2 size={10}/>
                      </button>
                    </div>
                  </div>
                ))}

                {/* Clone/Design history */}
                {!isSidebarCollapsed && history.map(item => (
                  <div key={item.id} className="history-item" style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="history-header" style={{ marginBottom: 0 }}>
                      <span style={{ fontSize: '0.55rem', fontWeight: 600, color: item.mode === 'clone' ? '#d3869b' : '#b8bb26', letterSpacing: '0.02em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
                        {item.mode === 'clone' ? <Fingerprint size={10}/> : <Wand2 size={10}/>} {(item.mode||'synth')}
                      </span>
                      <div className="history-time" style={{margin:0, opacity:0.6}}>
                        {item.language && item.language !== 'Auto' && <span style={{marginRight:6}}>{item.language}</span>}
                        {item.generation_time && <span>{item.generation_time}s</span>}
                      </div>
                    </div>
                    {item.seed && <div style={{fontSize:'0.55rem', color:'var(--text-secondary)', opacity: 0.6}}>seed: {item.seed}</div>}
                    <div className="history-text" title={item.text} style={{marginTop: 2, color: 'var(--text-primary)', lineHeight: 1.3}}>{item.text}</div>
                    
                    {item.audio_path && <audio controls src={`${API}/audio/${item.audio_path}`} style={{height: 24, marginTop: 4, width: '100%'}} />}
                    
                    {item.audio_path && (
                      <div style={{display:'flex', gap:'6px', marginTop:'2px', flexWrap:'wrap'}}>
                        <button onClick={() => handleSaveHistoryAsProfile(item)} style={{flex:1, padding:'4px', background:'rgba(142,192,124,0.05)', border:'1px solid transparent', color:'#8ec07c', opacity: 0.8, borderRadius:'4px', fontSize:'0.65rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px', whiteSpace:'nowrap', transition:'all 0.15s ease'}}
                          onMouseEnter={e => { e.currentTarget.style.opacity=1; e.currentTarget.style.background='rgba(142,192,124,0.15)'; e.currentTarget.style.borderColor='rgba(142,192,124,0.3)'; }}
                          onMouseLeave={e => { e.currentTarget.style.opacity=0.8; e.currentTarget.style.background='rgba(142,192,124,0.05)'; e.currentTarget.style.borderColor='transparent'; }}>
                          <Save size={10}/> Save
                        </button>
                        
                        {item.profile_id && (
                          <button onClick={() => handleLockProfile(item.profile_id, item.id, item.seed)} style={{padding:'4px 8px', background:'rgba(184,187,38,0.05)', border:'1px solid transparent', color:'#b8bb26', opacity: 0.8, borderRadius:'4px', fontSize:'0.65rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'3px', whiteSpace:'nowrap', transition:'all 0.15s ease'}} title="Lock this exact voice identity"
                            onMouseEnter={e => { e.currentTarget.style.opacity=1; e.currentTarget.style.background='rgba(184,187,38,0.15)'; e.currentTarget.style.borderColor='rgba(184,187,38,0.3)'; }}
                            onMouseLeave={e => { e.currentTarget.style.opacity=0.8; e.currentTarget.style.background='rgba(184,187,38,0.05)'; e.currentTarget.style.borderColor='transparent'; }}>
                            <Lock size={10}/> Lock
                          </button>
                        )}
                        <button onClick={(e) => handleNativeExport(e, item.audio_path, item.audio_path, item.mode)} style={{padding:'4px 8px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.05)', color:'var(--text-secondary)', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', transition:'all 0.15s ease'}} title="Export"
                          onMouseEnter={e => { e.currentTarget.style.color='#ebdbb2'; e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; }}
                          onMouseLeave={e => { e.currentTarget.style.color='var(--text-secondary)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.05)'; }}>
                          <DownloadIcon size={10}/>
                        </button>
                        <button onClick={() => restoreHistory(item)} style={{padding:'4px 8px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.05)', color:'var(--text-secondary)', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', transition:'all 0.15s ease'}} title="Load Configuration"
                          onMouseEnter={e => { e.currentTarget.style.color='#ebdbb2'; e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; }}
                          onMouseLeave={e => { e.currentTarget.style.color='var(--text-secondary)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.05)'; }}>
                          <FolderOpen size={10}/>
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); deleteHistory(item.id, 'synth'); }} style={{padding:'4px 8px', background:'rgba(251,73,52,0.05)', border:'1px solid transparent', color:'#fb4934', opacity:0.6, borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0, transition:'all 0.15s ease'}} title="Delete"
                          onMouseEnter={e => { e.currentTarget.style.opacity=1; e.currentTarget.style.background='rgba(251,73,52,0.15)'; e.currentTarget.style.borderColor='rgba(251,73,52,0.3)'; }}
                          onMouseLeave={e => { e.currentTarget.style.opacity=0.6; e.currentTarget.style.background='rgba(251,73,52,0.05)'; e.currentTarget.style.borderColor='transparent'; }}>
                          <Trash2 size={10}/>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}

            {isSidebarCollapsed && dubHistory.map(item => (
              <div key={`dub-${item.id}`} title={`Dub: ${item.filename}`} onClick={() => restoreDubHistory(item)} style={{
                width:'32px', height:'32px', flexShrink:0, display:'flex', justifyContent:'center', alignItems:'center', borderRadius:'6px', cursor:'pointer', background:'rgba(255,255,255,0.05)', border:'1px solid transparent', color:'#83a598'
              }}>
                <Film size={14}/>
              </div>
            ))}
            
            {isSidebarCollapsed && history.map(item => (
              <div key={item.id} title={`${item.mode||'history'}: ${item.text}`} onClick={() => restoreHistory(item)} style={{
                width:'32px', height:'32px', flexShrink:0, display:'flex', justifyContent:'center', alignItems:'center', borderRadius:'6px', cursor:'pointer', background:'rgba(255,255,255,0.05)', border:'1px solid transparent', color: item.mode === 'clone' ? '#d3869b' : '#b8bb26'
              }}>
                {item.mode === 'clone' ? <Fingerprint size={14}/> : <Wand2 size={14}/>}
              </div>
            ))}
            
            {(history.length + dubHistory.length) > 0 && !isSidebarCollapsed && (
              <button onClick={async () => { if (!confirm(`Clear all ${history.length + dubHistory.length} history items? This cannot be undone.`)) return; await fetch(`${API}/history`, {method:'DELETE'}); await fetch(`${API}/dub/history`, {method:'DELETE'}); await loadHistory(); await loadDubHistory(); toast.success('History cleared'); }}

                style={{width:'100%', marginTop:10, padding:5, background:'transparent', border:'1px solid rgba(255,255,255,0.06)', borderRadius:6, color:'#665c54', cursor:'pointer', fontSize:'0.65rem', transition:'all 0.2s ease'}}
                onMouseEnter={e => { e.target.style.borderColor = 'rgba(251,73,52,0.3)'; e.target.style.color = '#fb4934'; }}
                onMouseLeave={e => { e.target.style.borderColor = 'rgba(255,255,255,0.06)'; e.target.style.color = '#665c54'; }}>
                <Trash2 size={10} style={{verticalAlign:'middle', marginRight:4}}/> Clear History
              </button>
            )}
          </>
        )}

        {/* ── DOWNLOADS TAB ── */}
        {sidebarTab === 'downloads' && (
          <>
            {!isSidebarCollapsed && <div style={{fontSize:'0.68rem', color:'var(--text-secondary)', marginBottom:8}}>Recent Exports</div>}
            {exportHistory.length === 0 ? (
              <div style={{color:'var(--text-secondary)', textAlign:'center', padding:'24px 12px'}}>
                <DownloadCloud size={28} style={{opacity:0.3, marginBottom:8}} />
                <p style={{fontSize:'0.78rem', margin:0, marginBottom:4}}>No downloaded outputs</p>
                <p style={{fontSize:'0.62rem', margin:0, opacity:0.6}}>Export a file via Tauri to see it tracked here.</p>
              </div>
            ) : (
              <>
                {!isSidebarCollapsed && exportHistory.map(item => {
                  const pathParts = item.destination_path.split(/[\\/]/);
                  const parentFolder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : '...';
                  return (
                    <div key={item.id} className="history-item" style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                       <div className="history-header" style={{ marginBottom: 0 }}>
                         <span style={{ fontSize: '0.55rem', fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.02em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
                           {item.mode === 'audio' ? <Volume2 size={10} color="#83a598"/> : <Film size={10} color="#8ec07c"/>} 
                           {item.mode}
                         </span>
                         <div className="history-text" style={{margin:0, opacity:0.6}}>{new Date(item.created_at * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                       </div>
                       <div style={{fontSize:'0.72rem', color:'var(--text-primary)', wordWrap:'break-word', fontWeight:500, lineHeight: 1.2}}>
                         {item.filename}
                       </div>
                       <div onClick={() => revealInFolder(item.destination_path)} 
                            style={{
                              display:'flex', alignItems:'center', gap:6, marginTop:2, 
                              padding:'4px 6px', background:'rgba(255,255,255,0.03)', 
                              borderRadius:4, border:'1px solid rgba(255,255,255,0.05)', cursor:'pointer',
                              color: 'var(--text-secondary)', transition:'all 0.15s ease'
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background='rgba(142,192,124,0.08)'; e.currentTarget.style.borderColor='rgba(142,192,124,0.3)'; e.currentTarget.style.color='#8ec07c'; }}
                            onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.05)'; e.currentTarget.style.color='var(--text-secondary)'; }}>
                         <FolderOpen size={11} style={{flexShrink:0}}/>
                         <span style={{fontSize:'0.58rem', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
                           Show in {parentFolder}
                         </span>
                       </div>
                    </div>
                  );
                })}

                {isSidebarCollapsed && exportHistory.map(item => (
                  <div key={item.id} title={`Exported: ${item.filename}\nClick to open folder`}
                    onClick={() => revealInFolder(item.destination_path)}
                    style={{
                    width:'32px', height:'32px', flexShrink:0, display:'flex', justifyContent:'center', alignItems:'center', borderRadius:'6px', cursor:'pointer', background:'rgba(255,255,255,0.05)', border:'1px solid transparent', color: item.mode === 'audio' ? '#83a598' : '#8ec07c',
                    transition:'all 0.15s ease'
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background='rgba(142,192,124,0.15)'; e.currentTarget.style.borderColor='rgba(142,192,124,0.3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor='transparent'; }}
                  >
                    <FolderOpen size={14}/>
                  </div>
                ))}
              </>
            )}
          </>
        )}
        </div>
      </div>
      }

      {/* ═══ A/B VOICE COMPARISON MODAL ═══ */}
      {isCompareModalOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
        }}>
          <div className="glass-panel" style={{ width: 600, maxWidth: '90vw', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', position: 'relative' }}>
            <h2 style={{ margin: 0, color: '#ebdbb2', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.2rem' }}>
              <Scale /> A/B Voice Comparison
            </h2>
            <p style={{ margin: 0, fontSize: '0.85rem', color: '#a89984' }}>Compare two voices side by side to make casting decisions.</p>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: '0.75rem', color: '#a89984', fontWeight: 600 }}>Test Phrase</label>
              <textarea 
                className="input-base" 
                value={compareText} 
                onChange={e => setCompareText(e.target.value)} 
                rows={2} 
                style={{ resize: 'none' }}
              />
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
              {/* Voice A */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)', borderRadius: 8, background: 'rgba(255,255,255,0.01)' }}>
                <h3 style={{ margin: 0, color: '#d3869b', fontSize: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Fingerprint size={14}/> Voice A</h3>
                <select className="input-base" value={compareVoiceA} onChange={e => setCompareVoiceA(e.target.value)}>
                  <option value="">-- Select Voice --</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name} (Preset)</option>)}
                </select>
                {compareResultA ? (
                  <audio src={compareResultA} controls style={{ width: '100%', height: 32, outline: 'none' }} />
                ) : (
                  <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#665c54', fontSize: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: 4 }}>No Audio</div>
                )}
              </div>
              
              {/* Voice B */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)', borderRadius: 8, background: 'rgba(255,255,255,0.01)' }}>
                <h3 style={{ margin: 0, color: '#8ec07c', fontSize: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Fingerprint size={14}/> Voice B</h3>
                <select className="input-base" value={compareVoiceB} onChange={e => setCompareVoiceB(e.target.value)}>
                  <option value="">-- Select Voice --</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name} (Preset)</option>)}
                </select>
                {compareResultB ? (
                  <audio src={compareResultB} controls style={{ width: '100%', height: 32, outline: 'none' }} />
                ) : (
                  <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#665c54', fontSize: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: 4 }}>No Audio</div>
                )}
              </div>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
              <button className="btn-primary" style={{ background: 'transparent', color: '#a89984', padding: '6px 14px' }} onClick={() => setIsCompareModalOpen(false)}>
                Close
              </button>
              <button 
                className="btn-primary" 
                disabled={isComparing || !compareVoiceA || !compareVoiceB || !compareText.trim()}
                onClick={async () => {
                  setIsComparing(true);
                  setCompareResultA(null);
                  setCompareResultB(null);
                  
                  const generateVoice = async (voiceId, setProgress) => {
                    setProgress(`Preparing voice...`);
                    const formData = new FormData();
                    formData.append("text", compareText);
                    
                    let fin_prof = voiceId;
                    let fin_inst = "";
                    if (fin_prof.startsWith('preset:')) {
                      const pr = PRESETS.find(p => p.id === fin_prof.replace('preset:', ''));
                      if (pr) {
                        const parts = Object.values(pr.attrs).filter(v => v !== 'Auto');
                        fin_inst = parts.join(', ');
                      }
                      fin_prof = '';
                    } else if (profiles.find(p => p.id === fin_prof)?.instruct) {
                       fin_inst = profiles.find(p => p.id === fin_prof).instruct;
                    }

                    if (fin_prof) formData.append("profile_id", fin_prof);
                    if (fin_inst) formData.append("instruct", fin_inst);
                    
                    formData.append("num_step", steps);
                    formData.append("guidance_scale", cfg);
                    formData.append("speed", speed);
                    formData.append("denoise", denoise);
                    formData.append("postprocess_output", postprocess);
                    
                    const res = await fetch(`${API}/generate`, { method: "POST", body: formData });
                    if (!res.ok) throw new Error(await res.text());
                    const blob = await res.blob();
                    const urls = await fileToMediaUrl(blob, null);
                    return urls.audioUrl;
                  };
              
                  try {
                    setCompareProgress("Generating Voice A...");
                    const audioA = await generateVoice(compareVoiceA, setCompareProgress);
                    setCompareResultA(audioA);
                    
                    setCompareProgress("Generating Voice B...");
                    const audioB = await generateVoice(compareVoiceB, setCompareProgress);
                    setCompareResultB(audioB);
                    
                    setCompareProgress("");
                    toast.success("Comparison complete!");
                    loadHistory(); 
                  } catch (err) {
                    toast.error("Play failed: " + err.message);
                    setCompareProgress("");
                  } finally {
                    setIsComparing(false);
                  }
                }}
                style={{ padding: '6px 14px', width: 200, display: 'flex', justifyContent: 'center', alignItems: 'center' }}
              >
                {isComparing ? <><Loader className="spinner" size={14}/> {compareProgress}</> : <><Play size={14}/> Compare</>}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
