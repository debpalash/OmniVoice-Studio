import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookMarked,
  BookOpen,
  BookText,
  Code,
  Loader,
  SlidersHorizontal,
  SpellCheck,
  Square,
  Upload,
  Users,
} from 'lucide-react';

import {
  audiobookPlan,
  audiobookGenerate,
  audiobookUploadCover,
  audiobookPreviewChapter,
  audiobookImport,
} from '../api/audiobook';
import { audioUrl } from '../api/generate';
import { listEngines } from '../api/engines';
import { consumeLongformStream } from '../utils/longformStream';
import { useAppStore } from '../store';
import VoiceSelector from '../components/VoiceSelector';
import SearchableSelect from '../components/SearchableSelect';
import AudiobookOverrides, { overridesToRequest } from '../components/audiobook/AudiobookOverrides';
import Section from '../components/audiobook/Section';
import BookDetails from '../components/audiobook/BookDetails';
import LexiconEditor from '../components/audiobook/LexiconEditor';
import GenerationProgress from '../components/audiobook/GenerationProgress';
import PlanList from '../components/audiobook/PlanList';
import AudiobookResult from '../components/audiobook/AudiobookResult';
import CastPanel from '../components/audiobook/CastPanel';
import MarkupToolbar from '../components/audiobook/MarkupToolbar';
import StatsBar from '../components/audiobook/StatsBar';
import ValidationWarnings from '../components/audiobook/ValidationWarnings';
import { useAudiobookLexicon } from '../hooks/useAudiobookLexicon';
import { parseCastNames, validateScript } from '../utils/audiobookScript';
import { SAMPLE_AUDIOBOOK_SCRIPT } from '../data/sampleAudiobook';
import ALL_LANGUAGES from '../languages.json';
import { POPULAR_LANGS } from '../utils/constants';
import { Button } from '../ui';
import { buttonVariants } from '@/components/ui/button.tsx';

// Chrome-mono uppercase form label (was the scoped `.audiobook-tab .field-label`
// rule; `.field-label` has no global styling, so it's reproduced as utilities).
// Stable empty-cast fallback: a literal `?? {}` mints a new object every render,
// which defeats the useMemos keyed on voiceCast (they'd recompute every render).
const EMPTY_CAST = Object.freeze({});

const FIELD_LABEL =
  '[font-family:var(--chrome-font-mono)] [font-size:var(--chrome-label-size)] font-semibold [letter-spacing:var(--chrome-label-track)] uppercase [color:var(--chrome-fg-muted)]';

/**
 * AudiobookTab — turn a chapter-delimited script into a chapterized m4b.
 *
 * Markdown `# H1` headings delimit chapters; inline `[voice:NAME]` and
 * `[pause …]` are honoured by the backend parser. "Preview plan" shows the
 * parsed chapters; "Create" streams synthesis progress and offers the m4b.
 */
