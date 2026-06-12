import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookMarked, Loader, Download } from 'lucide-react';

import { audiobookPlan, audiobookGenerate } from '../api/audiobook';
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
  const abortRef = useRef(false);

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

  const onCreate = useCallback(async () => {
    setError('');
    setOutput('');
    setProgress({ current: 0, total: 0 });
    setGenerating(true);
    abortRef.current = false;
    try {
      const res = await audiobookGenerate({ text, default_voice: defaultVoice || null });
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
          } else if (evt.type === 'done') {
            setOutput(evt.output);
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
  }, [text, defaultVoice]);

  const busy = planLoading || generating;
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

        <button className="btn" onClick={onPreview} disabled={!canRun}>
          {planLoading ? <Loader size={14} className="spin" /> : null} {t('audiobook.preview_plan')}
        </button>
        <button className="btn btn-primary" onClick={onCreate} disabled={!canRun}>
          {generating ? <Loader size={14} className="spin" /> : null} {t('audiobook.create')}
        </button>
      </div>

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
            {plan.chapters.map((c, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <strong>{c.title}</strong>{' '}
                <span className="muted">
                  {t('audiobook.chapter_meta', { spans: c.spans.length, chars: c.char_count })}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
