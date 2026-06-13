import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookMarked, Loader, Download, Image as ImageIcon, X, Play, Upload } from 'lucide-react';

import {
  audiobookPlan, audiobookGenerate, audiobookUploadCover, audiobookPreviewChapter, audiobookImport,
} from '../api/audiobook';
import { audioUrl } from '../api/generate';
import { splitSSEBuffer, parseSSELine } from '../utils/sseParse';

/**
 * AudiobookTab — turn a chapter-delimited script into a chapterized m4b.
 *
 * Markdown `# H1` headings delimit chapters; inline `[voice:NAME]` and
 * `[pause …]` are honoured by the backend parser. "Preview plan" shows the
 * parsed chapters; "Create" streams synthesis progress and offers the m4b.
 */
export default function AudiobookTab({ profiles = [] }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [defaultVoice, setDefaultVoice] = useState('');
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null); // {current,total,title,assembling}
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // {cached_chapters, failed_chapters}
  const [chapterPrev, setChapterPrev] = useState({}); // index → {url, loading}
  const abortRef = useRef(false);

  // Output + metadata (embedded in the file; players show these).
  const [format, setFormat] = useState('m4b');      // 'm4b' | 'mp3'
  const [loudness, setLoudness] = useState('off');  // 'off' | 'acx' | 'podcast'
  const [meta, setMeta] = useState({
    title: '', author: '', narrator: '', year: '', genre: '', description: '',
  });
  const [coverFile, setCoverFile] = useState(null);
  const [coverPreview, setCoverPreview] = useState('');
  const setMetaField = (k) => (e) => setMeta((m) => ({ ...m, [k]: e.target.value }));

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
      const r = await audiobookPreviewChapter({ text, chapter_index: i, default_voice: defaultVoice || null });
      setChapterPrev((p) => ({ ...p, [i]: { url: audioUrl(r.output), loading: false } }));
    } catch (e) {
      setChapterPrev((p) => ({ ...p, [i]: { ...(p[i] || {}), loading: false } }));
      setError(e?.message || String(e));
    }
  }, [text, defaultVoice]);

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
      const res = await audiobookGenerate({
        text,
        default_voice: defaultVoice || null,
        format,
        loudness: loudness === 'off' ? null : loudness,
        cover_path,
        metadata: Object.keys(metadata).length ? metadata : null,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!abortRef.current) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { lines, rest } = splitSSEBuffer(buffer);
        buffer = rest;
        for (const line of lines) {
          const evt = parseSSELine(line);
          if (!evt) continue;
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
        }
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setGenerating(false);
    }
  }, [text, defaultVoice, format, loudness, coverFile, meta]);

  const busy = planLoading || generating || importing;
  const canRun = text.trim().length > 0 && !busy;

  return (
    <div className="audiobook-tab" style={{ maxWidth: 860, margin: '0 auto', padding: '1.5rem' }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <BookMarked size={20} /> {t('audiobook.title')}
      </h2>
      <p className="muted">{t('audiobook.subtitle')}</p>

      <label className="field-label">{t('audiobook.script')}</label>
      <textarea
        className="input-base"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('audiobook.script_placeholder')}
        rows={14}
        style={{ width: '100%', fontFamily: 'monospace' }}
        aria-label={t('audiobook.script')}
      />

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}>
        <label className="field-label" style={{ margin: 0 }}>{t('audiobook.default_voice')}</label>
        <select
          className="input-base"
          value={defaultVoice}
          onChange={(e) => setDefaultVoice(e.target.value)}
          aria-label={t('audiobook.default_voice')}
        >
          <option value="">{t('audiobook.engine_default')}</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <select
          className="input-base"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          aria-label={t('audiobook.format')}
        >
          <option value="m4b">{t('audiobook.format_m4b')}</option>
          <option value="mp3">{t('audiobook.format_mp3')}</option>
        </select>
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

        <label className="btn" style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {importing ? <Loader size={14} className="spin" /> : <Upload size={14} />} {t('audiobook.import')}
          <input
            type="file"
            accept=".txt,.md,.epub"
            onChange={onImport}
            disabled={busy}
            style={{ display: 'none' }}
          />
        </label>
        <button className="btn" onClick={onPreview} disabled={!canRun}>
          {planLoading ? <Loader size={14} className="spin" /> : null} {t('audiobook.preview_plan')}
        </button>
        <button className="btn btn-primary" onClick={onCreate} disabled={!canRun}>
          {generating ? <Loader size={14} className="spin" /> : null} {t('audiobook.create')}
        </button>
      </div>

      <details className="audiobook-meta" style={{ margin: '8px 0 12px' }}>
        <summary className="field-label" style={{ cursor: 'pointer' }}>
          {t('audiobook.details')}
        </summary>
        <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
          {/* Cover picker */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="field-label" style={{ margin: 0 }}>{t('audiobook.cover')}</label>
            <div style={{ position: 'relative', width: 120, height: 120 }}>
              {coverPreview ? (
                <>
                  <img
                    src={coverPreview}
                    alt={t('audiobook.cover')}
                    style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 6 }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={clearCover}
                    aria-label={t('audiobook.cover_remove')}
                    style={{ position: 'absolute', top: 4, right: 4, padding: 2 }}
                  >
                    <X size={14} />
                  </button>
                </>
              ) : (
                <label
                  className="input-base"
                  style={{
                    width: 120, height: 120, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer',
                  }}
                >
                  <ImageIcon size={22} />
                  <span style={{ fontSize: '0.7rem' }}>{t('audiobook.cover_add')}</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={onCoverPick}
                    style={{ display: 'none' }}
                  />
                </label>
              )}
            </div>
          </div>
          {/* Metadata fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, flex: 1, minWidth: 280 }}>
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
              value={meta.description} onChange={setMetaField('description')} aria-label={t('audiobook.meta_description')}
              style={{ gridColumn: '1 / -1' }} />
          </div>
        </div>
      </details>

      {error && <div className="error-banner" role="alert">{error}</div>}

      {generating && progress && (
        <div className="audiobook-progress" role="status" aria-live="polite">
          {progress.assembling
            ? t('audiobook.assembling')
            : t('audiobook.synthesizing', {
                current: progress.current, total: progress.total,
                title: progress.title || '',
              })}
        </div>
      )}

      {output && (
        <div className="audiobook-done" style={{ margin: '16px 0' }}>
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
            <a className="btn" href={audioUrl(output)} download={output}>
              <Download size={14} /> {t('audiobook.download')}
            </a>
          </div>
        </div>
      )}

      {plan && (
        <div className="audiobook-plan" style={{ marginTop: 16 }}>
          <h3>{t('audiobook.plan_heading', { count: plan.chapter_count })}</h3>
          <ol>
            {plan.chapters.map((c, i) => {
              const prev = chapterPrev[i] || {};
              return (
                <li key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      className="btn"
                      onClick={() => onPreviewChapter(i)}
                      disabled={prev.loading || busy}
                      aria-label={t('audiobook.preview_chapter', { title: c.title })}
                      style={{ padding: '2px 6px' }}
                    >
                      {prev.loading ? <Loader size={12} className="spin" /> : <Play size={12} />}
                    </button>
                    <strong>{c.title}</strong>{' '}
                    <span className="muted">
                      {t('audiobook.chapter_meta', { spans: c.spans.length, chars: c.char_count })}
                    </span>
                  </div>
                  {prev.url && (
                    <audio controls src={prev.url} style={{ width: '100%', marginTop: 4 }} />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
