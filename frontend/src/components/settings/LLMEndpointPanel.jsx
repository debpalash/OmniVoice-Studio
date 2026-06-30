/**
 * Settings → Credentials → LLM endpoint panel (parity program Wave 2.4).
 *
 * Configure the OpenAI-compatible LLM that powers cinematic translate,
 * glossary auto-extract, and dictation refinement (Wave 2.1). Works with
 * Ollama (no key), LM Studio, vLLM, or hosted OpenAI-compatible servers.
 *
 * Endpoints (loopback-only):
 *   GET /api/settings/llm-endpoint
 *     → {base_url, model, api_key_masked, available, reason}
 *   PUT /api/settings/llm-endpoint  body: {base_url?, model?, api_key?}
 *     (null field = unchanged; "" = clear). Persists via the existing
 *     TRANSLATE_* env vars, restored on restart.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Brain, CheckCircle2, XCircle } from 'lucide-react';
import { apiJson, apiFetch } from '../../api/client';
import { SettingsSection, SettingRow } from './primitives';
import './PerformancePanel.css';

const PRESETS = [
  ['Ollama', 'http://localhost:11434/v1', 'llama3.1'],
  ['LM Studio', 'http://localhost:1234/v1', 'local-model'],
  ['vLLM', 'http://localhost:8000/v1', ''],
  ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
];

export default function LLMEndpointPanel() {
  const [state, setState] = useState(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState(''); // '' until user types; we never echo the stored key
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const data = await apiJson('/api/settings/llm-endpoint');
      setState(data);
      setBaseUrl(data.base_url || '');
      setModel(data.model || '');
    } catch (e) {
      setError(e?.message || 'Failed to load LLM endpoint settings');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { base_url: baseUrl.trim(), model: model.trim() };
      // Only send the key when the user typed one — an untouched field
      // leaves the stored value alone (null = unchanged on the backend).
      if (apiKey) body.api_key = apiKey;
      const res = await apiFetch('/api/settings/llm-endpoint', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setState(await res.json());
      setApiKey('');
    } catch (e) {
      setError(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = ([, url, m]) => {
    setBaseUrl(url);
    setModel(m);
  };

  if (!state) return null;

  return (
    <SettingsSection
      icon={Brain}
      title="LLM endpoint"
      description="Powers cinematic translate, glossary extract, and dictation refinement."
    >
      <SettingRow
        title="Preset"
        hint="Powers cinematic translation, glossary auto-extract, and dictation refinement. Any OpenAI-compatible server: Ollama, LM Studio, vLLM, or a hosted API. Stays opt-in — features only call it when you enable them."
        control={
          <div className="perfpanel__row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p[0]}
                onClick={() => applyPreset(p)}
                data-testid={`llm-preset-${p[0]}`}
              >
                {p[0]}
              </button>
            ))}
          </div>
        }
      />

      <SettingRow
        title="Base URL"
        control={
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
            style={{ flex: 1, minWidth: 200 }}
            data-testid="llm-base-url"
          />
        }
      />
      <SettingRow
        title="Model"
        control={
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="llama3.1"
            style={{ flex: 1, minWidth: 200 }}
            data-testid="llm-model"
          />
        }
      />
      <SettingRow
        title="API key"
        control={
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              state.api_key_masked
                ? `stored (${state.api_key_masked}) — type to replace`
                : 'optional (Ollama needs none)'
            }
            style={{ flex: 1, minWidth: 200 }}
            data-testid="llm-api-key"
          />
        }
      />

      {error && (
        <div className="perfpanel__error" role="alert">
          {error}
        </div>
      )}

      <SettingRow
        title="Connection"
        control={
          <>
            <button type="button" onClick={onSave} disabled={saving} data-testid="llm-save">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <span className="perfpanel__badge" role="status">
              {state.available ? (
                <>
                  <CheckCircle2 size={11} /> reachable
                </>
              ) : (
                <>
                  <XCircle size={11} /> {state.reason || 'not configured'}
                </>
              )}
            </span>
          </>
        }
      />
    </SettingsSection>
  );
}
