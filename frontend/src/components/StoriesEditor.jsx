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
import {
  Plus,
  Play,
  Trash2,
  GripVertical,
  BookOpen,
  Mic,
  Download,
  Scissors,
  Pause as PauseIcon,
  Users,
  X,
  Upload,
  Sparkles,
  SlidersHorizontal,
  Folder,
  Layers,
  Bookmark,
  FileText,
  Drama,
  Timer,
  ChartColumn,
  Hourglass,
  Laugh,
  Wind,
  CircleQuestionMark,
  Zap,
  CircleCheck,
  Annoyed,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Button, Menu } from '../ui';
import { useAppStore } from '../store';
import { evaluateDonationPrompt } from './donate/evaluateDonationPrompt';
import {
  parseStoryText,
  hasStoryMarkers,
  applyInlineVoice,
  insertToken,
} from '../utils/storyTokens';
import { parseScript } from '../utils/parseScript';
import { importToText } from '../utils/importStory';
import { generateSpeech, audioUrl } from '../api/generate';
import { encodeAudio } from '../api/stories';
import { longformRender } from '../api/audiobook';
import { exportStems } from '../utils/storyExport';
import { storyToSpans } from '../utils/storyToSpans';
import { consumeLongformStream } from '../utils/longformStream';
import { reorder } from '../utils/storyReorder';
import { effectiveProfile, effectiveSpeed, castMember, nextCastColor } from '../utils/storyCast';

// ── Shared class strings (replacing the old stories-* BEM chrome) ─────────
const ADD_BTN =
  'inline-flex items-center gap-[4px] bg-transparent border border-border text-fg [font-size:var(--text-xs)] px-[8px] py-[3px] rounded-sm cursor-pointer hover:text-accent';
const NAME_INPUT =
  'bg-bg-elev-2 border border-border rounded-sm text-fg [font-size:var(--text-xs)] px-[8px] py-[4px]';
const SELECT_CHROME =
  'bg-bg-elev-2 border border-border rounded-md text-fg [font-size:var(--text-xs)] px-[6px] py-[4px] [font-family:var(--font-sans)] [color-scheme:dark]';
const DEL_BTN =
  'bg-transparent text-fg-subtle cursor-pointer w-[22px] h-[22px] flex items-center justify-center rounded-sm hover:enabled:text-danger hover:enabled:bg-white/[0.06] disabled:opacity-35 disabled:cursor-not-allowed';
const RESET_BTN =
  'bg-transparent border border-border text-fg-subtle [font-size:var(--text-xs)] px-[8px] py-[2px] rounded-sm cursor-pointer hover:text-fg';
