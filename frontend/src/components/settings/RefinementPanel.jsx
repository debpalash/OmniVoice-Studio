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
import { useAppStore } from '../../store';
import { refineFailureNote } from './refineStatus';
import { SettingsSection, SettingRow, SettingsToggle } from './primitives';

const FLAG_ROWS = [
  [
    'auto',
    'Refine dictation with the local LLM',
    'Master switch — applied to final transcripts only, never live partials. The raw transcript is always kept in History.',
  ],
  [
    'smart_cleanup',
    'Remove filler words & add punctuation',
    '"so um like the meeting is at 3pm you know" → "So the meeting is at 3pm."',
  ],
  [
    'self_correction',
    'Apply spoken self-corrections',
    '"at seven no actually six am" → "at six am"',
  ],
  [
    'preserve_technical',
    'Preserve technical terms & spoken symbols',
    '"index dot tsx" → "index.tsx"; identifiers stay verbatim',
  ],
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

  useEffect(() => {
    refresh();
  }, [refresh]);

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
  const failureNote = refineFailureNote(cfg.last_refine_status);

  return (
    <SettingsSection
      icon={Wand2}
      title="Dictation refinement"
      description={
        llmReady
          ? undefined
          : 'Needs a local LLM endpoint — until then, raw transcripts paste unchanged.'
      }
    >
      {error && (
        <div className="perfpanel__error" role="alert">
          {error}
        </div>
      )}

      {failureNote && (
        <div className="perfpanel__error" role="status">
          {failureNote}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => useAppStore.getState().openSettingsTab('llm-providers')}
          >
            Open LLM Providers
          </button>
        </div>
      )}

      {FLAG_ROWS.map(([key, label, help]) => (
        <SettingRow
          key={key}
          title={label}
          subtitle={key === 'auto' && !llmReady ? 'no LLM configured' : undefined}
          hint={help}
          control={
            <SettingsToggle
              checked={Boolean(cfg[key])}
              onChange={(next) => onToggle(key, next)}
              disabled={saving || (key !== 'auto' && !cfg.auto)}
              aria-label={label}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}
