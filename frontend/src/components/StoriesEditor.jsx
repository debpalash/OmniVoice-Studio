/**
 * StoriesEditor — multi-track audiobook / story studio (Phase 1).
 *
 * Line-card model: each line has a character (from the Cast), an optional
 * per-line voice override, and editable text with [pause]/[voice:] markers.
 * A Cast panel maps each character → a voice once; lines inherit it. "Generate"
 * stitches every line (+ pauses) into a single downloadable audiobook WAV.
 * State persists via the zustand storiesSlice (localStorage).
 *
 * Spec: docs/superpowers/specs/2026-05-30-stories-editor-studio-design.md
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Plus, Play, Trash2, GripVertical, BookOpen, Mic, Download, Scissors, Pause as PauseIcon, Users, X, Upload, Sparkles, SlidersHorizontal, Folder, Layers, Bookmark, FileText, Drama, Timer, ChartColumn, Hourglass, Laugh, Wind, CircleQuestionMark, Zap, CircleCheck, Annoyed } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Button, Menu } from '../ui';
import { useAppStore } from '../store';
import { parseStoryText, hasStoryMarkers, applyInlineVoice, insertToken } from '../utils/storyTokens';
import { parseScript } from '../utils/parseScript';
import { importToText } from '../utils/importStory';
import { generateSpeech, audioUrl } from '../api/generate';
import { encodeAudio } from '../api/stories';
import { longformRender } from '../api/audiobook';
import { exportStems } from '../utils/storyExport';
import { storyToSpans } from '../utils/storyToSpans';
import { splitSSEBuffer, parseSSELine } from '../utils/sseParse';
import { reorder } from '../utils/storyReorder';
import { effectiveProfile, castMember, nextCastColor } from '../utils/storyCast';
import './StoriesEditor.css';

// Trigger a browser download for a Blob.
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Trigger a browser download for a same-origin URL (server-rendered file).
function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// A chapter line is any track whose text is a markdown heading (`# …`). It
// renders as a section bar (no voice/tune/preview), and storyExport keys its
// chapter cues off the same prefix — keep the two in sync.
// Lenient on purpose: a heading with an empty title is still `# ` (or `#`), and
// it must stay a chapter while the user edits the title — otherwise clearing the
// text would flip the bar back into a voiced line card mid-edit.
const isChapterText = (s) => /^\s*#{1,6}(\s|$)/.test(s || '');

// Sentence-aware splitter for the "Paste & auto-split" panel. Walks the text
// and breaks at the closest sentence boundary that keeps each chunk under
// `maxChars`. Falls back to whitespace, then to the hard cap.
function splitIntoChunks(text, maxChars) {
  const out = [];
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return out;
  const max = Math.max(40, Math.min(2000, maxChars | 0));
  let i = 0;
  while (i < clean.length) {
    const remain = clean.length - i;
    if (remain <= max) { out.push(clean.slice(i).trim()); break; }
    const window = clean.slice(i, i + max);
    let cut = -1;
    for (let j = window.length - 1; j > Math.floor(max * 0.4); j--) {
      if (/[.!?。！？]/.test(window[j])) { cut = j + 1; break; }
    }
    if (cut < 0) {
      for (let j = window.length - 1; j > Math.floor(max * 0.4); j--) {
        if (/\s/.test(window[j])) { cut = j; break; }
      }
    }
    if (cut < 0) cut = max;
    out.push(clean.slice(i, i + cut).trim());
    i += cut;
  }
  return out.filter(Boolean);
}

let _trackId = 0;
function makeTrack(character = 'narrator', text = '') {
  return { id: ++_trackId, character, text, profileId: null, emotion: null, speed: null, generating: false, audioUrl: null };
}

function genCastId() {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `c_${rnd}`;
}

// Curated inline emotion/sound tags (a subset of utils/constants TAGS) for the
// per-line tone drawer. Inserting a tag is the model-native way to direct tone.
const STORY_TONES = [
  { tag: '[laughter]', icon: Laugh, key: 'laugh' },
  { tag: '[sigh]', icon: Wind, key: 'sigh' },
  { tag: '[question-en]', icon: CircleQuestionMark, key: 'question' },
  { tag: '[surprise-wa]', icon: Zap, key: 'surprise' },
  { tag: '[confirmation-en]', icon: CircleCheck, key: 'confirm' },
  { tag: '[dissatisfaction-hnn]', icon: Annoyed, key: 'dissatisfaction' },
];

export default function StoriesEditor({ profiles = [] }) {
  const { t } = useTranslation();

  // ── Persisted project state (zustand) ──────────────────────────────────
  const tracks = useAppStore((s) => s.storyTracks);
  const setStoryTracks = useAppStore((s) => s.setStoryTracks);
  const cast = useAppStore((s) => s.cast);
  const setCast = useAppStore((s) => s.setCast);
  const upsertCastMember = useAppStore((s) => s.upsertCastMember);
  const removeCastMember = useAppStore((s) => s.removeCastMember);
  const setCharacterVoice = useAppStore((s) => s.setCharacterVoice);
  const storyProjects = useAppStore((s) => s.storyProjects);
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const saveProject = useAppStore((s) => s.saveProject);
  const loadProject = useAppStore((s) => s.loadProject);
  const newProject = useAppStore((s) => s.newProject);
  const deleteProject = useAppStore((s) => s.deleteProject);

  // Proxy so existing `setTracks(prev => …)` call shapes keep working.
  const setTracks = useCallback((updater) => {
    const cur = useAppStore.getState().storyTracks;
    setStoryTracks(typeof updater === 'function' ? updater(cur) : updater);
  }, [setStoryTracks]);

  // Reseed the id counter from persisted tracks so new lines never collide.
  useEffect(() => {
    const maxId = tracks.reduce((m, tk) => Math.max(m, tk.id || 0), 0);
    if (maxId > _trackId) _trackId = maxId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [activeTrack, setActiveTrack] = useState(null);
  const [castOpen, setCastOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitText, setSplitText] = useState('');
  const [splitMax, setSplitMax] = useState(180);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [expandedLine, setExpandedLine] = useState(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [exportFormat, setExportFormat] = useState('m4b');
  const trackTextRefs = useRef(new Map());
  const fileInputRef = useRef(null);
  const dragId = useRef(null);
  const [dragOver, setDragOver] = useState(null);

  // ── Cast ────────────────────────────────────────────────────────────────
  const addCharacter = useCallback(() => {
    const n = cast.length;
    upsertCastMember({ id: genCastId(), name: `${t('stories.character')} ${n}`, color: nextCastColor(cast), profileId: null });
    setCastOpen(true);
  }, [cast, upsertCastMember, t]);

  const deleteCharacter = useCallback((id) => {
    if (id === 'narrator') return; // keep at least the narrator
    // Reassign any lines using this character back to the narrator.
    setTracks((prev) => prev.map((tk) => (tk.character === id ? { ...tk, character: 'narrator' } : tk)));
    removeCastMember(id);
  }, [removeCastMember, setTracks]);

  // ── Auto-cast: detect speakers in pasted/imported text, build cast + lines ─
  const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'char';

  const autoCast = useCallback(() => {
    const parsed = parseScript(splitText);
    if (!parsed.length) { toast.error(t('stories.autocastEmpty')); return; }
    const speakers = [...new Set(parsed.map((p) => p.speaker))];
    const newCast = cast.map((c) => ({ ...c }));
    const idFor = {};
    let voiceIdx = 0;
    const assignVoice = () => (profiles.length ? profiles[voiceIdx++ % profiles.length].id : null);
    for (const sp of speakers) {
      const id = sp.toLowerCase() === 'narrator' ? 'narrator' : slug(sp);
      idFor[sp] = id;
      const existing = newCast.find((c) => c.id === id);
      if (!existing) {
        newCast.push({ id, name: sp, color: nextCastColor(newCast), profileId: assignVoice() });
      } else if (!existing.profileId && profiles.length) {
        existing.profileId = assignVoice();
      }
    }
    setCast(newCast);
    const newTracks = parsed.map((p) => makeTrack(idFor[p.speaker], p.text));
    setTracks((prev) => [...prev, ...newTracks]);
    setSplitText('');
    setSplitOpen(false);
    setCastOpen(true);
    toast.success(t('stories.autocastDone', { lines: newTracks.length, voices: speakers.length }));
  }, [splitText, cast, profiles, setCast, setTracks, t]);

  const onImportFile = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = importToText(file.name, await file.text());
      setSplitText(text);
      setSplitOpen(true);
    } catch (err) {
      console.warn('Story import failed:', err);
      toast.error(t('stories.importFailed'));
    }
  }, [t]);

  // ── Named projects ──────────────────────────────────────────────────────
  const currentProject = storyProjects.find((p) => p.id === currentProjectId) || null;
  useEffect(() => {
    setProjectName(currentProject ? currentProject.name : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  const saveCurrent = useCallback(() => {
    saveProject(projectName.trim() || t('stories.untitled'));
    toast.success(t('stories.projectSaved'));
  }, [projectName, saveProject, t]);
  const newStory = useCallback(() => { newProject(); setProjectName(''); }, [newProject]);
  const openProject = useCallback((id) => { loadProject(id); setProjectsOpen(false); }, [loadProject]);

  const addChapter = useCallback(() => {
    const n = tracks.filter((tk) => isChapterText(tk.text)).length + 1;
    setTracks((prev) => [...prev, makeTrack('narrator', `# ${t('stories.chapterN', { n })}`)]);
  }, [tracks, setTracks, t]);

  // ── Paste & auto-split ───────────────────────────────────────────────────
  const applySplit = useCallback(() => {
    const chunks = splitIntoChunks(splitText, splitMax);
    if (!chunks.length) return;
    setTracks((prev) => [...prev, ...chunks.map((tx) => makeTrack('narrator', tx))]);
    setSplitText('');
    setSplitOpen(false);
  }, [splitText, splitMax, setTracks]);

  const setVoiceForSelection = useCallback((trackId, voiceId) => {
    const el = trackTextRefs.current.get(trackId);
    const start = el?.selectionStart;
    const end = el?.selectionEnd;
    setTracks((prev) => prev.map((tk) => {
      if (tk.id !== trackId) return tk;
      const safeStart = start != null ? start : tk.text.length;
      const safeEnd = end != null ? end : safeStart;
      return { ...tk, text: applyInlineVoice(tk.text, safeStart, safeEnd, voiceId) };
    }));
  }, [setTracks]);

  const insertTokenInto = useCallback((trackId, token) => {
    const el = trackTextRefs.current.get(trackId);
    const caret = el ? el.selectionStart : null;
    setTracks((prev) => prev.map((tk) => (tk.id === trackId ? { ...tk, text: insertToken(tk.text, caret, token) } : tk)));
  }, [setTracks]);
  const insertPauseInto = useCallback((trackId) => insertTokenInto(trackId, '[pause 0.5s]'), [insertTokenInto]);

  const addTrack = useCallback(() => setTracks((prev) => [...prev, makeTrack()]), [setTracks]);
  const removeTrack = useCallback((id) => setTracks((prev) => prev.filter((tk) => {
    if (tk.id === id && tk.audioUrl) URL.revokeObjectURL(tk.audioUrl);  // free the preview blob
    return tk.id !== id;
  })), [setTracks]);
  const updateTrack = useCallback((id, field, value) => {
    setTracks((prev) => prev.map((tk) => (tk.id === id ? { ...tk, [field]: value } : tk)));
  }, [setTracks]);

  // ── Synthesis (preview + export share one fetch) ─────────────────────────
  const fetchChunkBlob = useCallback(async (text, profileId, speed = 1.0) => {
    const fd = new FormData();
    fd.append('text', text);
    fd.append('speed', String(speed || 1.0));
    if (profileId) fd.append('profile_id', profileId);
    const res = await generateSpeech(fd); // apiFetch: same-origin + PIN-aware
    return res.blob();
  }, []);

  const fetchChunkAudio = useCallback(async (text, profileId, speed = 1.0) => {
    const blob = await fetchChunkBlob(text, profileId, speed);
    return URL.createObjectURL(blob);
  }, [fetchChunkBlob]);

  const previewTrack = useCallback(async (track) => {
    const raw = (track.text || '').trim();
    if (!raw) return;
    const pid = effectiveProfile(track, cast);
    const spd = track.speed || 1.0;
    setTracks((prev) => prev.map((tk) => (tk.id === track.id ? { ...tk, generating: true } : tk)));

    if (!hasStoryMarkers(raw)) {
      try {
        const url = await fetchChunkAudio(raw, pid, spd);
        setTracks((prev) => prev.map((tk) => (tk.id === track.id ? { ...tk, audioUrl: url, generating: false } : tk)));
        const audio = new Audio(url);
        audio.play().catch(() => {});
      } catch (err) {
        console.warn('Stories preview failed:', err);
        setTracks((prev) => prev.map((tk) => (tk.id === track.id ? { ...tk, generating: false } : tk)));
      }
      return;
    }

    const parsed = parseStoryText(raw, pid);
    try {
      const audioUrls = await Promise.all(
        parsed.map((seg) => (seg.type === 'chunk' ? fetchChunkAudio(seg.text, seg.profileId, spd) : Promise.resolve(null))),
      );
      let cursor = 0;
      const finish = () => {
        for (let i = cursor; i < audioUrls.length; i++) if (audioUrls[i]) URL.revokeObjectURL(audioUrls[i]);
        setTracks((prev) => prev.map((tk) => (tk.id === track.id ? { ...tk, generating: false, audioUrl: null } : tk)));
      };
      const step = () => {
        while (cursor < parsed.length) {
          const seg = parsed[cursor];
          const url = audioUrls[cursor];
          cursor++;
          if (seg.type === 'pause') { setTimeout(step, seg.seconds * 1000); return; }
          if (seg.type === 'chunk' && url) {
            const audio = new Audio(url);
            audio.onended = () => { URL.revokeObjectURL(url); step(); };
            audio.onerror = () => { URL.revokeObjectURL(url); step(); };
            audio.play().catch(() => { URL.revokeObjectURL(url); step(); });
            return;
          }
        }
        finish();
      };
      step();
    } catch (err) {
      console.warn('Stories chained preview failed:', err);
      setTracks((prev) => prev.map((tk) => (tk.id === track.id ? { ...tk, generating: false } : tk)));
    }
  }, [fetchChunkAudio, cast, setTracks]);

  // Deliver a stitched WAV in the chosen format. MP3 routes through the backend
  // ffmpeg endpoint; if that fails (e.g. no ffmpeg), fall back to the raw WAV.
  const deliver = useCallback(async (wavBlob, baseName) => {
    if (exportFormat === 'mp3') {
      try {
        download(await encodeAudio(wavBlob, 'mp3'), `${baseName}.mp3`);
        return;
      } catch (err) {
        console.warn('MP3 encode failed; falling back to WAV:', err);
        toast(t('stories.mp3Fallback'), { icon: '⚠️' });
      }
    }
    download(wavBlob, `${baseName}.wav`);
  }, [exportFormat, t]);

  // Full export now runs on the shared server-side renderer (the Stories +
  // Audiobook convergence): cast + lines compile to a chapter/span plan and
  // stream through /longform/render — gaining chapter markers, resume, and
  // (via the audiobook controls) loudness/metadata. Single-line preview stays
  // client-side for latency. Stems remain a client export below.
  const generateAll = useCallback(async () => {
    const usable = tracks.filter((tk) => (tk.text || '').trim());
    if (!usable.length || exporting) return;
    const chapters = storyToSpans(usable, cast);
    if (!chapters.length) { toast.error(t('stories.exportFailed')); return; }
    setExporting(true);
    setExportPct(0);
    try {
      const res = await longformRender({
        chapters,
        format: exportFormat === 'mp3' ? 'mp3' : 'm4b',
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let total = 0;
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { lines, rest } = splitSSEBuffer(buffer);
        buffer = rest;
        for (const line of lines) {
          const evt = parseSSELine(line);
          if (!evt) continue;
          if (evt.type === 'started') total = evt.chapters;
          else if (evt.type === 'chapter' || evt.type === 'chapter_error') {
            setExportPct(total ? Math.round(((evt.index + 1) / total) * 100) : 0);
          } else if (evt.type === 'done') output = evt.output;
          else if (evt.type === 'error') throw new Error(evt.error || 'render failed');
        }
      }
      if (!output) throw new Error('no output produced');
      downloadUrl(audioUrl(output), output.split('/').pop());
      toast.success(t('stories.exportDone'));
    } catch (err) {
      console.warn('Story render failed:', err);
      toast.error(t('stories.exportFailed'));
    } finally {
      setExporting(false);
    }
  }, [tracks, cast, exporting, exportFormat, t]);

  const exportStemsAll = useCallback(async () => {
    const usable = tracks.filter((tk) => (tk.text || '').trim());
    if (!usable.length || exporting) return;
    setExporting(true);
    setExportPct(0);
    try {
      const stems = await exportStems(
        usable,
        (tk) => ({ profileId: effectiveProfile(tk, cast), speed: tk.speed || 1.0 }),
        fetchChunkBlob,
        (d, total) => setExportPct(total ? Math.round((d / total) * 100) : 0),
      );
      for (const s of stems) {
        const name = ((castMember(cast, s.character) || {}).name || s.character).replace(/[^\w-]+/g, '_');
        await deliver(s.blob, `story-${name}`);
      }
      toast.success(t('stories.stemsDone', { count: stems.length }));
    } catch (err) {
      console.warn('Stems export failed:', err);
      toast.error(t('stories.exportFailed'));
    } finally {
      setExporting(false);
    }
  }, [tracks, cast, fetchChunkBlob, exporting, deliver, t]);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const totalChars = tracks.reduce((acc, tk) => acc + tk.text.length, 0);
  const usedCharacters = new Set(tracks.map((tk) => tk.character)).size;
  const estMinutes = Math.ceil(totalChars / 800);

  const profileName = (id) => (profiles.find((p) => p.id === id) || {}).name;

  return (
    <div className="stories-editor" role="region" aria-label="Stories editor">
      {/* Header / toolbar */}
      <div className="stories-editor__header">
        <div>
          <h2 className="stories-editor__title"><BookOpen size={18} /> {t('stories.title')}</h2>
          <p className="stories-editor__subtitle">{t('stories.subtitle')}</p>
        </div>
        <div className="stories-editor__actions">
          <input ref={fileInputRef} type="file" accept=".txt,.srt,text/plain" onChange={onImportFile} hidden />

          {/* Project */}
          <div className="stories-editor__group">
            <Button size="sm" variant="ghost" onClick={() => setProjectsOpen((v) => !v)} aria-label={t('stories.projects')}>
              <Folder size={13} /> {currentProject ? currentProject.name : t('stories.projects')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCastOpen((v) => !v)} aria-label={t('stories.cast')}>
              <Users size={13} /> {t('stories.cast')}
            </Button>
          </div>

          <span className="stories-editor__divider" aria-hidden="true" />

          {/* Content */}
          <div className="stories-editor__group">
            <Button size="sm" variant="ghost" onClick={() => fileInputRef.current && fileInputRef.current.click()} aria-label={t('stories.import')}>
              <Upload size={13} /> {t('stories.import')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSplitOpen((v) => !v)} aria-label={t('stories.pasteSplit')}>
              <Scissors size={13} /> {t('stories.pasteSplit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={addTrack} aria-label={t('stories.addLine')}>
              <Plus size={13} /> {t('stories.addLine')}
            </Button>
            <Button size="sm" variant="ghost" onClick={addChapter} aria-label={t('stories.addChapter')}>
              <Bookmark size={13} /> {t('stories.addChapter')}
            </Button>
          </div>

          <span className="stories-editor__divider" aria-hidden="true" />

          {/* Output */}
          <div className="stories-editor__group">
            <Button size="sm" variant="ghost" onClick={exportStemsAll} disabled={tracks.length === 0 || exporting} aria-label={t('stories.stems')}>
              <Layers size={13} /> {t('stories.stems')}
            </Button>
            <select
              className="input-base stories-editor__format"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value)}
              aria-label={t('stories.format')}
              title={t('stories.format')}
            >
              <option value="m4b">M4B</option>
              <option value="mp3">MP3</option>
            </select>
            <Button size="sm" onClick={generateAll} disabled={tracks.length === 0 || exporting}>
              <Download size={13} /> {exporting ? `${exportPct}%` : t('stories.generateAll')}
            </Button>
          </div>
        </div>
      </div>

      {/* Projects panel */}
      {projectsOpen && (
        <div className="stories-cast" role="region" aria-label={t('stories.projects')}>
          <div className="stories-cast__head">
            <span className="stories-editor__panel-title">{t('stories.projects')}</span>
            <button type="button" className="stories-cast__add" onClick={newStory}>
              <Plus size={12} /> {t('stories.newStory')}
            </button>
          </div>
          <div className="stories-cast__row">
            <input
              className="stories-cast__name stories-proj__name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t('stories.untitled')}
              aria-label={t('stories.projectName')}
            />
            <Button size="sm" onClick={saveCurrent}>{t('stories.save')}</Button>
          </div>
          {storyProjects.map((p) => (
            <div key={p.id} className={`stories-cast__row ${p.id === currentProjectId ? 'stories-proj--current' : ''}`}>
              <button type="button" className="stories-proj__open" onClick={() => openProject(p.id)}>
                <Folder size={12} /> {p.name}
              </button>
              <button type="button" className="stories-cast__del" onClick={() => deleteProject(p.id)} aria-label={t('stories.deleteProject')}>
                <X size={12} />
              </button>
            </div>
          ))}
          {storyProjects.length === 0 && <p className="stories-editor__hint">{t('stories.noProjects')}</p>}
        </div>
      )}

      {/* Cast panel */}
      {castOpen && (
        <div className="stories-cast" role="region" aria-label={t('stories.castTitle')}>
          <div className="stories-cast__head">
            <span className="stories-editor__panel-title">{t('stories.castTitle')}</span>
            <button type="button" className="stories-cast__add" onClick={addCharacter}>
              <Plus size={12} /> {t('stories.addCharacter')}
            </button>
          </div>
          {cast.map((c) => (
            <div key={c.id} className="stories-cast__row">
              <span className="stories-cast__dot" style={{ background: c.color }} />
              <input
                className="stories-cast__name"
                value={c.name}
                onChange={(e) => upsertCastMember({ ...c, name: e.target.value })}
                aria-label={t('stories.characterName')}
              />
              <select
                className="stories-cast__select"
                value={c.profileId || ''}
                onChange={(e) => setCharacterVoice(c.id, e.target.value || null)}
                aria-label={`${c.name} ${t('stories.voice')}`}
              >
                <option value="">{t('stories.defaultVoice')}</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button
                type="button"
                className="stories-cast__del"
                onClick={() => deleteCharacter(c.id)}
                disabled={c.id === 'narrator'}
                title={c.id === 'narrator' ? t('stories.narratorLocked') : t('stories.removeCharacter')}
                aria-label={t('stories.removeCharacter')}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {profiles.length === 0 && <p className="stories-editor__hint">{t('stories.noProfiles')}</p>}
        </div>
      )}

      {/* Paste & split */}
      {splitOpen && (
        <div className="stories-editor__split-panel" role="region" aria-label={t('stories.pasteSplit')}>
          <textarea
            className="stories-editor__split-text"
            placeholder={t('stories.splitPlaceholder')}
            value={splitText}
            onChange={(e) => setSplitText(e.target.value)}
            rows={6}
            aria-label={t('stories.splitPlaceholder')}
          />
          <div className="stories-editor__split-controls">
            <label className="stories-editor__split-label">
              {t('stories.maxChars')}
              <input
                type="number" min={60} max={1000} step={10} value={splitMax}
                onChange={(e) => setSplitMax(parseInt(e.target.value, 10) || 180)}
                className="stories-editor__split-num"
              />
            </label>
            <span className="stories-editor__split-hint">
              {splitText
                ? t('stories.segmentsHint', { count: splitIntoChunks(splitText, splitMax).length, max: splitMax })
                : t('stories.pasteAbove')}
            </span>
            <Button size="sm" variant="ghost" onClick={() => { setSplitText(''); setSplitOpen(false); }}>{t('stories.cancel')}</Button>
            <Button size="sm" variant="ghost" onClick={applySplit} disabled={!splitText.trim()}>
              <Scissors size={13} /> {t('stories.splitIntoTracks')}
            </Button>
            <Button size="sm" onClick={autoCast} disabled={!splitText.trim()} title={t('stories.autocastHint')}>
              <Sparkles size={13} /> {t('stories.autocast')}
            </Button>
          </div>
        </div>
      )}

      {/* Tracks */}
      {tracks.length === 0 ? (
        <div className="stories-editor__empty">
          <BookOpen size={32} className="stories-editor__empty-icon" aria-hidden="true" />
          <p className="stories-editor__empty-text">{t('stories.emptyText')}</p>
          <Button size="sm" onClick={addTrack}><Plus size={13} /> {t('stories.addFirst')}</Button>
        </div>
      ) : (
        <div className="stories-editor__tracks" role="list">
          {tracks.map((track) => {
            const dragProps = {
              draggable: true,
              onDragStart: (e) => { dragId.current = track.id; e.dataTransfer.effectAllowed = 'move'; },
              onDragOver: (e) => { e.preventDefault(); if (dragOver !== track.id) setDragOver(track.id); },
              onDragLeave: () => setDragOver((d) => (d === track.id ? null : d)),
              onDrop: (e) => {
                e.preventDefault();
                if (dragId.current != null && dragId.current !== track.id) {
                  setTracks((prev) => reorder(prev, dragId.current, track.id));
                }
                dragId.current = null;
                setDragOver(null);
              },
            };

            // Chapters render as a section bar — no voice / tune / preview.
            if (isChapterText(track.text)) {
              const title = track.text.replace(/^#{1,6}\s*/, '');
              return (
                <div
                  key={track.id}
                  role="listitem"
                  className={['stories-chapter', dragOver === track.id ? 'stories-chapter--dragover' : ''].filter(Boolean).join(' ')}
                  {...dragProps}
                >
                  <div className="stories-chapter__grip" aria-hidden="true"><GripVertical size={14} /></div>
                  <Bookmark size={15} className="stories-chapter__icon" aria-hidden="true" />
                  <input
                    className="stories-chapter__title"
                    value={title}
                    onChange={(e) => updateTrack(track.id, 'text', `# ${e.target.value}`)}
                    placeholder={t('stories.addChapter')}
                    aria-label={t('stories.addChapter')}
                  />
                  <button
                    type="button"
                    className="stories-chapter__del"
                    onClick={(e) => { e.stopPropagation(); removeTrack(track.id); }}
                    title={t('stories.removeLine')}
                    aria-label={t('stories.removeLine')}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            }

            const member = castMember(cast, track.character);
            const inheritedId = member && member.profileId;
            const inheritedName = inheritedId ? profileName(inheritedId) : null;
            return (
              <div
                key={track.id}
                role="listitem"
                className={[
                  'stories-track',
                  activeTrack === track.id ? 'stories-track--active' : '',
                  track.character === 'narrator' ? 'stories-track--narrator' : '',
                  dragOver === track.id ? 'stories-track--dragover' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setActiveTrack(track.id)}
                {...dragProps}
              >
                <div className="stories-track__grip" aria-hidden="true"><GripVertical size={14} /></div>

                <textarea
                  className="stories-track__text"
                  ref={(el) => { if (el) trackTextRefs.current.set(track.id, el); else trackTextRefs.current.delete(track.id); }}
                  value={track.text}
                  onChange={(e) => updateTrack(track.id, 'text', e.target.value)}
                  placeholder={t('stories.linePlaceholder')}
                  rows={1}
                  aria-label={`${member ? member.name : ''} ${t('stories.text')}`}
                />

                <div className="stories-track__voice">
                  <span className="stories-track__voice-dot" style={{ background: member ? member.color : '#a89984' }} />
                  <select
                    className="stories-track__voice-select"
                    value={track.character}
                    onChange={(e) => updateTrack(track.id, 'character', e.target.value)}
                    aria-label={t('stories.character')}
                  >
                    {cast.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>

                <select
                  className="stories-track__character"
                  value={track.profileId || ''}
                  onChange={(e) => updateTrack(track.id, 'profileId', e.target.value || null)}
                  aria-label={t('stories.voice')}
                >
                  <option value="">{inheritedName ? `↳ ${inheritedName}` : t('stories.defaultVoice')}</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>

                <div className="stories-track__actions">
                  <Menu
                    placement="bottom-end"
                    items={[
                      ...(profiles.length === 0
                        ? [{ id: 'noprof', label: t('stories.noProfiles'), disabled: true }]
                        : profiles.map((p) => ({ id: `voice-${p.id}`, label: p.name, onSelect: () => setVoiceForSelection(track.id, p.id) }))),
                      'separator',
                      { id: 'voice-default', label: t('stories.resetInlineVoice'), onSelect: () => setVoiceForSelection(track.id, 'default') },
                    ]}
                  >
                    <button className="stories-track__btn" onClick={(e) => e.stopPropagation()} title={t('stories.inlineVoiceHint')} aria-label={t('stories.inlineVoice')}>
                      <Users size={12} />
                    </button>
                  </Menu>
                  <button className={`stories-track__btn ${expandedLine === track.id ? 'stories-track__btn--on' : ''}`} onClick={(e) => { e.stopPropagation(); setExpandedLine((id) => (id === track.id ? null : track.id)); }} title={t('stories.tune')} aria-label={t('stories.tune')}>
                    <SlidersHorizontal size={12} />
                  </button>
                  <button className="stories-track__btn" onClick={(e) => { e.stopPropagation(); insertPauseInto(track.id); }} title={t('stories.insertPause')} aria-label={t('stories.insertPause')}>
                    <PauseIcon size={12} />
                  </button>
                  <button className="stories-track__btn" onClick={(e) => { e.stopPropagation(); previewTrack(track); }} disabled={track.generating || !track.text.trim()} title={t('stories.preview')} aria-label={t('stories.preview')}>
                    {track.generating ? <Mic size={12} className="spinner" /> : <Play size={12} />}
                  </button>
                  <button className="stories-track__btn stories-track__btn--delete" onClick={(e) => { e.stopPropagation(); removeTrack(track.id); }} title={t('stories.removeLine')} aria-label={t('stories.removeLine')}>
                    <Trash2 size={12} />
                  </button>
                </div>

                {expandedLine === track.id && (
                  <div className="stories-track__drawer" onClick={(e) => e.stopPropagation()}>
                    <div className="stories-track__tones">
                      {STORY_TONES.map((tn) => (
                        <button key={tn.tag} type="button" className="stories-track__tone" onClick={() => insertTokenInto(track.id, tn.tag)} title={tn.tag}>
                          <tn.icon size={12} aria-hidden="true" /> {t(`stories.tones.${tn.key}`)}
                        </button>
                      ))}
                    </div>
                    <label className="stories-track__speed">
                      <span>{t('stories.speed')}</span>
                      <input
                        type="range" min="0.5" max="2" step="0.05" value={track.speed || 1}
                        onChange={(e) => updateTrack(track.id, 'speed', parseFloat(e.target.value))}
                        aria-label={t('stories.speed')}
                      />
                      <span className="stories-track__speed-val">{(track.speed || 1).toFixed(2)}×</span>
                      {track.speed != null && (
                        <button type="button" className="stories-track__reset" onClick={() => updateTrack(track.id, 'speed', null)}>{t('stories.reset')}</button>
                      )}
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer stats */}
      {tracks.length > 0 && (
        <div className="stories-editor__footer">
          <div className="stories-editor__stats">
            <span className="stories-editor__stat"><FileText size={12} aria-hidden="true" /> {t('stories.lines', { count: tracks.length })}</span>
            <span className="stories-editor__stat"><Drama size={12} aria-hidden="true" /> {t('stories.characters', { count: usedCharacters })}</span>
            <span className="stories-editor__stat"><Timer size={12} aria-hidden="true" /> {t('stories.minutes', { count: estMinutes })}</span>
            <span className="stories-editor__stat"><ChartColumn size={12} aria-hidden="true" /> {t('stories.chars', { count: totalChars })}</span>
            {exporting && <span className="stories-editor__stat"><Hourglass size={12} aria-hidden="true" /> {exportPct}%</span>}
          </div>
        </div>
      )}
    </div>
  );
}
