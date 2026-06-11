/**
 * Settings → Capture → Dictation refinement panel (parity program Wave 2.1).
 *
 * Toggles the optional local-LLM cleanup of dictation finals: filler-word
 * removal, self-correction collapse, technical-term preservation. The
 * backend only runs refinement when an LLM backend is configured
 * (Settings → Credentials / TRANSLATE_BASE_URL) — without one, dictation
 * behaves exactly as before on every platform.
 *
 * Endpoints (loopback-only):
 *   GET /api/settings/dictation-refinement
 *     → {auto, smart_cleanup, self_correction, preserve_technical, llm_ready}
 *   PUT /api/settings/dictation-refinement  body: partial of the above flags
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Wand2 } from 'lucide-react';
import { apiJson, apiFetch } from '../../api/client';
import './PerformancePanel.css';

const FLAG_ROWS = [
  ['auto', 'Refine dictation with the local LLM', 'Master switch — applied to final transcripts only, never live partials. The raw transcript is always kept in History.'],
  ['smart_cleanup', 'Remove filler words & add punctuation', '"so um like the meeting is at 3pm you know" → "So the meeting is at 3pm."'],
  ['self_correction', 'Apply spoken self-corrections', '"at seven no actually six am" → "at six am"'],
  ['preserve_technical', 'Preserve technical terms & spoken symbols', '"index dot tsx" → "index.tsx"; identifiers stay verbatim'],
];

export default function RefinementPanel() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setCfg(await apiJson('/api/settings/dictation-refinement'));
    } catch (e) {
      setError(e?.message || 'Failed to load refinement settings');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onToggle = async (key, next) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/settings/dictation-refinement', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next }),
      });
      setCfg(await res.json());
    } catch (err) {
      setError(err?.message || 'Failed to save setting');
      refresh();
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) return null;
  const llmReady = Boolean(cfg.llm_ready);

  return (
    <section className="perfpanel" aria-labelledby="refinepanel-heading">
      <h3 id="refinepanel-heading" className="perfpanel__title">
        <Wand2 size={14} /> Dictation refinement
      </h3>

      {error && <div className="perfpanel__error" role="alert">{error}</div>}

      {!llmReady && (
        <p className="perfpanel__help">
          Needs a local LLM endpoint (Ollama, LM Studio, or any
          OpenAI-compatible server). Until one is configured, dictation
          pastes the raw transcript unchanged.
        </p>
      )}

      {FLAG_ROWS.map(([key, label, help]) => (
        <label className="perfpanel__row" key={key} title={help}>
          <input
            type="checkbox"
            className="perfpanel__checkbox"
            checked={Boolean(cfg[key])}
            onChange={(e) => onToggle(key, e.target.checked)}
            disabled={saving || (key !== 'auto' && !cfg.auto)}
            data-testid={`refine-${key}`}
          />
          <span className="perfpanel__label">{label}</span>
          {key === 'auto' && !llmReady && (
            <span className="perfpanel__badge">no LLM configured</span>
          )}
        </label>
      ))}
    </section>
  );
}
