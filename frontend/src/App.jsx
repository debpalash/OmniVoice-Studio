import React, { useState, useRef, useEffect, useCallback } from 'react';
import './index.css';
import WaveformTimeline from './components/WaveformTimeline';
import { Toaster, toast } from 'react-hot-toast';
import ALL_LANGUAGES from './languages.json';
import { 
  Sparkles, Fingerprint, Wand2, SlidersHorizontal, UserSquare2, ShieldCheck, 
  Download as DownloadIcon, History, Command, Globe, Volume2, UploadCloud, 
  Settings2, ChevronDown, ChevronUp, Play, Search, Film, Trash2,
  FileText, Loader, Check, AlertCircle, Plus, User, Save, Languages, Headphones,
  FolderOpen, FolderPlus, Pencil, Clock, Lock, Unlock, Mic, MicOff, Square,
  CheckCircle, Circle, ChevronRight, Target, PanelLeftClose, PanelLeftOpen
} from 'lucide-react';

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

const API = "http://localhost:8000";

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
  const [langSearch, setLangSearch] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [history, setHistory] = useState([]);
  
  const [speed, setSpeed] = useState(1.0);
  const [steps, setSteps] = useState(16);
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
  const [dubLangSearch, setDubLangSearch] = useState('');
  const [dubLangCode, setDubLangCode] = useState('en');
  const [dubInstruct, setDubInstruct] = useState('');
  const [dubProgress, setDubProgress] = useState({ current: 0, total: 0, text: '' });
  const [dubFilename, setDubFilename] = useState('');
  const [dubDuration, setDubDuration] = useState(0);
  const [dubError, setDubError] = useState('');
  const [dubVideoFile, setDubVideoFile] = useState(null);
  const [dubLocalBlobUrl, setDubLocalBlobUrl] = useState(null);
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

  useEffect(() => {
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
      } catch (e) {}
    };
    fetchStats();
    const interval = setInterval(fetchStats, 2000);
    return () => clearInterval(interval);
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

  useEffect(() => {
    loadProfiles();
    loadHistory();
    loadDubHistory();
    loadProjects();
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
    } catch (e) {}
  }, []);

  useEffect(() => {
    localStorage.setItem('omni_ui', JSON.stringify({
      uiScale, text, mode, vdStates, language,
      isSidebarCollapsed, sidebarTab,
      dubJobId, dubFilename, dubDuration, dubSegments, 
      dubLang, dubLangCode, dubTracks, dubStep, dubTranscript
    }));
  }, [uiScale, text, mode, vdStates, language, isSidebarCollapsed, sidebarTab, dubJobId, dubFilename, dubDuration, dubSegments, dubLang, dubLangCode, dubTracks, dubStep, dubTranscript]);

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
      const a = new Audio(URL.createObjectURL(blob));
      toast.success('Preview ready!', { id: toastId });
      a.play().catch(() => toast.error('Playback failed', { id: toastId }));
      
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
      
      if (dubLang !== 'Auto') formData.append("language", dubLang);
      
      formData.append("num_step", steps || 16);
      if (seg.speed && seg.speed !== 1.0) formData.append("speed", seg.speed);
      
      const res = await fetch(`${API}/generate`, { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const a = new Audio(URL.createObjectURL(blob));
      toast.success('Preview ready!', { id: toastId });
      a.play().catch(() => toast.error('Playback failed', { id: toastId }));
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
  const handleDubUpload = async () => {
    if (!dubVideoFile) return;
    setDubStep('uploading'); setDubError(''); setDubTracks([]);
    try {
      const fd = new FormData();
      fd.append("video", dubVideoFile);
      const res = await fetch(`${API}/dub/upload`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDubJobId(data.job_id); setDubFilename(data.filename); setDubDuration(data.duration);
      setDubStep('transcribing');
      setTranscribeStart(Date.now());
      const tRes = await fetch(`${API}/dub/transcribe/${data.job_id}`, { method: "POST" });
      if (!tRes.ok) throw new Error(await tRes.text());
      const tData = await tRes.json();
      setDubSegments(tData.segments.map((s, i) => ({ ...s, id: i })));
      setDubTranscript(tData.full_transcript || '');
      setTranscribeStart(null);
      setDubStep('editing');
    } catch (err) { setDubError(err.message); setDubStep('idle'); setTranscribeStart(null); }
  };

  // Transcription elapsed timer
  useEffect(() => {
    if (!transcribeStart) { setTranscribeElapsed(0); return; }
    const iv = setInterval(() => setTranscribeElapsed(Math.floor((Date.now() - transcribeStart) / 1000)), 500);
    return () => clearInterval(iv);
  }, [transcribeStart]);

  // ── AUTO-TRANSLATE ──
  const handleTranslateAll = async () => {
    if (!dubSegments.length || !dubLangCode) return;
    setIsTranslating(true);
    try {
      const res = await fetch(`${API}/dub/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments: dubSegments.map(s => ({ id: s.id, text: s.text })),
          target_lang: dubLangCode,
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
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
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
              else if (evt.type === 'done') { setDubStep('done'); setDubTracks(evt.tracks || []); }
              else if (evt.type === 'error') setDubError(p => p + `\nSeg ${evt.segment}: ${evt.error}`);
            } catch (e) {}
          }
        }
      }
      if (dubStep !== 'done') setDubStep('done');
      loadDubHistory();
      playPing();
    } catch (err) { setDubError(err.message); setDubStep('editing'); }
  };

  const triggerDownload = (url, fallbackName) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = fallbackName || 'download';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
    setDubLocalBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
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

  const loadProject = async (project) => {
    try {
      const res = await fetch(`${API}/projects/${project.id}`);
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

  const filteredLangs = langSearch ? ALL_LANGUAGES.filter(l => l.toLowerCase().includes(langSearch.toLowerCase())) : ALL_LANGUAGES;
  const filteredDubLangs = dubLangSearch ? ALL_LANGUAGES.filter(l => l.toLowerCase().includes(dubLangSearch.toLowerCase())) : ALL_LANGUAGES;

  return (
    <div className="app-container" style={{ zoom: uiScale, gridTemplateColumns: isSidebarCollapsed ? '0px 1fr' : undefined }}>
      <Toaster position="top-center" toastOptions={{
        style: { background: 'rgba(40,40,40,0.9)', backdropFilter: 'blur(10px)', color: '#ebdbb2', border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.72rem', padding: '4px 8px' },
        error: { iconTheme: { primary: '#fb4934', secondary: '#fff' } },
        success: { iconTheme: { primary: '#b8bb26', secondary: '#fff' } }
      }}/>
      <div className="header-area" style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'8px', overflowX:'auto', paddingBottom:'8px', paddingTop:'4px', gridColumn: '1 / -1', gridRow: '1'}}>
        <div style={{display:'flex', alignItems:'center', gap:'16px'}}>
          <div style={{display:'flex', alignItems:'center', gap:'8px', flexShrink:0}}>
            <button 
               onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
               style={{display:'flex', alignItems:'center', justifyContent:'center', padding:'4px', background: isSidebarCollapsed ? 'rgba(211,134,155,0.1)' : 'rgba(255,255,255,0.05)', border:`1px solid ${isSidebarCollapsed ? 'rgba(211,134,155,0.3)' : 'rgba(255,255,255,0.1)'}`, color: isSidebarCollapsed ? '#d3869b' : '#ebdbb2', borderRadius:4, cursor:'pointer', marginRight: 4}}
               title="Toggle Sidebar"
            >
               {isSidebarCollapsed ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}
            </button>
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#d3869b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
              <circle cx="12" cy="12" r="10" opacity="0.2" fill="#d3869b"/>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v12" />
              <path d="M8 9v6" />
              <path d="M16 9v6" />
            </svg>
            <div style={{whiteSpace:'nowrap', display:'flex', flexDirection:'column', justifyContent:'center'}}>
              <h1 style={{fontSize:'1.05rem', margin:0, lineHeight:'1', paddingBottom:'3px'}}>OmniVoice Studio</h1>
              <span style={{fontSize:'0.55rem', color:'var(--text-secondary)', lineHeight:'1'}}>646 languages · Clone · Design · Dub</span>
            </div>
          </div>

          <div className="tabs" style={{marginBottom: 0, flexShrink: 0, minWidth: '220px'}}>
            <button className={`tab ${mode === 'launchpad' ? 'active' : ''}`} style={{whiteSpace:'nowrap'}} onClick={() => setMode('launchpad')}><Globe size={11}/> Launchpad</button>
            <button className={`tab ${mode === 'clone' ? 'active' : ''}`} style={{whiteSpace:'nowrap'}} onClick={() => setMode('clone')}><Fingerprint size={11}/> Clone</button>
            <button className={`tab ${mode === 'design' ? 'active' : ''}`} style={{whiteSpace:'nowrap'}} onClick={() => setMode('design')}><Wand2 size={11}/> Design</button>
            <button className={`tab ${mode === 'dub' ? 'active' : ''}`} style={{whiteSpace:'nowrap'}} onClick={() => setMode('dub')}><Film size={11}/> Dub</button>
          </div>
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0}}>
          <div style={{display:'flex', gap:1, background:'rgba(0,0,0,0.3)', padding:2, borderRadius:4, border:'1px solid rgba(255,255,255,0.04)', flexShrink:0}}>
            <button onClick={() => setUiScale(1)} style={{fontSize:'0.58rem', padding:'1px 4px', border:'none', borderRadius:3, cursor:'pointer', background: uiScale === 1 ? 'rgba(255,255,255,0.1)' : 'transparent', color: uiScale === 1 ? '#fff' : '#a89984', whiteSpace:'nowrap'}}>Small</button>
            <button onClick={() => setUiScale(1.3)} style={{fontSize:'0.58rem', padding:'1px 4px', border:'none', borderRadius:3, cursor:'pointer', background: uiScale === 1.3 ? 'rgba(255,255,255,0.1)' : 'transparent', color: uiScale === 1.3 ? '#fff' : '#a89984', whiteSpace:'nowrap'}}>Normal</button>
            <button onClick={() => setUiScale(1.5)} style={{fontSize:'0.58rem', padding:'1px 4px', border:'none', borderRadius:3, cursor:'pointer', background: uiScale === 1.5 ? 'rgba(255,255,255,0.1)' : 'transparent', color: uiScale === 1.5 ? '#fff' : '#a89984', whiteSpace:'nowrap'}}>Max</button>
          </div>
          {sysStats && (
            <div style={{display:'flex', gap:'6px', fontSize:'0.55rem', color:'#a89984', background:'rgba(0,0,0,0.3)', padding:'2px 6px', borderRadius:'4px', border:'1px solid rgba(255,255,255,0.04)', whiteSpace:'nowrap', flexShrink:0, alignItems:'center'}}>
              <span><b style={{color:'#ebdbb2', fontWeight:600}}>RAM</b> {sysStats.ram.toFixed(1)}/{sysStats.total_ram.toFixed(0)}G</span>
              <span><b style={{color:'#ebdbb2', fontWeight:600}}>CPU</b> {sysStats.cpu.toFixed(0)}%</span>
              <span style={{borderLeft:'1px solid rgba(255,255,255,0.08)', paddingLeft:6}}>
                <b style={{color: sysStats.gpu_active ? '#8ec07c' : '#ebdbb2', fontWeight:600}}>VRAM</b> {sysStats.vram.toFixed(1)}G
                {sysStats.gpu_active && <span style={{color:'#8ec07c', marginLeft:3}}>●</span>}
              </span>
              <span style={{borderLeft:'1px solid rgba(255,255,255,0.08)', paddingLeft:6, display:'flex', alignItems:'center', gap:3}}>
                <span style={{
                  width:6, height:6, borderRadius:'50%', display:'inline-block',
                  background: modelStatus === 'ready' ? '#8ec07c' : modelStatus === 'loading' ? '#fabd2f' : '#665c54',
                  boxShadow: modelStatus === 'loading' ? '0 0 6px rgba(250,189,47,0.5)' : modelStatus === 'ready' ? '0 0 4px rgba(142,192,124,0.4)' : 'none',
                  animation: modelStatus === 'loading' ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }}/>
                <span style={{color: modelStatus === 'ready' ? '#8ec07c' : modelStatus === 'loading' ? '#fabd2f' : '#665c54'}}>
                  {modelStatus === 'ready' ? 'Model Ready' : modelStatus === 'loading' ? 'Loading…' : 'Model Idle'}
                </span>
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="main-content">

        {/* ═══ LAUNCHPAD TAB ═══ */}
        {mode === 'launchpad' ? (
          <div className="glass-panel" style={{flex:1, display:'flex', flexDirection:'column', overflowY:'auto'}}>
            <div style={{padding:'20px 30px', borderBottom:'1px solid rgba(255,255,255,0.08)'}}>
              <h2 style={{margin:0, fontSize:'1.4rem', display:'flex', alignItems:'center', gap:'10px'}}><Globe color="#ebdbb2"/> Unified Workspace</h2>
              <p style={{margin:'4px 0 0 0', color:'#a89984', fontSize:'0.85rem'}}>Select a cloned voice, design preset, or dubbing project to load into the studio.</p>
              
              {/* Quick Start Guide */}
              <div style={{marginTop:'20px', padding:'15px', background:'rgba(255,255,255,0.02)', borderRadius:'8px', border:'1px solid rgba(255,255,255,0.05)'}}>
                <h3 style={{fontSize:'0.9rem', color:'#ebdbb2', margin:'0 0 12px 0', display:'flex', alignItems:'center', gap:6}}><Target size={14}/> OmniVoice Workflow Guide</h3>
                <div style={{display:'flex', gap:'15px'}}>
                  {/* Step 1 */}
                  <div style={{flex:1, opacity: profiles.length > 0 ? 1 : 0.6}}>
                    <div style={{display:'flex', alignItems:'center', gap:'8px', marginBottom:'6px'}}>
                      {profiles.length > 0 ? <CheckCircle size={14} color="#b8bb26"/> : <Circle size={14} color="#a89984"/>}
                      <span style={{fontSize:'0.8rem', fontWeight:600, color: profiles.length > 0 ? '#b8bb26' : '#ebdbb2'}}>1. Create a Voice</span>
                    </div>
                    <p style={{margin:0, fontSize:'0.7rem', color:'#a89984'}}>Clone a voice from audio or design a new one.</p>
                  </div>
                  <ChevronRight size={16} color="#504945" style={{alignSelf:'center'}}/>
                  {/* Step 2 */}
                  <div style={{flex:1, opacity: studioProjects.length > 0 ? 1 : 0.6}}>
                    <div style={{display:'flex', alignItems:'center', gap:'8px', marginBottom:'6px'}}>
                      {studioProjects.length > 0 ? <CheckCircle size={14} color="#b8bb26"/> : <Circle size={14} color="#a89984"/>}
                      <span style={{fontSize:'0.8rem', fontWeight:600, color: studioProjects.length > 0 ? '#b8bb26' : '#ebdbb2'}}>2. Upload Video</span>
                    </div>
                    <p style={{margin:0, fontSize:'0.7rem', color:'#a89984'}}>Go to 'Dub', upload a video, and transcribe it.</p>
                  </div>
                  <ChevronRight size={16} color="#504945" style={{alignSelf:'center'}}/>
                  {/* Step 3 */}
                  <div style={{flex:1, opacity: dubHistory.length > 0 ? 1 : 0.6}}>
                    <div style={{display:'flex', alignItems:'center', gap:'8px', marginBottom:'6px'}}>
                      {dubHistory.length > 0 ? <CheckCircle size={14} color="#b8bb26"/> : <Circle size={14} color="#a89984"/>}
                      <span style={{fontSize:'0.8rem', fontWeight:600, color: dubHistory.length > 0 ? '#b8bb26' : '#ebdbb2'}}>3. Generate Dub</span>
                    </div>
                    <p style={{margin:0, fontSize:'0.7rem', color:'#a89984'}}>Assign voices, translate, and download the video.</p>
                  </div>
                </div>
              </div>
            </div>
            
            <div style={{flex:1, padding:'30px', display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(300px, 1fr))', gap:'30px'}}>
              {/* Clone Voices */}
              <div>
                <h3 style={{fontSize:'1rem', color:'#d3869b', marginBottom:'16px', display:'flex', alignItems:'center', gap:'8px'}}><Fingerprint size={16}/> Cloned Voices ({profiles.filter(p => !p.instruct).length})</h3>
                <div style={{display:'flex', flexDirection:'column', gap:'12px'}}>
                  {profiles.filter(p => !p.instruct).length === 0 ? <p style={{fontSize:'0.85rem', color:'#665c54'}}>No models.</p> : profiles.filter(p => !p.instruct).map(p => (
                    <div key={p.id} className="history-item" style={{margin:0, borderLeft:'3px solid #d3869b', padding:'12px'}}>
                      <div style={{fontSize:'0.9rem', fontWeight:600}}>{p.name}</div>
                      <div style={{fontSize:'0.7rem', color:'#a89984', marginTop:'4px'}}>{p.ref_audio_path}</div>
                      <div style={{display:'flex', gap:'8px', marginTop:'10px'}}>
                        <button onClick={() => { setMode('clone'); handleSelectProfile(p); }} style={{fontSize:'0.75rem', padding:'4px 12px', borderRadius:'4px', background:'rgba(255,255,255,0.05)', color:'#ebdbb2', border:'1px solid rgba(255,255,255,0.1)', cursor:'pointer'}}>Open inside Clone</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Designed Voices */}
              <div>
                <h3 style={{fontSize:'1rem', color:'#8ec07c', marginBottom:'16px', display:'flex', alignItems:'center', gap:'8px'}}><Wand2 size={16}/> Designed Voices ({profiles.filter(p => !!p.instruct).length})</h3>
                <div style={{display:'flex', flexDirection:'column', gap:'12px'}}>
                  {profiles.filter(p => !!p.instruct).length === 0 ? <p style={{fontSize:'0.85rem', color:'#665c54'}}>No models.</p> : profiles.filter(p => !!p.instruct).map(p => (
                    <div key={p.id} className="history-item" style={{margin:0, borderLeft: `3px solid ${p.is_locked ? '#b8bb26' : '#8ec07c'}`, padding:'12px'}}>
                      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                        <div style={{fontSize:'0.9rem', fontWeight:600}}>{p.name}</div>
                        {p.is_locked ? (
                          <span style={{fontSize:'0.6rem', padding:'1px 6px', borderRadius:4, background:'rgba(184,187,38,0.2)', color:'#b8bb26', display:'flex', alignItems:'center', gap:3}}><Lock size={9}/> LOCKED</span>
                        ) : (
                          <span style={{fontSize:'0.6rem', padding:'1px 6px', borderRadius:4, background:'rgba(142,192,124,0.15)', color:'#8ec07c'}}>DESIGN</span>
                        )}
                      </div>
                      <div style={{fontSize:'0.7rem', color:'#a89984', fontStyle:'italic', marginTop:'4px'}}>{p.instruct}</div>
                      <div style={{display:'flex', gap:'8px', marginTop:'10px'}}>
                        <button onClick={() => { setMode('design'); handleSelectProfile(p); }} style={{fontSize:'0.75rem', padding:'4px 12px', borderRadius:'4px', background:'rgba(255,255,255,0.05)', color:'#ebdbb2', border:'1px solid rgba(255,255,255,0.1)', cursor:'pointer'}}>Open inside Design</button>
                        {p.is_locked && (
                          <button onClick={() => handleUnlockProfile(p.id)} style={{fontSize:'0.75rem', padding:'4px 12px', borderRadius:'4px', background:'rgba(184,187,38,0.1)', border:'1px solid rgba(184,187,38,0.2)', color:'#b8bb26', cursor:'pointer', display:'flex', alignItems:'center', gap:4}}>
                            <Unlock size={11}/> Unlock
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Studio Projects */}
              <div>
                <h3 style={{fontSize:'1rem', color:'#fe8019', marginBottom:'16px', display:'flex', alignItems:'center', gap:'8px'}}><Film size={16}/> Dubbing Projects ({studioProjects.length})</h3>
                <div style={{display:'flex', flexDirection:'column', gap:'12px'}}>
                  {studioProjects.length === 0 ? <p style={{fontSize:'0.85rem', color:'#665c54'}}>No projects.</p> : studioProjects.map(proj => (
                    <div key={proj.id} className="history-item" style={{margin:0, borderLeft:'3px solid #fe8019', padding:'12px'}}>
                      <div style={{fontSize:'0.9rem', fontWeight:600}}>{proj.name}</div>
                      <div style={{fontSize:'0.7rem', color:'#a89984', marginTop:'4px'}}>{proj.video_path || "Audio Only"}</div>
                      <div style={{display:'flex', gap:'8px', marginTop:'10px'}}>
                        <button onClick={() => { setMode('dub'); loadProject(proj.id); }} style={{fontSize:'0.75rem', padding:'4px 12px', borderRadius:'4px', background:'rgba(255,255,255,0.05)', color:'#ebdbb2', border:'1px solid rgba(255,255,255,0.1)', cursor:'pointer'}}>Open inside Studio</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : mode === 'dub' ? (
          <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0}}>
            {/* ── Idle: show full editor skeleton with drop zone ── */}
            {!(dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done')) && (
              <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0}}>
                {/* Header bar (matches editing layout) */}
                <div className="glass-panel" style={{padding:'4px 8px', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0}}>
                  <div className="label-row" style={{marginBottom:0}}>
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
                          audioSrc={dubLocalBlobUrl}
                          videoSrc={dubLocalBlobUrl}
                          segments={[]}
                          onSegmentsChange={() => {}}
                          disabled={true}
                          overlayContent={
                            dubStep === 'uploading' ? (
                              <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:8}}>
                                <Loader className="spinner" size={20} color="#d3869b"/>
                                <span style={{color:'#ebdbb2', fontWeight:500, fontSize:'0.85rem'}}>Extracting audio…</span>
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
                          setDubLocalBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
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
                        setDubLocalBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
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
                  <div className="label-row" style={{marginBottom:0}}>
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
                      disabled={dubStep === 'generating'}
                      overlayContent={dubStep === 'generating' ? (
                        <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:6, width:'100%'}}>
                          <div style={{display:'flex', alignItems:'center', gap:6}}>
                            <Sparkles className="spinner" size={14} color="#d3869b"/>
                            <span style={{color:'#ebdbb2', fontWeight:500, fontSize:'0.72rem'}}>
                              Dubbing {dubProgress.current}/{dubProgress.total}…
                            </span>
                          </div>
                          <div className="progress-container" style={{width:'80%', maxWidth:240}}>
                            <div className="progress-fill" style={{
                              width:`${dubProgress.total ? (dubProgress.current/dubProgress.total)*100 : 0}%`
                            }}/>
                          </div>
                          {dubProgress.text && <span style={{fontSize:'0.65rem', color:'#a89984'}}>{dubProgress.text}</span>}
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
                        <select className="input-base" value={dubLang} onChange={e => setDubLang(e.target.value)} style={{fontSize:'0.65rem'}}>
                          {filteredDubLangs.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                      </div>
                      <div style={{flex:1, minWidth:80}}>
                        <div className="label-row">ISO Code</div>
                        <select className="input-base" value={dubLangCode} onChange={e => setDubLangCode(e.target.value)} style={{fontSize:'0.65rem'}}>
                          {LANG_CODES.map(lc => <option key={lc.code} value={lc.code}>{lc.code} — {lc.label}</option>)}
                        </select>
                      </div>
                      <div style={{flex:1, minWidth:90}}>
                        <div className="label-row"><UserSquare2 className="label-icon" size={9}/> Style</div>
                        <input className="input-base" placeholder="e.g. female" value={dubInstruct} onChange={e => setDubInstruct(e.target.value)} style={{fontSize:'0.65rem'}}/>
                      </div>
                      <button onClick={handleTranslateAll} disabled={isTranslating || !dubSegments.length}
                        style={{padding:'3px 8px', background:'rgba(131,165,152,0.12)', border:'1px solid rgba(131,165,152,0.25)', color:'#83a598', borderRadius:4, cursor:'pointer', fontSize:'0.62rem', fontWeight:500, display:'flex', alignItems:'center', gap:3, whiteSpace:'nowrap'}}>
                        {isTranslating ? <Loader className="spinner" size={9}/> : <Languages size={10}/>}
                        {isTranslating ? 'Translating…' : 'Translate All'}
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
                        <span style={{width:90}}>Voice</span>
                        <span style={{width:30}} title="Volume (0-200%)">Vol</span>
                        <span style={{width:40}}></span>
                      </div>
                      {dubSegments.map((seg, idx) => (
                        <div key={seg.id} className={`segment-row ${dubStep==='generating'&&dubProgress.current===idx+1?'segment-active':''} ${dubStep==='generating'&&dubProgress.current>idx+1?'segment-done':''}`}>
                          <span className="segment-time" style={{width:55}}>
                            {formatTime(seg.start)}–{formatTime(seg.end)}
                            {seg.speed && seg.speed !== 1.0 && (
                              <span style={{fontSize:'0.55rem', color: seg.speed > 1 ? '#d3869b' : '#8ec07c', marginLeft:2}}>
                                {seg.speed.toFixed(2)}x
                              </span>
                            )}
                          </span>
                          <span style={{width:50, fontSize:'0.58rem', color:'#a89984'}}>{seg.speaker_id || ''}</span>
                          <input className="input-base segment-input" value={seg.text}
                            onChange={e => editSegments(dubSegments.map(s => s.id===seg.id?{...s,text:e.target.value}:s))}
                            disabled={dubStep==='generating'}/>
                          <select className="input-base" style={{width:90, fontSize:'0.6rem', padding:'1px 3px'}}
                            value={seg.profile_id||''} disabled={dubStep==='generating'}
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
                            disabled={dubStep==='generating'}
                            onChange={e => editSegments(dubSegments.map(s => s.id===seg.id?{...s,gain:Number(e.target.value)/100}:s))}
                            style={{width:30, height:2, padding:0, margin:0, accentColor: (seg.gain ?? 1.0) > 1.2 ? '#fb4934' : (seg.gain ?? 1.0) < 0.5 ? '#83a598' : '#a89984'}}
                          />
                          <div style={{display:'flex', gap:1, width:40}}>
                            <button className="segment-play" disabled={dubStep==='generating'} title="Live Preview" onClick={(e) => handleSegmentPreview(seg, e)}>
                              {segmentPreviewLoading === seg.id ? <Loader className="spinner" size={9}/> : <Headphones size={9}/>}
                            </button>
                            <button className="segment-del" disabled={dubStep==='generating'}
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
                    <button className="btn-primary" style={{marginTop:0, flex:1, padding:'4px 8px', fontSize:'0.7rem'}} onClick={handleDubGenerate} disabled={dubStep==='generating'||!dubSegments.length}>
                      {dubStep==='generating' ? <><Sparkles className="spinner" size={11}/> Dubbing…</> : <><Play size={11}/> Generate Dub</>}
                    </button>
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
                </div>
              </div>
            )}
          </div>
        ) : (

          <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0}}>
            {/* ═══ CLONE / DESIGN ═══ */}
            <div className="glass-panel" style={{flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0}}>
              <div className="label-row"><Command className="label-icon" size={14}/> Prompt</div>
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
                  <div style={{position:'relative'}}>
                    <Search size={14} color="#a89984" style={{position:'absolute', left:8, top:8, zIndex:1}}/>
                    <input type="text" className="input-base" style={{paddingLeft:28, fontSize:'0.8rem', marginBottom:4}}
                      placeholder="Search languages..." value={langSearch} onChange={e => setLangSearch(e.target.value)}/>
                    <select className="input-base" value={language} onChange={e => setLanguage(e.target.value)}>
                      {filteredLangs.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
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
      {!isSidebarCollapsed && (
        <div className="glass-panel history-panel" style={{display:'flex', flexDirection:'column'}}>
          <div style={{display:'flex', gap:'4px', padding:'6px', borderBottom:'1px solid var(--glass-border)', background:'rgba(0,0,0,0.15)', flexShrink:0}}>
            <button onClick={() => setSidebarTab('projects')} style={{
              flex:1, padding:'4px 0', fontSize:'0.72rem', fontWeight:600, cursor:'pointer', border:`1px solid ${sidebarTab === 'projects' ? 'rgba(184,187,38,0.3)' : 'transparent'}`,
              background: sidebarTab === 'projects' ? 'rgba(184,187,38,0.15)' : 'transparent',
              color: sidebarTab === 'projects' ? '#b8bb26' : '#a89984',
              borderRadius:4, whiteSpace: 'nowrap', transition:'all 0.2s ease'
            }}><FolderOpen size={12} style={{verticalAlign:'middle', marginRight:4}}/> 
              Projects ({mode === 'dub' ? studioProjects.length : (mode === 'clone' ? profiles.filter(p => !p.instruct).length : profiles.filter(p => !!p.instruct).length)})
            </button>
            <button onClick={() => setSidebarTab('history')} style={{
              flex:1, padding:'4px 0', fontSize:'0.72rem', fontWeight:600, cursor:'pointer', border:`1px solid ${sidebarTab === 'history' ? 'rgba(211,134,155,0.3)' : 'transparent'}`,
              background: sidebarTab === 'history' ? 'rgba(211,134,155,0.15)' : 'transparent',
              color: sidebarTab === 'history' ? '#d3869b' : '#a89984',
              borderRadius:4, whiteSpace: 'nowrap', transition:'all 0.2s ease'
            }}><History size={12} style={{verticalAlign:'middle', marginRight:4}}/> 
              History ({history.length + dubHistory.length})
            </button>
          </div>

        {/* ── PROJECTS TAB ── */}
        {sidebarTab === 'projects' && (
          <>

            {/* Save current work as dub project button (only in dub mode) */}
            {mode === 'dub' && (dubStep !== 'idle' || dubVideoFile) && (
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

            <div 
              style={{fontSize:'0.68rem', color:'var(--text-secondary)', marginBottom:8, display:'flex', justifyContent:'space-between', alignItems:'center', cursor:'pointer', padding:'2px 0'}}
              onClick={() => setIsSidebarProjectsCollapsed(!isSidebarProjectsCollapsed)}
            >
              <span>{mode === 'dub' ? 'Studio Projects (Dubbing)' : (mode === 'clone' ? 'Voice Clones (Audio)' : 'Designed Voices (Synthetic)')}</span>
              {isSidebarProjectsCollapsed ? <ChevronDown size={12}/> : <ChevronUp size={12}/>}
            </div>

            {!isSidebarProjectsCollapsed && (
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
                        <div key={proj.id} className={`history-item ${activeProjectId === proj.id ? 'project-active' : ''}`} style={{position:'relative'}}>
                          <div className="history-header">
                            <div className="history-badge" style={{background: activeProjectId === proj.id ? 'rgba(184,187,38,0.2)' : 'rgba(131,165,152,0.15)', color: activeProjectId === proj.id ? '#b8bb26' : '#83a598'}}>
                              <Film size={10}/> DUB PROJECT
                            </div>
                          </div>
                          <div style={{fontSize:'0.78rem', color:'var(--text-primary)', marginBottom:2, fontWeight:500}}>
                            {proj.name}
                          </div>
                          <div style={{display:'flex', gap:6, fontSize:'0.65rem', color:'var(--text-secondary)'}}>
                            {proj.duration && <span>{Math.round(proj.duration)}s</span>}
                            {proj.video_path && <span>· {proj.video_path}</span>}
                          </div>
                          <div style={{fontSize:'0.6rem', color:'#665c54', marginTop:2}}>
                            <Clock size={9} style={{verticalAlign:'middle', marginRight:3}}/>
                            {new Date(proj.updated_at * 1000).toLocaleString()}
                          </div>
                          <div style={{display:'flex', gap:'6px', marginTop:'8px'}}>
                            <button onClick={() => loadProject(proj.id)} style={{flex:1, padding:'4px', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', color:'#ebdbb2', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px'}}>
                              <FolderOpen size={10}/> Load
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); deleteProject(proj.id); }} style={{padding:'4px 8px', background:'rgba(251,73,52,0.1)', border:'1px solid rgba(251,73,52,0.2)', color:'#fb4934', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0}}>
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
                        <div key={proj.id} className={`history-item ${selectedProfile === proj.id ? 'project-active' : ''}`} style={{position:'relative', borderLeft: proj.is_locked ? '2px solid #b8bb26' : undefined}}>
                          <div className="history-header">
                            <div className="history-badge" style={{background: proj.is_locked ? 'rgba(184,187,38,0.2)' : 'rgba(142,192,124,0.15)', color: proj.is_locked ? '#b8bb26' : '#8ec07c'}}>
                              {proj.is_locked ? <Lock size={10}/> : (mode === 'clone' ? <Fingerprint size={10}/> : <Wand2 size={10}/>)} {proj.is_locked ? 'LOCKED' : (mode === 'clone' ? 'CLONE' : 'DESIGN')}
                            </div>
                            {proj.is_locked && (
                              <div style={{fontSize:'0.55rem', color:'#b8bb26', fontStyle:'italic'}}>Consistent</div>
                            )}
                          </div>
                          <div style={{fontSize:'0.78rem', color:'var(--text-primary)', marginBottom:2, fontWeight:500}}>
                            {proj.name}
                          </div>
                          {proj.instruct && <div style={{fontSize:'0.6rem', color:'#a89984', fontStyle:'italic', marginBottom:2}}>{proj.instruct}</div>}
                          <div style={{display:'flex', gap:'6px', marginTop:'8px'}}>
                             <button onClick={(e) => handlePreviewVoice(proj, e)} style={{padding:'4px 8px', background:'rgba(211,134,155,0.1)', border:'1px solid rgba(211,134,155,0.2)', color:'#d3869b', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0}} title="Preview voice">
                               {previewLoading === proj.id ? <Loader className="spinner" size={10}/> : <Play size={10}/>}
                             </button>
                             <button onClick={() => handleSelectProfile(proj)} style={{flex:1, padding:'4px', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', color:'#ebdbb2', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px'}}>
                               <FolderOpen size={10}/> Select
                             </button>
                             {proj.is_locked && (
                               <button onClick={(e) => { e.stopPropagation(); handleUnlockProfile(proj.id); }} style={{padding:'4px 8px', background:'rgba(184,187,38,0.1)', border:'1px solid rgba(184,187,38,0.2)', color:'#b8bb26', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'2px', flexShrink:0}} title="Unlock: voice will vary between generations">
                                 <Unlock size={10}/>
                               </button>
                             )}
                             <button onClick={(e) => { e.stopPropagation(); handleDeleteProfile(proj.id); }} style={{padding:'4px 8px', background:'rgba(251,73,52,0.1)', border:'1px solid rgba(251,73,52,0.2)', color:'#fb4934', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0}}>
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
          </>
        )}

        {/* ── HISTORY TAB ── */}
        {sidebarTab === 'history' && (
          <>
            <div style={{fontSize:'0.68rem', color:'var(--text-secondary)', marginBottom:8}}>Generation history · Stored in SQLite</div>
            {(history.length + dubHistory.length) === 0 ? (
              <div style={{color:'var(--text-secondary)', textAlign:'center', padding:'24px 12px'}}>
                <History size={28} style={{opacity:0.3, marginBottom:8}} />
                <p style={{fontSize:'0.78rem', margin:0, marginBottom:4}}>No generation history</p>
                <p style={{fontSize:'0.62rem', margin:0, opacity:0.6}}>Synthesize audio or dub a video — results will appear here.</p>
              </div>
            ) : (
              <>
                {/* Dub history */}
                {dubHistory.map(item => (
                  <div key={`dub-${item.id}`} className="history-item">
                    <div className="history-header">
                      <div className="history-badge" style={{background:'rgba(131,165,152,0.15)', color:'#83a598'}}>
                        <Film size={10}/> DUB
                      </div>
                      <div className="history-time">{item.segments_count} segs</div>
                    </div>
                    <div style={{fontSize:'0.75rem', color:'var(--text-primary)', marginBottom:2}}>
                      {item.filename}
                    </div>
                    <div style={{display:'flex', gap:4, flexWrap:'wrap', marginBottom:2}}>
                      <span style={{fontSize:'0.65rem', padding:'1px 6px', background:'rgba(131,165,152,0.15)', color:'#83a598', borderRadius:4}}>
                        {item.language} ({item.language_code})
                      </span>
                      <span style={{fontSize:'0.65rem', color:'var(--text-secondary)'}}>
                        {Math.round(item.duration)}s
                      </span>
                    </div>

                    <div style={{display:'flex', gap:'6px', marginTop:'8px'}}>
                      <button onClick={() => restoreDubHistory(item)} style={{flex:1, padding:'4px', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', color:'#ebdbb2', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px'}}>
                        <FolderOpen size={10}/> Load
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); deleteHistory(item.id, 'dub'); }} style={{padding:'4px 8px', background:'rgba(251,73,52,0.1)', border:'1px solid rgba(251,73,52,0.2)', color:'#fb4934', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0}}>
                        <Trash2 size={10}/>
                      </button>
                    </div>
                  </div>
                ))}

                {/* Clone/Design history */}
                {history.map(item => (
                  <div key={item.id} className="history-item">
                    <div className="history-header">
                      <div className="history-badge">
                        {item.mode === 'clone' ? <Fingerprint size={10}/> : <Wand2 size={10}/>} {(item.mode||'').toUpperCase()}
                      </div>
                      {item.generation_time && <div className="history-time">{item.generation_time}s</div>}
                    </div>
                    {item.language && item.language !== 'Auto' && <div style={{fontSize:'0.65rem', color:'#83a598', marginBottom:4}}>{item.language}</div>}
                    {item.seed && <div style={{fontSize:'0.55rem', color:'#665c54', marginBottom:2}}>seed: {item.seed}</div>}
                    <div className="history-text" title={item.text}>{item.text}</div>
                    {item.audio_path && <audio controls src={`${API}/audio/${item.audio_path}`} />}
                    {item.audio_path && (
                      <div style={{display:'flex', gap:'6px', marginTop:'8px', flexWrap:'wrap'}}>
                        <button onClick={() => handleSaveHistoryAsProfile(item)} style={{flex:1, padding:'4px', background:'rgba(142,192,124,0.1)', border:'1px solid rgba(142,192,124,0.2)', color:'#8ec07c', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px', whiteSpace:'nowrap'}}>
                          <Save size={10}/> Save Profile
                        </button>
                        {/* Lock Voice: only for items that have an associated profile */}
                        {item.profile_id && (
                          <button onClick={() => handleLockProfile(item.profile_id, item.id, item.seed)} style={{padding:'4px 8px', background:'rgba(184,187,38,0.1)', border:'1px solid rgba(184,187,38,0.2)', color:'#b8bb26', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'3px', whiteSpace:'nowrap'}} title="Lock this exact voice identity for consistent regeneration">
                            <Lock size={10}/> Lock
                          </button>
                        )}
                        <a href={`${API}/audio/${item.audio_path}`} download style={{padding:'4px 8px', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', color:'#ebdbb2', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px', textDecoration:'none'}}>
                          <DownloadIcon size={10}/>
                        </a>
                        <button onClick={() => restoreHistory(item)} style={{padding:'4px 8px', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', color:'#ebdbb2', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', gap:'4px'}}>
                          <FolderOpen size={10}/>
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); deleteHistory(item.id, 'synth'); }} style={{padding:'4px 8px', background:'rgba(251,73,52,0.1)', border:'1px solid rgba(251,73,52,0.2)', color:'#fb4934', borderRadius:'4px', fontSize:'0.7rem', cursor:'pointer', display:'flex', justifyContent:'center', alignItems:'center', flexShrink:0}}>
                          <Trash2 size={10}/>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
            
            {(history.length + dubHistory.length) > 0 && (
              <button onClick={async () => { if (!confirm(`Clear all ${history.length + dubHistory.length} history items? This cannot be undone.`)) return; await fetch(`${API}/history`, {method:'DELETE'}); await fetch(`${API}/dub/history`, {method:'DELETE'}); await loadHistory(); await loadDubHistory(); toast.success('History cleared'); }}
                style={{width:'100%', marginTop:10, padding:5, background:'rgba(251,73,52,0.1)', border:'1px solid rgba(251,73,52,0.3)', borderRadius:6, color:'#fb4934', cursor:'pointer', fontSize:'0.75rem'}}>
                Clear History
              </button>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
}

export default App;
