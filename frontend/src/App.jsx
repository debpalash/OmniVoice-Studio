import React, { useState, useRef, useEffect, useCallback } from 'react';
import './index.css';
import { Toaster, toast } from 'react-hot-toast';
import ALL_LANGUAGES from './languages.json';
import { 
  Sparkles, Fingerprint, Wand2, SlidersHorizontal, UserSquare2, ShieldCheck, 
  Download as DownloadIcon, History, Command, Globe, Volume2, UploadCloud, 
  Settings2, ChevronDown, ChevronUp, Play, Search, Film, Trash2,
  FileText, Loader, Check, AlertCircle, Plus, User, Save, Languages, Headphones
} from 'lucide-react';

const TAGS = [
  '[laughter]', '[sigh]', '[confirmation-en]', '[question-en]', 
  '[question-ah]', '[question-oh]', '[question-ei]', '[question-yi]',
  '[surprise-ah]', '[surprise-oh]', '[surprise-wa]', '[surprise-yo]',
  '[dissatisfaction-hnn]'
];

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
  const [mode, setMode] = useState('design');
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
  const [dubTracks, setDubTracks] = useState([]);
  const [dubTranscript, setDubTranscript] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [previewAudios, setPreviewAudios] = useState({});
  const [dubHistory, setDubHistory] = useState([]);
  const [preserveBg, setPreserveBg] = useState(true);
  const [makeDefaultTrack, setMakeDefaultTrack] = useState(true);

  // ── LOAD DATA FROM SERVER ──
  const [sysStats, setSysStats] = useState(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch(`${API}/sysinfo`);
        if (res.ok) setSysStats(await res.json());
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

  useEffect(() => {
    loadProfiles();
    loadHistory();
    loadDubHistory();
    // Restore local UI state
    try {
      const saved = JSON.parse(localStorage.getItem('omni_ui') || '{}');
      if (saved.text) setText(saved.text);
      if (saved.mode) setMode(saved.mode);
      if (saved.vdStates) setVdStates(saved.vdStates);
      if (saved.language) setLanguage(saved.language);
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
      text, mode, vdStates, language,
      dubJobId, dubFilename, dubDuration, dubSegments, 
      dubLang, dubLangCode, dubTracks, dubStep, dubTranscript
    }));
  }, [text, mode, vdStates, language, dubJobId, dubFilename, dubDuration, dubSegments, dubLang, dubLangCode, dubTracks, dubStep, dubTranscript]);

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
        const parts = Object.values(vdStates).filter(v => v !== 'Auto');
        if (instruct.trim()) parts.push(instruct.trim());
        const finalInstruct = parts.join(', ');
        if (finalInstruct) formData.append("instruct", finalInstruct);
      }

      const response = await fetch(`${API}/generate`, { method: "POST", body: formData });
      if (!response.ok) throw new Error(await response.text());
      // Refresh history from server
      await loadHistory();
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
    if (!confirm("Delete this voice profile?")) return;
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
      const tRes = await fetch(`${API}/dub/transcribe/${data.job_id}`, { method: "POST" });
      if (!tRes.ok) throw new Error(await tRes.text());
      const tData = await tRes.json();
      setDubSegments(tData.segments.map((s, i) => ({ ...s, id: i })));
      setDubTranscript(tData.full_transcript || '');
      setDubStep('editing');
    } catch (err) { setDubError(err.message); setDubStep('idle'); }
  };

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
        segments: dubSegments.map(s => ({
          start: s.start, end: s.end, text: s.text,
          instruct: s.instruct || '', profile_id: s.profile_id || '',
        })),
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
  const handleDubDownload = () => triggerDownload(`${API}/dub/download/${dubJobId}/dubbed_video.mp4?preserve_bg=${preserveBg}&make_default=${makeDefaultTrack}`, 'dubbed_video.mp4');
  const handleDubAudioDownload = () => triggerDownload(`${API}/dub/download-audio/${dubJobId}/dubbed_audio.wav?preserve_bg=${preserveBg}`, 'dubbed_audio.wav');
  const resetDub = () => {
    setDubJobId(null); setDubStep('idle'); setDubSegments([]); setDubFilename('');
    setDubDuration(0); setDubError(''); setDubVideoFile(null); setDubTracks([]);
    setDubProgress({ current: 0, total: 0, text: '' }); setDubTranscript(''); setShowTranscript(false);
    setPreviewAudios({});
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

  const filteredLangs = langSearch ? ALL_LANGUAGES.filter(l => l.toLowerCase().includes(langSearch.toLowerCase())) : ALL_LANGUAGES;
  const filteredDubLangs = dubLangSearch ? ALL_LANGUAGES.filter(l => l.toLowerCase().includes(dubLangSearch.toLowerCase())) : ALL_LANGUAGES;

  return (
    <div className="app-container">
      <Toaster position="top-center" toastOptions={{
        style: { background: 'rgba(40,40,40,0.8)', backdropFilter: 'blur(10px)', color: '#ebdbb2', border: '1px solid rgba(255,255,255,0.1)' },
        error: { iconTheme: { primary: '#fb4934', secondary: '#fff' } },
        success: { iconTheme: { primary: '#b8bb26', secondary: '#fff' } }
      }}/>
      <div className="main-content">
        <div className="header-area" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
            <ShieldCheck color="#d3869b" size={24}/>
            <div>
              <h1>OmniVoice Studio</h1>
              <p>646 languages · Clone · Design · Video Dubbing</p>
            </div>
          </div>
          {sysStats && (
            <div style={{display: 'flex', gap: '16px', fontSize: '0.75rem', color: '#a89984', background: 'rgba(0,0,0,0.3)', padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)'}}>
              <div style={{display: 'flex', flexDirection: 'column'}}>
                <span style={{fontWeight: 600, color: '#ebdbb2'}}>RAM: {sysStats.ram.toFixed(1)} / {sysStats.total_ram.toFixed(1)} GB</span>
                <span>CPU: {sysStats.cpu.toFixed(1)}%</span>
              </div>
              <div style={{display: 'flex', flexDirection: 'column', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '16px'}}>
                <span style={{fontWeight: 600, color: sysStats.gpu_active ? '#8ec07c' : '#ebdbb2'}}>
                  GPU VRAM: {sysStats.vram.toFixed(1)} GB
                </span>
                <span>Status: {sysStats.gpu_active ? <span style={{color: '#8ec07c'}}>Active</span> : 'Idle'}</span>
              </div>
            </div>
          )}
        </div>

        <div className="tabs">
          <button className={`tab ${mode === 'clone' ? 'active' : ''}`} onClick={() => setMode('clone')}><Fingerprint size={14}/> Clone</button>
          <button className={`tab ${mode === 'design' ? 'active' : ''}`} onClick={() => setMode('design')}><Wand2 size={14}/> Design</button>
          <button className={`tab ${mode === 'dub' ? 'active' : ''}`} onClick={() => setMode('dub')}><Film size={14}/> Dub</button>
        </div>

        {/* ═══ DUB TAB ═══ */}
        {mode === 'dub' ? (
          <div>
            {dubStep === 'idle' && (
              <div className="glass-panel">
                <div className="label-row"><Film className="label-icon" size={16}/> Upload Video for Dubbing</div>
                <label htmlFor="video-upload" className="file-drag" style={{minHeight:80}}>
                  <UploadCloud color="#a89984" size={24}/>
                  <p>{dubVideoFile ? <span style={{color:'#ebdbb2'}}>{dubVideoFile.name} ({(dubVideoFile.size/1024/1024).toFixed(1)} MB)</span> : "MP4 / MOV / MKV / WEBM"}</p>
                </label>
                <input type="file" accept="video/*" onChange={e => setDubVideoFile(e.target.files[0])} style={{display:'none'}} id="video-upload"/>
                <button className="btn-primary" onClick={handleDubUpload} disabled={!dubVideoFile}><UploadCloud size={16}/> Upload & Extract Audio</button>
              </div>
            )}

            {(dubStep === 'uploading' || dubStep === 'transcribing') && (
              <div className="glass-panel" style={{textAlign:'center', padding:32}}>
                <Loader className="spinner" size={28} color="#d3869b"/>
                <p style={{marginTop:8, color:'#ebdbb2'}}>{dubStep === 'uploading' ? 'Extracting audio...' : 'Transcribing with Whisper...'}</p>
              </div>
            )}

            {(dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done') && (
              <div>
                <div className="glass-panel">
                  <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
                    <div className="label-row" style={{marginBottom:0}}>
                      <FileText className="label-icon" size={14}/> {dubFilename} ({formatTime(dubDuration)}) — {dubSegments.length} segments
                    </div>
                    <button onClick={resetDub} style={{background:'none', border:'1px solid rgba(251,73,52,0.3)', color:'#fb4934', fontSize:'0.7rem', padding:'2px 8px', borderRadius:4, cursor:'pointer'}}>Reset</button>
                  </div>

                  {/* Full Transcript */}
                  {dubTranscript && (
                    <div style={{marginBottom:8}}>
                      <div className="override-toggle" onClick={() => setShowTranscript(!showTranscript)} style={{marginTop:0}}>
                        <span><FileText size={14} style={{verticalAlign:'middle', marginRight:4}}/> Full Transcript</span>
                        {showTranscript ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
                      </div>
                      {showTranscript && (
                        <div style={{background:'rgba(0,0,0,0.15)', border:'1px solid rgba(255,255,255,0.05)', borderTop:'none', borderRadius:'0 0 8px 8px', padding:10, fontSize:'0.8rem', color:'var(--text-secondary)', lineHeight:1.6, maxHeight:150, overflowY:'auto'}}>
                          {dubTranscript}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid-3" style={{marginBottom:8}}>
                    <div>
                      <div className="label-row"><Globe className="label-icon" size={12}/> Target Language</div>
                      <select className="input-base" value={dubLang} onChange={e => setDubLang(e.target.value)}>
                        {filteredDubLangs.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                    <div>
                      <div className="label-row">ISO Code (YouTube)</div>
                      <select className="input-base" value={dubLangCode} onChange={e => setDubLangCode(e.target.value)}>
                        {LANG_CODES.map(lc => <option key={lc.code} value={lc.code}>{lc.code} — {lc.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <div className="label-row"><UserSquare2 className="label-icon" size={12}/> Voice Style</div>
                      <input className="input-base" placeholder="e.g. female, young adult" value={dubInstruct} onChange={e => setDubInstruct(e.target.value)}/>
                    </div>
                  </div>

                  {/* Translate All button */}
                  <div style={{display:'flex', gap:8, marginBottom:8}}>
                    <button onClick={handleTranslateAll} disabled={isTranslating || !dubSegments.length}
                      style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'6px 12px', background:'rgba(131,165,152,0.15)', border:'1px solid rgba(131,165,152,0.3)', color:'#83a598', borderRadius:6, cursor:'pointer', fontSize:'0.8rem', fontWeight:500}}>
                      {isTranslating ? <Loader className="spinner" size={12}/> : <Languages size={14}/>}
                      {isTranslating ? 'Translating...' : `Translate All → ${LANG_CODES.find(l=>l.code===dubLangCode)?.label || dubLangCode}`}
                    </button>
                  </div>

                  <div className="segment-table">
                    <div className="segment-header">
                      <span style={{width:70}}>Time</span>
                      <span style={{flex:1}}>Text</span>
                      <span style={{width:120}}>Voice</span>
                      <span style={{width:60}}></span>
                    </div>
                    {dubSegments.map((seg, idx) => (
                      <div key={seg.id} className={`segment-row ${dubStep === 'generating' && dubProgress.current === idx + 1 ? 'segment-active' : ''} ${dubStep === 'generating' && dubProgress.current > idx + 1 ? 'segment-done' : ''}`}>
                        <span className="segment-time">{formatTime(seg.start)}–{formatTime(seg.end)}</span>
                        <input className="input-base segment-input" value={seg.text}
                          onChange={e => setDubSegments(dubSegments.map(s => s.id===seg.id ? {...s, text:e.target.value} : s))}
                          disabled={dubStep === 'generating'}/>
                        <select className="input-base" style={{width:120, fontSize:'0.7rem', padding:'2px 4px'}}
                          value={seg.profile_id || ''}
                          onChange={e => setDubSegments(dubSegments.map(s => s.id===seg.id ? {...s, profile_id:e.target.value} : s))}
                          disabled={dubStep === 'generating'}>
                          <option value="">Default</option>
                          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <div style={{display:'flex', gap:2, width:60}}>
                          {dubStep === 'done' && (
                            <button className="segment-play" title="Preview" onClick={() => {
                              const audio = new Audio(`${API}/dub/preview/${dubJobId}/${idx}`);
                              audio.play();
                              setPreviewAudios({...previewAudios, [idx]: audio});
                            }}><Headphones size={11}/></button>
                          )}
                          <button className="segment-del" onClick={() => setDubSegments(dubSegments.filter(s => s.id !== seg.id))} disabled={dubStep === 'generating'}><Trash2 size={11}/></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="glass-panel">
                  {dubStep === 'generating' && (
                    <div style={{marginBottom:10}}>
                      <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.8rem', marginBottom:4}}>
                        <span><Sparkles className="spinner" size={12} style={{verticalAlign:'middle', marginRight:4}}/> Dubbing {dubProgress.current}/{dubProgress.total}</span>
                        <span className="history-time">{dubProgress.text}</span>
                      </div>
                      <div className="progress-container"><div className="progress-fill" style={{width: `${dubProgress.total ? (dubProgress.current / dubProgress.total) * 100 : 0}%`}}></div></div>
                    </div>
                  )}
                  {dubStep === 'done' && (
                    <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:10, padding:6, background:'rgba(142,192,124,0.1)', border:'1px solid rgba(142,192,124,0.3)', borderRadius:6}}>
                      <Check size={14} color="#8ec07c"/>
                      <span style={{color:'#8ec07c', fontSize:'0.8rem'}}>Done! Tracks: {dubTracks.join(', ')}</span>
                    </div>
                  )}
                  {dubError && (
                    <div style={{marginBottom:10, padding:6, background:'rgba(251,73,52,0.1)', border:'1px solid rgba(251,73,52,0.3)', borderRadius:6}}>
                      <span style={{color:'#fb4934', fontSize:'0.7rem'}}>{dubError}</span>
                    </div>
                  )}
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:6}}>
                    <button className="btn-primary" onClick={handleDubGenerate} disabled={dubStep==='generating'||!dubSegments.length} style={{marginTop:0}}>
                      {dubStep==='generating' ? <Sparkles className="spinner" size={14}/> : <Play size={14}/>}
                      {dubStep==='generating' ? 'Dubbing...' : 'Generate Dub Track'}
                    </button>
                    <button className="btn-primary" onClick={handleDubDownload} disabled={dubStep!=='done'}
                      style={{marginTop:0, background: dubStep==='done' ? 'linear-gradient(135deg,#8ec07c,#689d6a)' : undefined}}>
                      <DownloadIcon size={14}/> YouTube-Ready MP4
                    </button>
                    <button className="btn-primary" onClick={handleDubAudioDownload}
                      disabled={dubStep!=='done'}
                      style={{marginTop:0, background: dubStep==='done' ? 'linear-gradient(135deg,#83a598,#458588)' : undefined}}>
                      <Volume2 size={14}/> Audio Only (WAV)
                    </button>
                    <button className="btn-primary" onClick={() => triggerDownload(`${API}/dub/srt/${dubJobId}/subtitles.srt`, 'subtitles.srt')}
                      disabled={!dubSegments.length}
                      style={{marginTop:0, background: dubSegments.length ? 'linear-gradient(135deg,#d3869b,#b16286)' : undefined}}>
                      <FileText size={14}/> SRT Subtitles
                    </button>
                  </div>
                  {dubStep === 'done' && (
                    <div style={{marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center'}}>
                      <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                        <input type="checkbox" id="preserveBgCheck" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} style={{cursor: 'pointer'}} />
                        <label htmlFor="preserveBgCheck" style={{fontSize: '0.8rem', color: '#a89984', cursor: 'pointer'}}>Mix with Original Background Audio</label>
                      </div>
                      <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                        <input type="checkbox" id="defaultTrackCheck" checked={makeDefaultTrack} onChange={e => setMakeDefaultTrack(e.target.checked)} style={{cursor: 'pointer'}} />
                        <label htmlFor="defaultTrackCheck" style={{fontSize: '0.8rem', color: '#a89984', cursor: 'pointer'}}>Make Dubbed Audio the Default Track</label>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* ═══ CLONE / DESIGN ═══ */}
            <div className="glass-panel">
              <div className="label-row"><Command className="label-icon" size={14}/> Prompt</div>
              {mode === 'design' && (
                <div className="preset-grid">
                  {PRESETS.map(p => <button key={p.id} className="preset-btn" onClick={() => applyPreset(p)}>{p.name}</button>)}
                </div>
              )}
              <textarea ref={textAreaRef} className="input-base" rows={4}
                placeholder="Type script here..." value={text} onChange={e => setText(e.target.value)}/>
              <div className="tags-container">
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

            <div className="glass-panel">
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
                      <label htmlFor="audio-upload" className="file-drag">
                        <UploadCloud color="#a89984" size={18}/>
                        <p>{refAudio ? <span style={{color:'#ebdbb2'}}>{refAudio.name}</span> : "Select WAV / MP3"}</p>
                      </label>
                      <input type="file" accept="audio/*" onChange={e => { setRefAudio(e.target.files[0]); setSelectedProfile(null); }} style={{display:'none'}} id="audio-upload" />
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
          </>
        )}
      </div>

      {/* ── SIDEBAR ── */}
      <div className="glass-panel history-panel">
        <div className="label-row" style={{marginBottom:10}}><History size={14} color="#fb4934"/> <span style={{fontWeight:600}}>Activity ({history.length + dubHistory.length})</span></div>
        <div style={{fontSize:'0.7rem', color:'var(--text-secondary)', marginBottom:8}}>Stored in SQLite · Local disk</div>
        
        {(history.length + dubHistory.length) === 0 ? (
          <p style={{color:'var(--text-secondary)', fontSize:'0.8rem', textAlign:'center'}}>Outputs appear here.</p>
        ) : (
          <>
            {/* Dub history */}
            {dubHistory.map(item => (
              <div key={`dub-${item.id}`} className="history-item clickable-history" onClick={() => restoreDubHistory(item)}>
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
                {item.tracks && (
                  <div style={{fontSize:'0.65rem', color:'#d3869b'}}>Tracks: {JSON.parse(item.tracks || '[]').join(', ')}</div>
                )}
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
                <div className="history-text" title={item.text}>{item.text}</div>
                {item.audio_path && <audio controls src={`${API}/audio/${item.audio_path}`} />}
                {item.audio_path && (
                  <a href={`${API}/audio/${item.audio_path}`} download style={{marginTop:4, display:'inline-flex', alignItems:'center', gap:4, color:'#d3869b', textDecoration:'none', fontSize:'0.8rem'}}>
                    <DownloadIcon size={12}/> Export
                  </a>
                )}
              </div>
            ))}
          </>
        )}
        
        {(history.length + dubHistory.length) > 0 && (
          <button onClick={async () => { if (confirm("Clear all history?")) { await fetch(`${API}/history`, {method:'DELETE'}); await fetch(`${API}/dub/history`, {method:'DELETE'}); await loadHistory(); await loadDubHistory(); }}}
            style={{width:'100%', marginTop:10, padding:5, background:'rgba(251,73,52,0.1)', border:'1px solid rgba(251,73,52,0.3)', borderRadius:6, color:'#fb4934', cursor:'pointer', fontSize:'0.75rem'}}>
            Clear History
          </button>
        )}
      </div>
    </div>
  );
}

export default App;