export default function AudiobookTab({ profiles = [] }) {
  const { t } = useTranslation();
  // Persisted via the unified LongformProject store (#31b) — book identity,
  // script, voice, and output prefs now survive a tab switch / reload (they
  // used to live in component useState and evaporate).
  const text = useAppStore((s) => s.script);
  const setText = useAppStore((s) => s.setScript);
  const defaultVoice = useAppStore((s) => s.defaultVoice) ?? ''; // select coerces null→''
  const setOutputPrefs = useAppStore((s) => s.setOutputPrefs);
  const setProjectMeta = useAppStore((s) => s.setProjectMeta);
  const setDefaultVoice = (v) => setOutputPrefs({ defaultVoice: v || null });
  // Multi-voice cast map (#1217): [voice:NAME] → profile id, store-backed so a
  // book's voice assignments survive a tab switch / reload.
  const voiceCast = useAppStore((s) => s.voiceCast) ?? EMPTY_CAST;
  const setVoiceCast = useAppStore((s) => s.setVoiceCast);
  // Language pick + expressive overrides (#1208) — store-backed so a book's
  // tuning survives a tab switch / reload (same persistence as the lexicon).
  const language = useAppStore((s) => s.language) ?? 'Auto';
  const setLanguage = (v) => setOutputPrefs({ language: v || 'Auto' });
  const overrides = useAppStore((s) => s.overrides);
  const setLongformOverrides = useAppStore((s) => s.setLongformOverrides);
  // Show emotion controls only when the active engine understands them
  // (IndexTTS2). Fetched once on mount; degrades to hidden if the probe fails.
  const [emotionSupported, setEmotionSupported] = useState(false);
  useEffect(() => {
    let alive = true;
    listEngines()
      .then((r) => {
        if (!alive) return;
        const active = r?.tts?.active;
        const b = (r?.tts?.backends || []).find((x) => x.id === active);
        setEmotionSupported(!!b?.supports_emotion);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Per-chapter live progress (#1216): [{ title, status }] where status is
  // pending | rendering | done | cached | failed. Drives GenerationProgress.
  const [chapters, setChapters] = useState([]);
  const [assembling, setAssembling] = useState(false);
  const [stopped, setStopped] = useState(false);
  // Store-backed (#1139): the finished render's filename used to be component
  // useState, so the player + Download link vanished on the first tab switch —
  // users reported "no way to export". It now survives tab switches/reloads.
  const output = useAppStore((s) => s.lastOutput);
  const setOutput = useAppStore((s) => s.setLastOutput);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // {cached_chapters, failed_chapters}
  const [chapterPrev, setChapterPrev] = useState({}); // index → {url, loading}
  const abortRef = useRef(false);
  const abortControllerRef = useRef(null); // per-generation fetch AbortController

  // Abort an in-flight generation when the tab unmounts. Without this, leaving
  // mid-render keeps the stream (and the backend job) running, and a late
  // done/error event could clobber the store's output from a generation the
  // user started after coming back. Mirrors the manual Stop.
  useEffect(
    () => () => {
      abortRef.current = true;
      abortControllerRef.current?.abort();
    },
    [],
  );

  // Output prefs + metadata (embedded in the file; players show these) — now
  // store-backed. `meta` is default-filled so every controlled input gets a
  // defined string (an empty store record never flips a controlled→uncontrolled).
  const format = useAppStore((s) => s.outputFormat); // 'm4b' | 'mp3'
  const setFormat = (v) => setOutputPrefs({ outputFormat: v });
  const loudness = useAppStore((s) => s.loudness); // 'off' | 'acx' | 'podcast'
  const setLoudness = (v) => setOutputPrefs({ loudness: v });
  const metaStore = useAppStore((s) => s.meta);
  const meta = {
    title: '',
    author: '',
    narrator: '',
    year: '',
    genre: '',
    description: '',
    ...metaStore,
  };
  const setMetaField = (k) => (e) => setProjectMeta({ [k]: e.target.value });

  // Cover stays component-local (a File/blob can't persist to localStorage;
  // coverRef persistence is a noted follow-up).
  const [coverFile, setCoverFile] = useState(null);
  const [coverPreview, setCoverPreview] = useState('');

  // Pronunciation lexicon: editable {word → respelling} rows (extracted to a
  // hook so this page stays under the max-lines lint, #1217).
  const { lex, lexDict, setLexRow, addLexRow, removeLexRow } = useAudiobookLexicon();

  // Cast + validation derive purely from the script (#1217). castNames drives
  // the Cast panel; voiceMap is the minimal name→profile map actually present in
  // the script (stray store mappings are excluded so the cache key stays stable
  // and an absent map keeps today's render). Warnings are non-blocking hints.
  const textareaRef = useRef(null);
  const [warningsDismissed, setWarningsDismissed] = useState(false);
  const castNames = useMemo(() => parseCastNames(text), [text]);
  const voiceMap = useMemo(() => {
    const m = {};
    for (const name of castNames) if (voiceCast[name]) m[name] = voiceCast[name];
    return m;
  }, [castNames, voiceCast]);
  const voiceMapArg = Object.keys(voiceMap).length ? voiceMap : null;
  const warnings = useMemo(() => {
    const mappedNames = Object.keys(voiceCast).filter((n) => voiceCast[n]);
    return validateScript(text, { mappedNames, profileIds: profiles.map((p) => p.id) });
  }, [text, voiceCast, profiles]);

  const onCoverPick = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setCoverFile(f);
    setCoverPreview(URL.createObjectURL(f));
  }, []);
  const clearCover = useCallback(() => {
    setCoverFile(null);
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    setCoverPreview('');
  }, [coverPreview]);
  // Revoke the cover blob URL when it's replaced or the tab unmounts (React
  // doesn't reclaim object URLs on its own).
  useEffect(
    () => () => {
      if (coverPreview) URL.revokeObjectURL(coverPreview);
    },
    [coverPreview],
  );

  const [importing, setImporting] = useState(false);

  const onPreview = useCallback(async () => {
    setError('');
    setPlanLoading(true);
    try {
      setPlan(await audiobookPlan({ text, default_voice: defaultVoice || null }));
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setPlanLoading(false);
    }
  }, [text, defaultVoice]);

  const onImport = useCallback(
    async (e) => {
      const f = e.target.files?.[0];
      e.target.value = ''; // allow re-importing the same file
      if (!f) return;
      setError('');
      setImporting(true);
      try {
        const r = await audiobookImport(f);
        setText(r.text);
        setPlan(null);
      } catch (err) {
        setError(t('audiobook.import_failed', { message: err?.message || String(err) }));
      } finally {
        setImporting(false);
      }
    },
    [t],
  );

  // Drop the demo story straight into the editor so a first-timer can hit
  // Preview/Create immediately and hear every markup capability. Guard against
  // clobbering real work — only prompt when there's existing script content.
  const loadSample = useCallback(() => {
    if (text.trim() && !window.confirm(t('audiobook.load_sample_confirm'))) return;
    setText(SAMPLE_AUDIOBOOK_SCRIPT);
    setPlan(null);
    setError('');
  }, [text, t, setText]);

  const onPreviewChapter = useCallback(
    async (i) => {
      setError('');
      setChapterPrev((p) => ({ ...p, [i]: { ...p[i], loading: true } }));
      try {
        const lexicon = lexDict();
        const r = await audiobookPreviewChapter({
          text,
          chapter_index: i,
          default_voice: defaultVoice || null,
          lexicon: Object.keys(lexicon).length ? lexicon : null,
          // Cast map MUST match the full render's so a preview warms the exact
          // cache slot the render reuses (preview/render parity, #1217).
          voice_map: voiceMapArg,
          // Same expressive fields as the full render so a preview warms the
          // exact cache slot the render reuses (preview/render parity, #1208).
          ...overridesToRequest(overrides, language),
        });
        setChapterPrev((p) => ({ ...p, [i]: { url: audioUrl(r.output), loading: false } }));
      } catch (e) {
        setChapterPrev((p) => ({ ...p, [i]: { ...p[i], loading: false } }));
        setError(e?.message || String(e));
      }
    },
    [text, defaultVoice, lex, overrides, language, voiceMapArg],
  );

  const onCreate = useCallback(async () => {
    setError('');
    setOutput('');
    setDone(null);
    setStopped(false);
    setChapters([]);
    setAssembling(false);
    setGenerating(true);
    abortRef.current = false;
    // A per-generation AbortController: Stop aborts it, which cancels the fetch
    // end-to-end so the backend sees the disconnect and stops rendering (#1216).
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      let cover_path = null;
      if (coverFile) {
        cover_path = (await audiobookUploadCover(coverFile)).path;
      }
      // Only send metadata fields the user actually filled in.
      const metadata = Object.fromEntries(Object.entries(meta).filter(([, v]) => v && v.trim()));
      const lexicon = lexDict();
      const res = await audiobookGenerate(
        {
          text,
          default_voice: defaultVoice || null,
          format,
          loudness: loudness === 'off' ? null : loudness,
          cover_path,
          metadata: Object.keys(metadata).length ? metadata : null,
          lexicon: Object.keys(lexicon).length ? lexicon : null,
          // Multi-voice cast map (#1217): [voice:NAME] → profile id. Absent when
          // empty, so a single-voice book stays byte-identical to before.
          voice_map: voiceMapArg,
          // language pick + expressive/quality overrides + cache opt-out (#1208).
          // Only non-default values are emitted, so an untouched panel keeps the
          // request byte-identical to before.
          ...overridesToRequest(overrides, language),
        },
        { signal: controller.signal },
      );
      await consumeLongformStream(
        res,
        (evt) => {
          if (evt.type === 'started') {
            // Seed the per-chapter list; chapter 0 starts rendering immediately.
            setChapters(
              Array.from({ length: evt.chapters }, (_, i) => ({
                title: '',
                status: i === 0 ? 'rendering' : 'pending',
              })),
            );
          } else if (evt.type === 'chapter') {
            // A chapter finished (cached vs freshly rendered per evt.cached); the
            // next pending chapter becomes the one rendering.
            setChapters((prev) =>
              prev.map((c, j) =>
                j === evt.index
                  ? { ...c, title: evt.title, status: evt.cached ? 'cached' : 'done' }
                  : j === evt.index + 1 && c.status === 'pending'
                    ? { ...c, status: 'rendering' }
                    : c,
              ),
            );
          } else if (evt.type === 'chapter_error') {
            setChapters((prev) =>
              prev.map((c, j) =>
                j === evt.index
                  ? { ...c, title: evt.title, status: 'failed', error: evt.reason || evt.error || '' }
                  : j === evt.index + 1 && c.status === 'pending'
                    ? { ...c, status: 'rendering' }
                    : c,
              ),
            );
          } else if (evt.type === 'assembling') {
            setAssembling(true);
          } else if (evt.type === 'stopped') {
            setStopped(true);
          } else if (evt.type === 'done') {
            setOutput(evt.output);
            setDone({
              cached_chapters: evt.cached_chapters || 0,
              failed_chapters: evt.failed_chapters || [],
            });
          } else if (evt.type === 'error') {
            setError(evt.error || 'synthesis failed');
          }
        },
        { isAborted: () => abortRef.current, signal: controller.signal },
      );
      // consumeLongformStream returns (never throws) on a caller-initiated stop.
      if (abortRef.current) setStopped(true);
    } catch (e) {
      // A Stop that lands before/around the first byte aborts the fetch →
      // AbortError. Treat every self-initiated abort as "Stopped", not an error.
      if (abortRef.current || e?.name === 'AbortError') setStopped(true);
      else setError(e?.message || String(e));
    } finally {
      setGenerating(false);
      setAssembling(false);
      abortControllerRef.current = null;
    }
  }, [
    text,
    defaultVoice,
    format,
    loudness,
    coverFile,
    meta,
    lex,
    overrides,
    language,
    voiceMapArg,
  ]);

  // Stop = abort the fetch (cancels the request → backend disconnect) AND flip
  // the isAborted flag the stream consumer polls, so the read loop releases too.
  const onStop = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
  }, []);

  const busy = planLoading || generating || importing;
  const canRun = text.trim().length > 0 && !busy;
  // Cmd/Ctrl+Enter in the editor triggers Create when runnable; a no-op while
  // generating (canRun is false when busy).
  const onScriptKeyDown = useCallback(
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (canRun) onCreate();
      }
    },
    [canRun, onCreate],
  );

  return (
    <div className="audiobook-tab flex flex-col h-full box-border px-[1.5rem] py-[1.25rem] gap-[12px]">
      <div className="audiobook-tab__head flex flex-wrap items-start justify-between gap-[16px]">
        <div>
          <div
            role="heading"
            aria-level={2}
            className="flex items-center gap-[8px] m-0 [font-family:var(--font-serif)] [font-size:var(--text-xl)] [font-weight:var(--weight-semibold)] text-fg"
          >
            <BookMarked size={20} /> {t('audiobook.title')}
          </div>
          <p className="muted audiobook-tab__sub mt-[2px] text-[var(--text-sm)] text-fg-muted">
            {t('audiobook.subtitle')}
          </p>
        </div>
        <div className="audiobook-tab__actions flex flex-wrap items-center gap-[8px]">
          {/* All four use the one shadcn button layout (icon in the leading slot,
              text in a leading-none span) so the row lines up. Import is a <label>
              (it wraps the file input) styled the same way — the old inline
              flex/gap override is what made it ragged. */}
          <label
            className={buttonVariants({ variant: 'subtle', size: 'omniMd' })}
            style={{ cursor: busy ? 'default' : 'pointer' }}
          >
            {importing ? <Loader size={14} className="spin" /> : <Upload size={14} />}
            <span className="leading-none">{t('audiobook.import')}</span>
            <input
              type="file"
              accept=".txt,.md,.epub,.pdf"
              onChange={onImport}
              disabled={busy}
              style={{ display: 'none' }}
            />
          </label>
          <Button
            variant="subtle"
            onClick={loadSample}
            disabled={busy}
            title={t('audiobook.load_sample_hint')}
            leading={<BookOpen size={14} />}
          >
            {t('audiobook.load_sample')}
          </Button>
          <Button variant="subtle" onClick={onPreview} disabled={!canRun} loading={planLoading}>
            {t('audiobook.preview_plan')}
          </Button>
          {generating ? (
            <Button variant="danger" onClick={onStop} leading={<Square size={14} />}>
              {t('audiobook.stop')}
            </Button>
          ) : (
            <Button variant="primary" onClick={onCreate} disabled={!canRun}>
              {t('audiobook.create')}
            </Button>
          )}
        </div>
      </div>

      <div className="audiobook-tab__body grid flex-auto grid-cols-[minmax(0,1fr)_minmax(300px,380px)] max-[900px]:grid-cols-1 gap-[16px] min-h-0">
        {/* Left: script editor fills the height */}
        <div className="audiobook-tab__script flex flex-col min-h-0 gap-[6px]">
          <label className={FIELD_LABEL}>{t('audiobook.script')}</label>
          <MarkupToolbar t={t} textareaRef={textareaRef} text={text} setText={setText} />
          <textarea
            ref={textareaRef}
            className="input-base"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (warningsDismissed) setWarningsDismissed(false);
            }}
            onKeyDown={onScriptKeyDown}
            placeholder={t('audiobook.script_placeholder')}
            aria-label={t('audiobook.script')}
          />
          {text.trim() ? (
            <StatsBar t={t} text={text} />
          ) : (
            <p className="muted text-[var(--text-sm)] text-fg-muted m-0">
              {t('audiobook.empty_hint')}
            </p>
          )}
        </div>

        {/* Right: settings + results, scrolls independently */}
        <div className="audiobook-tab__side flex flex-col gap-[12px] min-h-0 overflow-y-auto max-[900px]:overflow-visible pr-[4px]">
          <div className="audiobook-tab__field flex flex-col gap-[4px]">
            <label className={FIELD_LABEL}>{t('audiobook.default_voice')}</label>
            <VoiceSelector
              value={defaultVoice}
              onChange={setDefaultVoice}
              profiles={profiles}
              defaultLabel={t('audiobook.engine_default')}
            />
          </div>

          <div className="audiobook-tab__field flex flex-col gap-[4px]">
            <label className={FIELD_LABEL}>{t('audiobook.language')}</label>
            <SearchableSelect
              value={language}
              options={ALL_LANGUAGES}
              popular={POPULAR_LANGS}
              recentsKey="omnivoice.recents.audiobookLang"
              onChange={setLanguage}
            />
          </div>

          {/* Cast — one row per distinct [voice:NAME] in the script (#1217).
              Open by default so the multi-voice mapping is discoverable the
              moment a script uses [voice:…]; hidden entirely when it doesn't. */}
          {castNames.length > 0 && (
            <Section title={t('audiobook.cast')} icon={<Users size={13} />} defaultOpen>
              <CastPanel
                t={t}
                castNames={castNames}
                voiceCast={voiceCast}
                setVoiceCast={setVoiceCast}
                profiles={profiles}
              />
            </Section>
          )}

          <AudiobookOverrides
            t={t}
            overrides={overrides}
            onChange={setLongformOverrides}
            emotionSupported={emotionSupported}
          />

          {/* Output — format + loudness. Open by default so a first-timer sees a
              tangible setting next to the always-on voice/language above. */}
          <Section title={t('audiobook.output')} icon={<SlidersHorizontal size={13} />} defaultOpen>
            <div className="grid grid-cols-[1fr_1fr] gap-[8px]">
              <div className="flex flex-col gap-[4px]">
                <label className={FIELD_LABEL}>{t('audiobook.format')}</label>
                <select
                  className="input-base"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                  aria-label={t('audiobook.format')}
                >
                  <option value="m4b">{t('audiobook.format_m4b')}</option>
                  <option value="mp3">{t('audiobook.format_mp3')}</option>
                </select>
              </div>
              <div className="flex flex-col gap-[4px]">
                <label className={FIELD_LABEL}>{t('audiobook.loudness')}</label>
                <select
                  className="input-base"
                  value={loudness}
                  onChange={(e) => setLoudness(e.target.value)}
                  aria-label={t('audiobook.loudness')}
                >
                  <option value="off">{t('audiobook.loudness_off')}</option>
                  <option value="acx">{t('audiobook.loudness_acx')}</option>
                  <option value="podcast">{t('audiobook.loudness_podcast')}</option>
                </select>
              </div>
            </div>
          </Section>

          {/* Book details — cover + embedded metadata. Collapsed by default. */}
          <Section title={t('audiobook.details')} icon={<BookText size={13} />}>
            <BookDetails
              t={t}
              coverPreview={coverPreview}
              onCoverPick={onCoverPick}
              clearCover={clearCover}
              meta={meta}
              setMetaField={setMetaField}
            />
          </Section>

          {/* Pronunciation lexicon — collapsed by default. */}
          <Section title={t('audiobook.lexicon')} icon={<SpellCheck size={13} />}>
            <LexiconEditor
              t={t}
              lex={lex}
              setLexRow={setLexRow}
              addLexRow={addLexRow}
              removeLexRow={removeLexRow}
            />
          </Section>

          {/* Markup quick reference — collapsed by default. */}
          <Section title={t('audiobook.markup_help')} icon={<Code size={13} />}>
            <p className="muted" style={{ fontSize: '0.72rem', lineHeight: 1.6 }}>
              {t('audiobook.markup_hint')}
            </p>
          </Section>

          {!warningsDismissed && !generating && (
            <ValidationWarnings
              t={t}
              warnings={warnings}
              onDismiss={() => setWarningsDismissed(true)}
            />
          )}

          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}

          {generating && <GenerationProgress t={t} chapters={chapters} assembling={assembling} />}

          {stopped && !generating && (
            <div className="audiobook-progress" role="status">
              {t('audiobook.stopped_note')}
            </div>
          )}

          {output && <AudiobookResult t={t} output={output} done={done} />}

          {plan && (
            <PlanList
              t={t}
              plan={plan}
              chapterPrev={chapterPrev}
              onPreviewChapter={onPreviewChapter}
              busy={busy}
            />
          )}
        </div>
      </div>
    </div>
  );
}
