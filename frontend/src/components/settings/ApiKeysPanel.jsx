/**
 * Settings → API Keys panel (Wave 2 AUTH-03 UI half).
 *
 * Consumes the Wave 1 resolver state endpoint at
 *   GET    /api/settings/hf-token/state
 *   POST   /api/settings/hf-token
 *   DELETE /api/settings/hf-token?also_clear_hf_cli={bool}
 *
 * Renders one row per source (App / Env / HF CLI) with set/unset indicator,
 * masked token preview, whoami username + green check on success, and an
 * "Active" badge on whichever row is currently serving the cascade.
 *
 * Threat T-02-02: the panel never displays the full token. The masked
 * value comes from the resolver state endpoint; the full token only
 * crosses the IPC boundary on Save (POST) and is cleared from local
 * state on success.
 *
 * Note: the GET + POST go through `apiJson` / `apiPost` from
 * `../../api/client` (the canonical base-URL site). The DELETE uses raw
 * fetch with the same `API` base so query params can be appended cleanly.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, KeyRound, RefreshCw, Save, Trash2, XCircle } from 'lucide-react';
import { apiJson, apiPost, apiFetch, API } from '../../api/client';
import { SettingsSection, InfoHint } from './primitives';
import './ApiKeysPanel.css';

const SOURCE_LABELS = {
  app: 'OmniVoice (encrypted, recommended)',
  env: 'Environment variable',
  'hf-cli': 'HuggingFace CLI',
};

const SOURCE_HELP = {
  app: "Stored encrypted in OmniVoice's local SQLite store. Set or clear here.",
  env: 'Set via HF_TOKEN in your shell. Read-only from the UI.',
  'hf-cli': 'Written by `huggingface-cli login`. Read-only from the UI.',
};

const EMPTY_STATE = {
  sources: [
    { source: 'app', set: false, masked: null, whoami_user: null, whoami_ok: false },
    { source: 'env', set: false, masked: null, whoami_user: null, whoami_ok: false },
    { source: 'hf-cli', set: false, masked: null, whoami_user: null, whoami_ok: false },
  ],
  active: null,
};

export default function ApiKeysPanel() {
  const { t } = useTranslation();
  const [state, setState] = useState(EMPTY_STATE);
  const [loading, setLoading] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [alsoClearCli, setAlsoClearCli] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson('/api/settings/hf-token/state');
      setState(data);
    } catch (e) {
      setError(e?.message || 'Failed to load token state');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSave = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setSaving(true);
    setError(null);
    try {
      await apiPost('/api/settings/hf-token', { token });
      setTokenInput('');
      await refresh();
    } catch (e) {
      setError(e?.message || 'Failed to save token');
    } finally {
      setSaving(false);
    }
  };

  const onClear = async () => {
    setSaving(true);
    setError(null);
    try {
      const qs = alsoClearCli ? '?also_clear_hf_cli=true' : '';
      const url = `${API}/api/settings/hf-token${qs}`;
      await apiFetch(url, { method: 'DELETE' });
      setClearOpen(false);
      setAlsoClearCli(false);
      await refresh();
    } catch (e) {
      setError(e?.message || 'Failed to clear token');
    } finally {
      setSaving(false);
    }
  };

  const testNowLabel = t('settings.hf_token_test_now', { defaultValue: 'Test now' });

  return (
    <SettingsSection
      className="apikeys-panel"
      icon={KeyRound}
      title="HuggingFace token"
      description="Resolved across three sources in priority order — App, Env, HF CLI."
      actions={
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-border)] bg-transparent px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--chrome-fg)] hover:enabled:bg-[var(--chrome-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={refresh}
          disabled={loading}
          aria-label={testNowLabel}
          title={t('settings.hf_token_test_now_title', {
            defaultValue: 'Re-run whoami for every source',
          })}
        >
          <RefreshCw size={12} /> {testNowLabel}
        </button>
      }
    >
      {error && (
        <div
          className="mb-[var(--space-4)] rounded-[var(--chrome-radius-pill)] [border:1px_solid_color-mix(in_srgb,var(--chrome-severity-err)_35%,transparent)] bg-[color-mix(in_srgb,var(--chrome-severity-err)_12%,transparent)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--chrome-severity-err)]"
          role="alert"
        >
          {error}
        </div>
      )}

      <div
        className="flex flex-col gap-[var(--space-3)]"
        role="table"
        aria-label={t('settings.hf_token_sources', { defaultValue: 'HF token sources' })}
      >
        {state.sources.map((row) => {
          const isActive = state.active === row.source;
          return (
            <div
              key={row.source}
              className={`apikeys-row ${isActive ? 'apikeys-row--active' : ''}`}
              role="row"
              data-source={row.source}
            >
              <div className="flex items-center justify-between gap-[var(--space-3)]">
                <span className="inline-flex items-center gap-[var(--space-2)] text-[length:var(--text-md)] font-medium text-[var(--chrome-fg)]">
                  {SOURCE_LABELS[row.source]}
                  <InfoHint>{SOURCE_HELP[row.source]}</InfoHint>
                </span>
                {isActive && <span className="apikeys-badge apikeys-badge--active">Active</span>}
              </div>
              <div className="flex flex-wrap items-center gap-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--chrome-fg-muted)]">
                {row.set ? (
                  <>
                    <span
                      className="inline-flex items-center gap-[4px] text-[var(--chrome-severity-ok)]"
                      aria-label="set"
                    >
                      <CheckCircle2 size={12} /> set
                    </span>
                    {row.masked && (
                      <code className="rounded-[4px] bg-[var(--chrome-hover-bg)] px-[6px] py-[1px] font-mono text-[length:var(--text-xs)]">
                        {row.masked}
                      </code>
                    )}
                    {row.whoami_ok ? (
                      <span className="inline-flex items-center gap-[4px] text-[var(--chrome-severity-ok)]">
                        <CheckCircle2 size={12} /> {row.whoami_user || 'verified'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-[4px] text-[var(--chrome-severity-err)]">
                        <XCircle size={12} /> whoami failed
                      </span>
                    )}
                  </>
                ) : (
                  <span className="inline-flex items-center gap-[4px] text-[var(--chrome-severity-warn)]">
                    <XCircle size={12} /> not set
                  </span>
                )}
              </div>
              {row.source === 'app' && (
                <div className="mt-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-3)]">
                  <input
                    type="password"
                    className="box-border min-w-0 max-w-full flex-[1_1_220px] rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-border)] bg-[var(--chrome-hover-bg)] px-[var(--space-3)] py-[var(--space-2)] font-mono text-[length:var(--text-sm)] text-[var(--chrome-fg)] focus:border-[var(--chrome-accent)] focus:outline-none"
                    placeholder="hf_…"
                    aria-label={t('settings.hf_token_input', { defaultValue: 'HuggingFace token' })}
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onSave();
                    }}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-accent)] bg-[color-mix(in_srgb,var(--chrome-accent)_25%,var(--chrome-bg))] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--chrome-fg)] hover:enabled:bg-[var(--chrome-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={onSave}
                    disabled={!tokenInput.trim() || saving}
                  >
                    <Save size={12} /> Save
                  </button>
                  {row.set && (
                    <button
                      type="button"
                      className="inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--chrome-radius-pill)] [border:1px_solid_color-mix(in_srgb,var(--chrome-severity-err)_35%,var(--chrome-border))] bg-[var(--chrome-bg)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--chrome-severity-err)] hover:enabled:bg-[var(--chrome-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => setClearOpen(true)}
                      disabled={saving}
                    >
                      <Trash2 size={12} /> Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {clearOpen && (
        <div
          className="mt-[var(--space-3)] flex flex-col gap-[var(--space-3)] rounded-[var(--chrome-radius-pill)] [border:1px_solid_color-mix(in_srgb,var(--chrome-severity-err)_35%,var(--chrome-border))] bg-[color-mix(in_srgb,var(--chrome-severity-err)_6%,var(--chrome-bg))] px-[var(--space-4)] py-[var(--space-4)]"
          role="dialog"
          aria-label={t('settings.hf_token_clear_dialog', { defaultValue: 'Clear token' })}
        >
          <p className="m-0 text-[length:var(--text-md)]">
            {t('settings.hf_token_clear_confirm', {
              defaultValue: 'Clear the App-source HuggingFace token?',
            })}
          </p>
          <label className="inline-flex items-center gap-[5px] text-[length:var(--text-sm)] text-[var(--chrome-fg-muted)]">
            <input
              type="checkbox"
              checked={alsoClearCli}
              onChange={(e) => setAlsoClearCli(e.target.checked)}
            />{' '}
            {t('settings.hf_token_also_clear', { defaultValue: 'Also clear' })}{' '}
            <code>~/.cache/huggingface/token</code>
          </label>
          <div className="flex justify-end gap-[var(--space-3)]">
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-border)] bg-transparent px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--chrome-fg)] hover:enabled:bg-[var(--chrome-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                setClearOpen(false);
                setAlsoClearCli(false);
              }}
            >
              {t('settings.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-[5px] rounded-[var(--chrome-radius-pill)] [border:1px_solid_color-mix(in_srgb,var(--chrome-severity-err)_35%,var(--chrome-border))] bg-[var(--chrome-bg)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--chrome-severity-err)] hover:enabled:bg-[var(--chrome-hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onClear}
              disabled={saving}
            >
              <Trash2 size={12} />{' '}
              {t('settings.hf_token_clear_btn', { defaultValue: 'Clear token' })}
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
