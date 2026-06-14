import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookMarked, Loader, Download, Image as ImageIcon, X, Play, Upload, Plus } from 'lucide-react';

import {
  audiobookPlan, audiobookGenerate, audiobookUploadCover, audiobookPreviewChapter, audiobookImport,
} from '../api/audiobook';
import { audioUrl } from '../api/generate';
import { consumeLongformStream } from '../utils/longformStream';
import { useAppStore } from '../store';
import VoiceSelector from '../components/VoiceSelector';
import './AudiobookTab.css';

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
  const defaultVoice = useAppStore((s) => s.defaultVoice) ?? '';  // select coerces null→''
  const setOutputPrefs = useAppStore((s) => s.setOutputPrefs);
  const setProjectMeta = useAppStore((s) => s.setProjectMeta);
  const setLexiconStore = useAppStore((s) => s.setLexicon);
  const storeLexicon = useAppStore((s) => s.lexicon);
  const setDefaultVoice = (v) => setOutputPrefs({ defaultVoice: v || null });
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null); // {current,total,title,assembling}
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // {cached_chapters, failed_chapters}
  const [chapterPrev, setChapterPrev] = useState({}); // index → {url, loading}
  const abortRef = useRef(false);

  // Output prefs + metadata (embedded in the file; players show these) — now
  // store-backed. `meta` is default-filled so every controlled input gets a
  // defined string (an empty store record never flips a controlled→uncontrolled).
  const format = useAppStore((s) => s.outputFormat);     // 'm4b' | 'mp3'
  const setFormat = (v) => setOutputPrefs({ outputFormat: v });
  const loudness = useAppStore((s) => s.loudness);        // 'off' | 'acx' | 'podcast'
  const setLoudness = (v) => setOutputPrefs({ loudness: v });
  const metaStore = useAppStore((s) => s.meta);
  const meta = { title: '', author: '', narrator: '', year: '', genre: '', description: '', ...metaStore };
  const setMetaField = (k) => (e) => setProjectMeta({ [k]: e.target.value });

  // Cover stays component-local (a File/blob can't persist to localStorage;
  // coverRef persistence is a noted follow-up).
  const [coverFile, setCoverFile] = useState(null);
  const [coverPreview, setCoverPreview] = useState('');

  // Pronunciation lexicon: editable {word → respelling} rows. Rows stay LOCAL
  // (half-typed rows aren't junk-persisted); the filtered dict flushes to the
  // store so it survives a reload, and hydrates back into rows on mount.
  const [lex, setLex] = useState([]); // [{ word, say }]
  const lexHydrated = useRef(false);
  useEffect(() => {
    if (lexHydrated.current) return;
    lexHydrated.current = true;
    const rows = Object.entries(storeLexicon || {}).map(([word, say]) => ({ word, say }));
    if (rows.length) setLex(rows);
  }, [storeLexicon]);
  const lexDict = () => Object.fromEntries(
    lex.filter((r) => r.word.trim() && r.say.trim()).map((r) => [r.word.trim(), r.say.trim()]),
  );
  // Flush the filtered dict to the store whenever rows change (after hydration).
  useEffect(() => {
    if (!lexHydrated.current) return;
    setLexiconStore(lexDict());
  }, [lex]); // eslint-disable-line react-hooks/exhaustive-deps
  const setLexRow = (i, k) => (e) => setLex((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));
  const addLexRow = () => setLex((rows) => [...rows, { word: '', say: '' }]);
  const removeLexRow = (i) => setLex((rows) => rows.filter((_, j) => j !== i));

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
  useEffect(() => () => { if (coverPreview) URL.revokeObjectURL(coverPreview); }, [coverPreview]);

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

  const onImport = useCallback(async (e) => {
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
  }, [t]);

  const onPreviewChapter = useCallback(async (i) => {
    setError('');
    setChapterPrev((p) => ({ ...p, [i]: { ...(p[i] || {}), loading: true } }));
    try {
      const lexicon = lexDict();
      const r = await audiobookPreviewChapter({
        text, chapter_index: i, default_voice: defaultVoice || null,
        lexicon: Object.keys(lexicon).length ? lexicon : null,
      });
      setChapterPrev((p) => ({ ...p, [i]: { url: audioUrl(r.output), loading: false } }));
    } catch (e) {
      setChapterPrev((p) => ({ ...p, [i]: { ...(p[i] || {}), loading: false } }));
      setError(e?.message || String(e));
    }
  }, [text, defaultVoice, lex]);

  const onCreate = useCallback(async () => {
    setError('');
    setOutput('');
    setDone(null);
    setProgress({ current: 0, total: 0 });
    setGenerating(true);
    abortRef.current = false;
    try {
      let cover_path = null;
      if (coverFile) {
        cover_path = (await audiobookUploadCover(coverFile)).path;
      }
      // Only send metadata fields the user actually filled in.
      const metadata = Object.fromEntries(
        Object.entries(meta).filter(([, v]) => v && v.trim()),
      );
      const lexicon = lexDict();
      const res = await audiobookGenerate({
        text,
        default_voice: defaultVoice || null,
        format,
        loudness: loudness === 'off' ? null : loudness,
        cover_path,
        metadata: Object.keys(metadata).length ? metadata : null,
        lexicon: Object.keys(lexicon).length ? lexicon : null,
      });
      await consumeLongformStream(res, (evt) => {
        if (evt.type === 'started') {
          setProgress({ current: 0, total: evt.chapters });
        } else if (evt.type === 'chapter') {
          setProgress({ current: evt.index + 1, total: evt.total, title: evt.title });
        } else if (evt.type === 'assembling') {
          setProgress((p) => ({ ...(p || {}), assembling: true }));
        } else if (evt.type === 'chapter_error') {
          setProgress({ current: evt.index + 1, total: evt.total, title: evt.title });
        } else if (evt.type === 'done') {
          setOutput(evt.output);
          setDone({
            cached_chapters: evt.cached_chapters || 0,
            failed_chapters: evt.failed_chapters || [],
          });
        } else if (evt.type === 'error') {
          setError(evt.error || 'synthesis failed');
        }
      }, { isAborted: () => abortRef.current });
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setGenerating(false);
    }
  }, [text, defaultVoice, format, loudness, coverFile, meta, lex]);

  const busy = planLoading || generating || importing;
  const canRun = text.trim().length > 0 && !busy;

  return (
    <div className="audiobook-tab">
      <div className="audiobook-tab__head">
        <div>
          <h2 className="audiobook-tab__title">
            <BookMarked size={20} /> {t('audiobook.title')}
          </h2>
          <p className="muted audiobook-tab__sub">{t('audiobook.subtitle')}</p>
        </div>
        <div className="audiobook-tab__actions">
          <label className="ui-btn ui-btn--subtle" style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {importing ? <Loader size={14} className="spin" /> : <Upload size={14} />} {t('audiobook.import')}
            <input type="file" accept=".txt,.md,.epub,.pdf" onChange={onImport} disabled={busy} style={{ display: 'none' }} />
          </label>
          <button className="ui-btn ui-btn--subtle" onClick={onPreview} disabled={!canRun}>
            {planLoading ? <Loader size={14} className="spin" /> : null} {t('audiobook.preview_plan')}
          </button>
          <button className="ui-btn ui-btn--primary" onClick={onCreate} disabled={!canRun}>
            {generating ? <Loader size={14} className="spin" /> : null} {t('audiobook.create')}
          </button>
        </div>
      </div>

      <div className="audiobook-tab__body">
        {/* Left: script editor fills the height */}
        <div className="audiobook-tab__script">
          <label className="field-label">{t('audiobook.script')}</label>
          <textarea
            className="input-base"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('audiobook.script_placeholder')}
            aria-label={t('audiobook.script')}
          />
        </div>

        {/* Right: settings + results, scrolls independently */}
        <div className="audiobook-tab__side">
          <div className="audiobook-tab__field">
            <label className="field-label">{t('audiobook.default_voice')}</label>
            <VoiceSelector
              value={defaultVoice}
              onChange={setDefaultVoice}
              profiles={profiles}
              defaultLabel={t('audiobook.engine_default')}
            />
          </div>

          <div className="audiobook-tab__duo">
            <div className="audiobook-tab__field">
              <label className="field-label">{t('audiobook.format')}</label>
              <select className="input-base" value={format}
                onChange={(e) => setFormat(e.target.value)} aria-label={t('audiobook.format')}>
                <option value="m4b">{t('audiobook.format_m4b')}</option>
                <option value="mp3">{t('audiobook.format_mp3')}</option>
              </select>
            </div>
            <div className="audiobook-tab__field">
              <label className="field-label">{t('audiobook.loudness')}</label>
              <select className="input-base" value={loudness}
                onChange={(e) => setLoudness(e.target.value)} aria-label={t('audiobook.loudness')}>
                <option value="off">{t('audiobook.loudness_off')}</option>
                <option value="acx">{t('audiobook.loudness_acx')}</option>
                <option value="podcast">{t('audiobook.loudness_podcast')}</option>
              </select>
            </div>
          </div>

          {/* Cover + metadata */}
          <div className="audiobook-tab__field">
            <label className="field-label">{t('audiobook.details')}</label>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ position: 'relative', width: 96, height: 96, flexShrink: 0 }}>
                {coverPreview ? (
                  <>
                    <img src={coverPreview} alt={t('audiobook.cover')}
                      style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 6 }} />
                    <button type="button" className="ui-btn ui-btn--icon" onClick={clearCover}
                      aria-label={t('audiobook.cover_remove')}
                      style={{ position: 'absolute', top: 4, right: 4 }}>
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <label className="ui-btn ui-btn--subtle" style={{
                    width: 96, height: 96, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 4, cursor: 'pointer',
                  }}>
                    <ImageIcon size={20} />
                    <span style={{ fontSize: '0.65rem' }}>{t('audiobook.cover_add')}</span>
                    <input type="file" accept="image/png,image/jpeg" onChange={onCoverPick} style={{ display: 'none' }} />
                  </label>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, flex: 1, minWidth: 0 }}>
                <input className="input-base" placeholder={t('audiobook.meta_title')}
                  value={meta.title} onChange={setMetaField('title')} aria-label={t('audiobook.meta_title')} />
                <input className="input-base" placeholder={t('audiobook.meta_author')}
                  value={meta.author} onChange={setMetaField('author')} aria-label={t('audiobook.meta_author')} />
                <input className="input-base" placeholder={t('audiobook.meta_narrator')}
                  value={meta.narrator} onChange={setMetaField('narrator')} aria-label={t('audiobook.meta_narrator')} />
                <input className="input-base" placeholder={t('audiobook.meta_year')}
                  value={meta.year} onChange={setMetaField('year')} aria-label={t('audiobook.meta_year')} />
                <input className="input-base" placeholder={t('audiobook.meta_genre')}
                  value={meta.genre} onChange={setMetaField('genre')} aria-label={t('audiobook.meta_genre')} />
                <input className="input-base" placeholder={t('audiobook.meta_description')}
                  value={meta.description} onChange={setMetaField('description')}
                  aria-label={t('audiobook.meta_description')} style={{ gridColumn: '1 / -1' }} />
              </div>
            </div>
          </div>

          {/* Pronunciation lexicon */}
          <div className="audiobook-tab__field">
            <label className="field-label">{t('audiobook.lexicon')}</label>
            {lex.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input className="input-base" placeholder={t('audiobook.lex_word')}
                  value={row.word} onChange={setLexRow(i, 'word')} aria-label={t('audiobook.lex_word')} style={{ flex: 1, minWidth: 0 }} />
                <input className="input-base" placeholder={t('audiobook.lex_say')}
                  value={row.say} onChange={setLexRow(i, 'say')} aria-label={t('audiobook.lex_say')} style={{ flex: 1, minWidth: 0 }} />
                <button type="button" className="ui-btn ui-btn--icon" onClick={() => removeLexRow(i)}
                  aria-label={t('audiobook.lex_remove')}><X size={14} /></button>
              </div>
            ))}
            <button type="button" className="ui-btn ui-btn--subtle" onClick={addLexRow} style={{ alignSelf: 'flex-start' }}>
              <Plus size={14} /> {t('audiobook.lex_add')}
            </button>
          </div>

          {/* Markup quick reference */}
          <details className="audiobook-tab__field">
            <summary className="field-label" style={{ cursor: 'pointer' }}>{t('audiobook.markup_help')}</summary>
            <p className="muted" style={{ fontSize: '0.72rem', lineHeight: 1.6, marginTop: 6 }}>
              {t('audiobook.markup_hint')}
            </p>
          </details>

          {error && <div className="error-banner" role="alert">{error}</div>}

          {generating && progress && (
            <div className="audiobook-progress" role="status" aria-live="polite">
              {progress.assembling
                ? t('audiobook.assembling')
                : t('audiobook.synthesizing', {
                    current: progress.current, total: progress.total, title: progress.title || '',
                  })}
            </div>
          )}

          {output && (
            <div className="audiobook-done">
              <div style={{ marginBottom: 8 }}>✅ {t('audiobook.ready')}</div>
              {done && done.failed_chapters.length > 0 && (
                <div className="muted" style={{ marginBottom: 8 }}>
                  {t('audiobook.failed_note', { count: done.failed_chapters.length })}
                </div>
              )}
              {done && done.cached_chapters > 0 && (
                <div className="muted" style={{ marginBottom: 8 }}>
                  {t('audiobook.cached_note', { count: done.cached_chapters })}
                </div>
              )}
              <audio controls src={audioUrl(output)} style={{ width: '100%' }} />
              <div style={{ marginTop: 8 }}>
                <a className="ui-btn ui-btn--subtle" href={audioUrl(output)} download={output}>
                  <Download size={14} /> {t('audiobook.download')}
                </a>
              </div>
            </div>
          )}

          {plan && (
            <div className="audiobook-plan">
              <h3>{t('audiobook.plan_heading', { count: plan.chapter_count })}</h3>
              <ol style={{ paddingLeft: 18, margin: 0 }}>
                {plan.chapters.map((c, i) => {
                  const prev = chapterPrev[i] || {};
                  return (
                    <li key={i} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button className="ui-btn ui-btn--icon" onClick={() => onPreviewChapter(i)}
                          disabled={prev.loading || busy}
                          aria-label={t('audiobook.preview_chapter', { title: c.title })}>
                          {prev.loading ? <Loader size={12} className="spin" /> : <Play size={12} />}
                        </button>
                        <strong>{c.title}</strong>{' '}
                        <span className="muted">
                          {t('audiobook.chapter_meta', { spans: c.spans.length, chars: c.char_count })}
                        </span>
                      </div>
                      {prev.url && (<audio controls src={prev.url} style={{ width: '100%', marginTop: 4 }} />)}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