const SPEED_RANGE = 'w-[120px]';
const TRACK_BTN =
  'w-[20px] h-[20px] flex items-center justify-center bg-transparent text-fg-subtle cursor-pointer rounded-sm [transition:color_0.15s,background_0.15s] p-0 hover:bg-white/[0.06]';

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
  const clean = String(text || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!clean) return out;
  const max = Math.max(40, Math.min(2000, maxChars | 0));
  let i = 0;
  while (i < clean.length) {
    const remain = clean.length - i;
    if (remain <= max) {
      out.push(clean.slice(i).trim());
      break;
    }
    const window = clean.slice(i, i + max);
    let cut = -1;
    for (let j = window.length - 1; j > Math.floor(max * 0.4); j--) {
      if (/[.!?。！？]/.test(window[j])) {
        cut = j + 1;
        break;
      }
    }
    if (cut < 0) {
      for (let j = window.length - 1; j > Math.floor(max * 0.4); j--) {
        if (/\s/.test(window[j])) {
          cut = j;
          break;
        }
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
  return {
    id: ++_trackId,
    character,
    text,
    profileId: null,
    emotion: null,
    speed: null,
    generating: false,
    audioUrl: null,
  };
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
  const setTracks = useCallback(
    (updater) => {
      const cur = useAppStore.getState().storyTracks;
      setStoryTracks(typeof updater === 'function' ? updater(cur) : updater);
    },
    [setStoryTracks],
  );

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
  // Global reading speed (#415): one speed for every line without its own
  // per-track override. UI preference → persisted in localStorage (survives
  // restarts; not part of the project state, so no slice migration).
  const [globalSpeed, setGlobalSpeedState] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem('ov_stories_global_speed'));
      return Number.isFinite(v) && v >= 0.5 && v <= 2 ? v : 1;
    } catch {
      return 1;
    }
  });
  const setGlobalSpeed = useCallback((v) => {
    setGlobalSpeedState(v);
    try {
      localStorage.setItem('ov_stories_global_speed', String(v));
    } catch {
      /* noop */
    }
  }, []);
  const trackTextRefs = useRef(new Map());
  const fileInputRef = useRef(null);
  const dragId = useRef(null);
  const [dragOver, setDragOver] = useState(null);

  // ── Cast ────────────────────────────────────────────────────────────────
  const addCharacter = useCallback(() => {
    const n = cast.length;
    upsertCastMember({
      id: genCastId(),
      name: `${t('stories.character')} ${n}`,
      color: nextCastColor(cast),
      profileId: null,
    });
    setCastOpen(true);
  }, [cast, upsertCastMember, t]);

  const deleteCharacter = useCallback(
    (id) => {
      if (id === 'narrator') return; // keep at least the narrator
      // Reassign any lines using this character back to the narrator.
      setTracks((prev) =>
        prev.map((tk) => (tk.character === id ? { ...tk, character: 'narrator' } : tk)),
      );
      removeCastMember(id);
    },
    [removeCastMember, setTracks],
  );

  // ── Auto-cast: detect speakers in pasted/imported text, build cast + lines ─
  const slug = (name) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'char';

  const autoCast = useCallback(() => {
    const parsed = parseScript(splitText);
    if (!parsed.length) {
      toast.error(t('stories.autocastEmpty'));
      return;
    }
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

  const onImportFile = useCallback(
    async (e) => {
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
    },
    [t],
  );

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
  const newStory = useCallback(() => {
    newProject();
    setProjectName('');
  }, [newProject]);
  const openProject = useCallback(
    (id) => {
      loadProject(id);
      setProjectsOpen(false);
    },
    [loadProject],
  );

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

  const setVoiceForSelection = useCallback(
    (trackId, voiceId) => {
      const el = trackTextRefs.current.get(trackId);
      const start = el?.selectionStart;
      const end = el?.selectionEnd;
      setTracks((prev) =>
        prev.map((tk) => {
          if (tk.id !== trackId) return tk;
          const safeStart = start != null ? start : tk.text.length;
          const safeEnd = end != null ? end : safeStart;
          return { ...tk, text: applyInlineVoice(tk.text, safeStart, safeEnd, voiceId) };
        }),
      );
    },
    [setTracks],
  );

  const insertTokenInto = useCallback(
    (trackId, token) => {
      const el = trackTextRefs.current.get(trackId);
      const caret = el ? el.selectionStart : null;
      setTracks((prev) =>
        prev.map((tk) =>
          tk.id === trackId ? { ...tk, text: insertToken(tk.text, caret, token) } : tk,
        ),
      );
    },
    [setTracks],
  );
  const insertPauseInto = useCallback(
    (trackId) => insertTokenInto(trackId, '[pause 0.5s]'),
    [insertTokenInto],
  );

  const addTrack = useCallback(() => setTracks((prev) => [...prev, makeTrack()]), [setTracks]);
  const removeTrack = useCallback(
    (id) =>
      setTracks((prev) =>
        prev.filter((tk) => {
          if (tk.id === id && tk.audioUrl) URL.revokeObjectURL(tk.audioUrl); // free the preview blob
          return tk.id !== id;
        }),
      ),
    [setTracks],
  );
  const updateTrack = useCallback(
    (id, field, value) => {
      setTracks((prev) => prev.map((tk) => (tk.id === id ? { ...tk, [field]: value } : tk)));
    },
    [setTracks],
  );

  // ── Synthesis (preview + export share one fetch) ─────────────────────────
  const fetchChunkBlob = useCallback(async (text, profileId, speed = 1.0) => {
    const fd = new FormData();
    fd.append('text', text);
    fd.append('speed', String(speed || 1.0));
    if (profileId) fd.append('profile_id', profileId);
    const res = await generateSpeech(fd); // apiFetch: same-origin + PIN-aware
    return res.blob();
  }, []);

  const fetchChunkAudio = useCallback(
    async (text, profileId, speed = 1.0) => {
      const blob = await fetchChunkBlob(text, profileId, speed);
      return URL.createObjectURL(blob);
    },
    [fetchChunkBlob],
  );

  const previewTrack = useCallback(
    async (track) => {
      const raw = (track.text || '').trim();
      if (!raw) return;
      const pid = effectiveProfile(track, cast);
      const spd = effectiveSpeed(track, globalSpeed);
      setTracks((prev) =>
        prev.map((tk) => (tk.id === track.id ? { ...tk, generating: true } : tk)),
      );

      if (!hasStoryMarkers(raw)) {
        try {
          const url = await fetchChunkAudio(raw, pid, spd);
          setTracks((prev) =>
            prev.map((tk) =>
              tk.id === track.id ? { ...tk, audioUrl: url, generating: false } : tk,
            ),
          );
          const audio = new Audio(url);
          audio.play().catch(() => {});
        } catch (err) {
          console.warn('Stories preview failed:', err);
          setTracks((prev) =>
            prev.map((tk) => (tk.id === track.id ? { ...tk, generating: false } : tk)),
          );
        }
        return;
      }

      const parsed = parseStoryText(raw, pid);
      try {
        const audioUrls = await Promise.all(
          parsed.map((seg) =>
            seg.type === 'chunk'
              ? fetchChunkAudio(seg.text, seg.profileId, spd)
              : Promise.resolve(null),
          ),
        );
        let cursor = 0;
        const finish = () => {
          for (let i = cursor; i < audioUrls.length; i++)
            if (audioUrls[i]) URL.revokeObjectURL(audioUrls[i]);
          setTracks((prev) =>
            prev.map((tk) =>
              tk.id === track.id ? { ...tk, generating: false, audioUrl: null } : tk,
            ),
          );
        };
        const step = () => {
          while (cursor < parsed.length) {
            const seg = parsed[cursor];
            const url = audioUrls[cursor];
            cursor++;
            if (seg.type === 'pause') {
              setTimeout(step, seg.seconds * 1000);
              return;
            }
            if (seg.type === 'chunk' && url) {
              const audio = new Audio(url);
              audio.onended = () => {
                URL.revokeObjectURL(url);
                step();
              };
              audio.onerror = () => {
                URL.revokeObjectURL(url);
                step();
              };
              audio.play().catch(() => {
                URL.revokeObjectURL(url);
                step();
              });
              return;
            }
          }
          finish();
        };
        step();
      } catch (err) {
        console.warn('Stories chained preview failed:', err);
        setTracks((prev) =>
          prev.map((tk) => (tk.id === track.id ? { ...tk, generating: false } : tk)),
        );
      }
    },
    [fetchChunkAudio, cast, globalSpeed, setTracks],
  );

  // Deliver a stitched WAV in the chosen format. MP3 routes through the backend
  // ffmpeg endpoint; if that fails (e.g. no ffmpeg), fall back to the raw WAV.
  const deliver = useCallback(
    async (wavBlob, baseName) => {
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
    },
    [exportFormat, t],
  );

  // Full export now runs on the shared server-side renderer (the Stories +
  // Audiobook convergence): cast + lines compile to a chapter/span plan and
  // stream through /longform/render — gaining chapter markers, resume, and
  // (via the audiobook controls) loudness/metadata. Single-line preview stays
  // client-side for latency. Stems remain a client export below.
  const generateAll = useCallback(async () => {
    const usable = tracks.filter((tk) => (tk.text || '').trim());
    if (!usable.length || exporting) return;
    const chapters = storyToSpans(usable, cast, globalSpeed);
    if (!chapters.length) {
      toast.error(t('stories.exportFailed'));
      return;
    }
    setExporting(true);
    setExportPct(0);
    try {
      const res = await longformRender({
        chapters,
        format: exportFormat === 'mp3' ? 'mp3' : 'm4b',
      });
      let total = 0;
      let output = '';
      let streamErr = null;
      await consumeLongformStream(res, (evt) => {
        if (evt.type === 'started') total = evt.chapters;
        else if (evt.type === 'chapter' || evt.type === 'chapter_error') {
          setExportPct(total ? Math.round(((evt.index + 1) / total) * 100) : 0);
        } else if (evt.type === 'done') output = evt.output;
        else if (evt.type === 'error') streamErr = evt.error || 'render failed';
      });
      if (streamErr) throw new Error(streamErr);
      if (!output) throw new Error('no output produced');
      downloadUrl(audioUrl(output), output.split('/').pop());
      toast.success(t('stories.exportDone'));
      // Success-only donation prompt (#007) — a finished longform export is a
      // real deliverable. Stays out of the catch/error branch below.
      evaluateDonationPrompt('longform');
    } catch (err) {
      console.warn('Story render failed:', err);
      toast.error(t('stories.exportFailed'));
    } finally {
      setExporting(false);
    }
  }, [tracks, cast, exporting, exportFormat, globalSpeed, t]);

  const exportStemsAll = useCallback(async () => {
    const usable = tracks.filter((tk) => (tk.text || '').trim());
    if (!usable.length || exporting) return;
    setExporting(true);
    setExportPct(0);
    try {
      const stems = await exportStems(
        usable,
        (tk) => ({ profileId: effectiveProfile(tk, cast), speed: effectiveSpeed(tk, globalSpeed) }),
        fetchChunkBlob,
        (d, total) => setExportPct(total ? Math.round((d / total) * 100) : 0),
      );
      for (const s of stems) {
        const name = ((castMember(cast, s.character) || {}).name || s.character).replace(
          /[^\w-]+/g,
          '_',
        );
        await deliver(s.blob, `story-${name}`);
      }
      toast.success(t('stories.stemsDone', { count: stems.length }));
    } catch (err) {
      console.warn('Stems export failed:', err);
      toast.error(t('stories.exportFailed'));
    } finally {
      setExporting(false);
    }
  }, [tracks, cast, fetchChunkBlob, exporting, deliver, globalSpeed, t]);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const totalChars = tracks.reduce((acc, tk) => acc + tk.text.length, 0);
  const usedCharacters = new Set(tracks.map((tk) => tk.character)).size;
  const estMinutes = Math.ceil(totalChars / 800);

  const profileName = (id) => (profiles.find((p) => p.id === id) || {}).name;

  return (
    <div
      className="flex flex-col h-full w-full gap-[12px] p-[16px] font-sans"
      role="region"
      aria-label="Stories editor"
    >
      {/* Header / toolbar */}
      <div className="flex items-center justify-between gap-[12px]">
        <div>
          <h2 className="font-serif [font-size:var(--text-xl)] [font-weight:var(--weight-semibold)] text-fg m-0 flex items-center gap-[8px]">
            <BookOpen size={18} /> {t('stories.title')}
          </h2>
          <p className="text-fg-muted [font-size:var(--text-sm)]">{t('stories.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-[6px]">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.srt,text/plain"
            onChange={onImportFile}
            hidden
          />

          {/* Project */}
          <div className="inline-flex items-center gap-[4px]">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setProjectsOpen((v) => !v)}
              aria-label={t('stories.projects')}
            >
              <Folder size={13} /> {currentProject ? currentProject.name : t('stories.projects')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCastOpen((v) => !v)}
              aria-label={t('stories.cast')}
            >
              <Users size={13} /> {t('stories.cast')}
            </Button>
          </div>

          <span
            className="self-stretch w-px min-h-[18px] mx-[4px] bg-border opacity-70"
            aria-hidden="true"
          />

          {/* Content */}
          <div className="inline-flex items-center gap-[4px]">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
              aria-label={t('stories.import')}
            >
              <Upload size={13} /> {t('stories.import')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSplitOpen((v) => !v)}
              aria-label={t('stories.pasteSplit')}
            >
              <Scissors size={13} /> {t('stories.pasteSplit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={addTrack} aria-label={t('stories.addLine')}>
              <Plus size={13} /> {t('stories.addLine')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={addChapter}
              aria-label={t('stories.addChapter')}
            >
              <Bookmark size={13} /> {t('stories.addChapter')}
            </Button>
          </div>

          <span
            className="self-stretch w-px min-h-[18px] mx-[4px] bg-border opacity-70"
            aria-hidden="true"
          />

          {/* Global reading speed (#415) — one speed for every line that has no
              per-line override. */}
          <div className="inline-flex items-center gap-[4px]">
            <label
              className="inline-flex items-center gap-[8px] [font-size:var(--text-xs)] text-fg-subtle"
              title={t('stories.global_speed_hint', {
                defaultValue: 'Reading speed for all lines without their own speed override',
              })}
            >
              <span>{t('stories.global_speed', { defaultValue: 'Speed' })}</span>
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.05"
                value={globalSpeed}
                onChange={(e) => setGlobalSpeed(parseFloat(e.target.value))}
                aria-label={t('stories.global_speed', { defaultValue: 'Global reading speed' })}
                className={SPEED_RANGE}
              />
              <span className="[font-family:var(--font-mono)] text-fg min-w-[44px]">
                {globalSpeed.toFixed(2)}×
              </span>
              {globalSpeed !== 1 && (
                <button type="button" className={RESET_BTN} onClick={() => setGlobalSpeed(1)}>
                  {t('stories.reset')}
                </button>
              )}
            </label>
          </div>

          <span
            className="self-stretch w-px min-h-[18px] mx-[4px] bg-border opacity-70"
            aria-hidden="true"
          />

          {/* Output */}
          <div className="inline-flex items-center gap-[4px]">
            <Button
              size="sm"
              variant="ghost"
              onClick={exportStemsAll}
              disabled={tracks.length === 0 || exporting}
              aria-label={t('stories.stems')}
            >
              <Layers size={13} /> {t('stories.stems')}
            </Button>
            <select
              className="input-base w-auto [font-size:var(--text-xs)] px-[6px] py-[3px]"
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
        <div
          className="flex flex-col gap-[8px] p-[12px] bg-bg-elev-2 [border:1px_solid_var(--color-border)] rounded-sm"
          role="region"
          aria-label={t('stories.projects')}
        >
          <div className="flex items-center justify-between">
            <span className="[font-size:var(--text-xs)] font-semibold uppercase tracking-[0.06em] text-accent">
              {t('stories.projects')}
            </span>
            <button type="button" className={ADD_BTN} onClick={newStory}>
              <Plus size={12} /> {t('stories.newStory')}
            </button>
          </div>
          <div className="flex items-center gap-[8px]">
            <input
              className={`${NAME_INPUT} flex-1`}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t('stories.untitled')}
              aria-label={t('stories.projectName')}
            />
            <Button size="sm" onClick={saveCurrent}>
              {t('stories.save')}
            </Button>
          </div>
          {storyProjects.map((p) => (
            <div
              key={p.id}
              className={`flex items-center gap-[8px] ${p.id === currentProjectId ? 'bg-[rgba(184,187,38,0.08)] rounded-sm' : ''}`}
            >
              <button
                type="button"
                className="flex-1 inline-flex items-center gap-[6px] bg-transparent text-fg [font-size:var(--text-xs)] text-left cursor-pointer px-[2px] py-[4px] hover:text-accent"
                onClick={() => openProject(p.id)}
              >
                <Folder size={12} /> {p.name}
              </button>
              <button
                type="button"
                className={DEL_BTN}
                onClick={() => deleteProject(p.id)}
                aria-label={t('stories.deleteProject')}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {storyProjects.length === 0 && (
            <p className="m-0 [font-size:var(--text-xs)] text-fg-subtle">
              {t('stories.noProjects')}
            </p>
          )}
        </div>
      )}

      {/* Cast panel */}
      {castOpen && (
        <div
          className="flex flex-col gap-[8px] p-[12px] bg-bg-elev-2 [border:1px_solid_var(--color-border)] rounded-sm"
          role="region"
          aria-label={t('stories.castTitle')}
        >
          <div className="flex items-center justify-between">
            <span className="[font-size:var(--text-xs)] font-semibold uppercase tracking-[0.06em] text-accent">
              {t('stories.castTitle')}
            </span>
            <button type="button" className={ADD_BTN} onClick={addCharacter}>
              <Plus size={12} /> {t('stories.addCharacter')}
            </button>
          </div>
          {cast.map((c) => (
            <div key={c.id} className="flex items-center gap-[8px]">
              <span
                className="w-[10px] h-[10px] rounded-full shrink-0"
                style={{ background: c.color }}
              />
              <input
                className={`${NAME_INPUT} flex-[0_0_140px]`}
                value={c.name}
                onChange={(e) => upsertCastMember({ ...c, name: e.target.value })}
                aria-label={t('stories.characterName')}
              />
              <select
                className={`${SELECT_CHROME} flex-1`}
                value={c.profileId || ''}
                onChange={(e) => setCharacterVoice(c.id, e.target.value || null)}
                aria-label={`${c.name} ${t('stories.voice')}`}
              >
                <option value="">{t('stories.defaultVoice')}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={DEL_BTN}
                onClick={() => deleteCharacter(c.id)}
                disabled={c.id === 'narrator'}
                title={
                  c.id === 'narrator' ? t('stories.narratorLocked') : t('stories.removeCharacter')
                }
                aria-label={t('stories.removeCharacter')}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {profiles.length === 0 && (
            <p className="m-0 [font-size:var(--text-xs)] text-fg-subtle">
              {t('stories.noProfiles')}
            </p>
          )}
        </div>
      )}

      {/* Paste & split */}
      {splitOpen && (
        <div
          className="flex flex-col gap-[8px] p-[12px] my-[8px] [border:1px_solid_var(--color-border)] rounded-md [background:rgba(255,255,255,0.02)]"
          role="region"
          aria-label={t('stories.pasteSplit')}
        >
          <textarea
            className="w-full min-h-[96px] px-[10px] py-[8px] bg-bg-elev-2 border border-border rounded-sm text-fg [font-family:var(--font-sans)] [font-size:var(--text-sm)] resize-y"
            placeholder={t('stories.splitPlaceholder')}
            value={splitText}
            onChange={(e) => setSplitText(e.target.value)}
            rows={6}
            aria-label={t('stories.splitPlaceholder')}
          />
          <div className="flex items-center gap-[12px] flex-wrap">
            <label className="flex items-center gap-[6px] [font-size:var(--text-xs)] text-fg-muted">
              {t('stories.maxChars')}
              <input
                type="number"
                min={60}
                max={1000}
                step={10}
                value={splitMax}
                onChange={(e) => setSplitMax(parseInt(e.target.value, 10) || 180)}
                className="w-[64px] px-[6px] py-[4px] bg-bg-elev-2 border border-border rounded-sm text-fg [font-family:var(--font-mono)] [font-size:var(--text-xs)]"
              />
            </label>
            <span className="flex-1 [font-size:var(--text-xs)] text-fg-subtle">
              {splitText
                ? t('stories.segmentsHint', {
                    count: splitIntoChunks(splitText, splitMax).length,
                    max: splitMax,
                  })
                : t('stories.pasteAbove')}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSplitText('');
                setSplitOpen(false);
              }}
            >
              {t('stories.cancel')}
            </Button>
            <Button size="sm" variant="ghost" onClick={applySplit} disabled={!splitText.trim()}>
              <Scissors size={13} /> {t('stories.splitIntoTracks')}
            </Button>
            <Button
              size="sm"
              onClick={autoCast}
              disabled={!splitText.trim()}
              title={t('stories.autocastHint')}
            >
              <Sparkles size={13} /> {t('stories.autocast')}
            </Button>
          </div>
        </div>
      )}

      {/* Tracks */}
      {tracks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-[12px] text-fg-muted text-center">
          <BookOpen size={32} className="text-[2rem] opacity-40" aria-hidden="true" />
          <p className="[font-size:var(--text-sm)] max-w-[320px] leading-[1.6]">
            {t('stories.emptyText')}
          </p>
          <Button size="sm" onClick={addTrack}>
            <Plus size={13} /> {t('stories.addFirst')}
          </Button>
        </div>
      ) : (
        <div className="flex-1 flex flex-col gap-[6px] overflow-y-auto pr-[4px]" role="list">
          {tracks.map((track) => {
            const dragProps = {
              draggable: true,
              onDragStart: (e) => {
                dragId.current = track.id;
                e.dataTransfer.effectAllowed = 'move';
              },
              onDragOver: (e) => {
                e.preventDefault();
                if (dragOver !== track.id) setDragOver(track.id);
              },
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
                  className={[
                    'group flex items-center gap-[8px] mt-[16px] mb-[4px] px-[10px] py-[7px] rounded-md [border-left:3px_solid_var(--color-accent)] bg-bg-elev-2',
                    dragOver === track.id
                      ? '[outline:1px_dashed_var(--color-accent)] outline-offset-[2px]'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  {...dragProps}
                >
                  <div
                    className="flex text-fg-subtle cursor-grab opacity-40 group-hover:opacity-100"
                    aria-hidden="true"
                  >
                    <GripVertical size={14} />
                  </div>
                  <Bookmark size={15} className="flex-none text-accent" aria-hidden="true" />
                  <input
                    className="flex-1 min-w-0 bg-transparent border-none outline-none [font-family:inherit] [font-size:0.95rem] font-bold [letter-spacing:0.01em] text-fg px-0 py-[2px] placeholder:text-fg-subtle placeholder:font-semibold"
                    value={title}
                    onChange={(e) => updateTrack(track.id, 'text', `# ${e.target.value}`)}
                    placeholder={t('stories.addChapter')}
                    aria-label={t('stories.addChapter')}
                  />
                  <button
                    type="button"
                    className="flex-none flex p-[4px] rounded-[6px] bg-transparent border-none text-fg-subtle cursor-pointer opacity-0 group-hover:opacity-70 hover:opacity-100 hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTrack(track.id);
                    }}
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
                  'group grid [grid-template-columns:32px_1fr_160px_100px_44px] gap-[8px] items-center px-[10px] py-[8px] bg-bg-elev-1 border border-border rounded-lg [transition:border-color_0.15s,box-shadow_0.15s] cursor-grab flex-wrap hover:border-border-strong hover:[box-shadow:var(--shadow-sm)]',
                  activeTrack === track.id ? 'bg-primary/[0.12]' : '',
                  track.character === 'narrator'
                    ? '[border-left:3px_solid_var(--color-accent)]'
                    : '',
                  dragOver === track.id ? '[box-shadow:inset_0_2px_0_0_var(--color-accent)]' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => setActiveTrack(track.id)}
                {...dragProps}
              >
                <div
                  className="flex items-center justify-center text-fg-subtle cursor-grab active:cursor-grabbing"
                  aria-hidden="true"
                >
                  <GripVertical size={14} />
                </div>

                <textarea
                  className="w-full bg-bg-elev-2 border border-transparent rounded-md text-fg [font-family:var(--font-sans)] [font-size:var(--text-sm)] px-[8px] py-[6px] resize-none min-h-[36px] leading-[1.5] [transition:border-color_0.15s] focus:border-brand focus:outline-none"
                  ref={(el) => {
                    if (el) trackTextRefs.current.set(track.id, el);
                    else trackTextRefs.current.delete(track.id);
                  }}
                  value={track.text}
                  onChange={(e) => updateTrack(track.id, 'text', e.target.value)}
                  placeholder={t('stories.linePlaceholder')}
                  rows={1}
                  aria-label={`${member ? member.name : ''} ${t('stories.text')}`}
                />

                <div className="flex items-center gap-[6px]">
                  <span
                    className="w-[10px] h-[10px] rounded-full shrink-0"
                    style={{ background: member ? member.color : '#a89984' }}
                  />
                  <select
                    className={`${SELECT_CHROME} flex-1`}
                    value={track.character}
                    onChange={(e) => updateTrack(track.id, 'character', e.target.value)}
                    aria-label={t('stories.character')}
                  >
                    {cast.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <select
                  className="[font-size:var(--text-xs)] text-fg-muted bg-bg-elev-2 border border-border [border-radius:var(--radius-pill)] px-[8px] py-[2px] text-center max-w-[100px] overflow-hidden text-ellipsis whitespace-nowrap [color-scheme:dark]"
                  value={track.profileId || ''}
                  onChange={(e) => updateTrack(track.id, 'profileId', e.target.value || null)}
                  aria-label={t('stories.voice')}
                >
                  <option value="">
                    {inheritedName ? `↳ ${inheritedName}` : t('stories.defaultVoice')}
                  </option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>

                <div
                  className={`flex gap-[4px] [transition:opacity_0.12s_ease] ${
                    activeTrack === track.id ? 'opacity-100' : 'opacity-50 group-hover:opacity-100'
                  }`}
                >
                  <Menu
                    placement="bottom-end"
                    items={[
                      ...(profiles.length === 0
                        ? [{ id: 'noprof', label: t('stories.noProfiles'), disabled: true }]
                        : profiles.map((p) => ({
                            id: `voice-${p.id}`,
                            label: p.name,
                            onSelect: () => setVoiceForSelection(track.id, p.id),
                          }))),
                      'separator',
                      {
                        id: 'voice-default',
                        label: t('stories.resetInlineVoice'),
                        onSelect: () => setVoiceForSelection(track.id, 'default'),
                      },
                    ]}
                  >
                    <button
                      className={`${TRACK_BTN} hover:text-fg`}
                      onClick={(e) => e.stopPropagation()}
                      title={t('stories.inlineVoiceHint')}
                      aria-label={t('stories.inlineVoice')}
                    >
                      <Users size={12} />
                    </button>
                  </Menu>
                  <button
                    className={`${TRACK_BTN} hover:text-fg ${expandedLine === track.id ? 'text-accent bg-white/[0.06]' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedLine((id) => (id === track.id ? null : track.id));
                    }}
                    title={t('stories.tune')}
                    aria-label={t('stories.tune')}
                  >
                    <SlidersHorizontal size={12} />
                  </button>
                  <button
                    className={`${TRACK_BTN} hover:text-fg`}
                    onClick={(e) => {
                      e.stopPropagation();
                      insertPauseInto(track.id);
                    }}
                    title={t('stories.insertPause')}
                    aria-label={t('stories.insertPause')}
                  >
                    <PauseIcon size={12} />
                  </button>
                  <button
                    className={`${TRACK_BTN} hover:text-fg`}
                    onClick={(e) => {
                      e.stopPropagation();
                      previewTrack(track);
                    }}
                    disabled={track.generating || !track.text.trim()}
                    title={t('stories.preview')}
                    aria-label={t('stories.preview')}
                  >
                    {track.generating ? <Mic size={12} className="spinner" /> : <Play size={12} />}
                  </button>
                  <button
                    className={`${TRACK_BTN} hover:text-danger`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTrack(track.id);
                    }}
                    title={t('stories.removeLine')}
                    aria-label={t('stories.removeLine')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>

                {expandedLine === track.id && (
                  <div
                    className="basis-full flex flex-wrap items-center gap-[12px] mt-[8px] pt-[8px] [border-top:1px_solid_var(--color-border)]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex flex-wrap gap-[4px]">
                      {STORY_TONES.map((tn) => (
                        <button
                          key={tn.tag}
                          type="button"
                          className="inline-flex items-center gap-[4px] bg-bg-elev-2 border border-border rounded-full text-fg [font-size:var(--text-xs)] px-[9px] py-[3px] cursor-pointer hover:text-accent"
                          onClick={() => insertTokenInto(track.id, tn.tag)}
                          title={tn.tag}
                        >
                          <tn.icon size={12} aria-hidden="true" /> {t(`stories.tones.${tn.key}`)}
                        </button>
                      ))}
                    </div>
                    <label className="inline-flex items-center gap-[8px] [font-size:var(--text-xs)] text-fg-subtle">
                      <span>{t('stories.speed')}</span>
                      <input
                        type="range"
                        min="0.5"
                        max="2"
                        step="0.05"
                        value={track.speed || 1}
                        onChange={(e) => updateTrack(track.id, 'speed', parseFloat(e.target.value))}
                        aria-label={t('stories.speed')}
                        className={SPEED_RANGE}
                      />
                      <span className="[font-family:var(--font-mono)] text-fg min-w-[44px]">
                        {(track.speed || 1).toFixed(2)}×
                      </span>
                      {track.speed != null && (
                        <button
                          type="button"
                          className={RESET_BTN}
                          onClick={() => updateTrack(track.id, 'speed', null)}
                        >
                          {t('stories.reset')}
                        </button>
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
        <div className="flex items-center justify-between pt-[8px] [border-top:1px_solid_var(--color-border)]">
          <div className="[font-size:var(--text-xs)] text-fg-subtle flex gap-[12px]">
            <span className="flex items-center gap-[4px]">
              <FileText size={12} aria-hidden="true" />{' '}
              {t('stories.lines', { count: tracks.length })}
            </span>
            <span className="flex items-center gap-[4px]">
              <Drama size={12} aria-hidden="true" />{' '}
              {t('stories.characters', { count: usedCharacters })}
            </span>
            <span className="flex items-center gap-[4px]">
              <Timer size={12} aria-hidden="true" /> {t('stories.minutes', { count: estMinutes })}
            </span>
            <span className="flex items-center gap-[4px]">
              <ChartColumn size={12} aria-hidden="true" />{' '}
              {t('stories.chars', { count: totalChars })}
            </span>
            {exporting && (
              <span className="flex items-center gap-[4px]">
                <Hourglass size={12} aria-hidden="true" /> {exportPct}%
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
