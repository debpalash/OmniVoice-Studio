/**
 * Settings → Models tab → Models directory panel (#64).
 *
 * Lets the user choose where model weights download (the HuggingFace / Torch
 * cache). The backend persists it to the durable per-user env file as
 * OMNIVOICE_CACHE_DIR, which main.py maps to HF_HOME / HF_HUB_CACHE / TORCH_HOME
 * on the next launch — so changes apply after a restart.
 *
 * Endpoints:
 *   GET /api/settings/storage/models-dir
 *     → {configured, effective, default, restart_required}
 *   PUT /api/settings/storage/models-dir  body {path}  (empty path clears)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiJson, apiFetch } from '../../api/client';
import { SettingsSection, SettingRow, InfoHint } from './primitives';

export default function StoragePanel() {
  const [configured, setConfigured] = useState('');
  const [effective, setEffective] = useState('');
  const [def, setDef] = useState('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [restart, setRestart] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await apiJson('/api/settings/storage/models-dir');
      setConfigured(d?.configured || '');
      setEffective(d?.effective || '');
      setDef(d?.default || '');
      setInput(d?.configured || '');
    } catch (e) {
      setError(e?.message || 'Failed to load storage settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async (path) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/settings/storage/models-dir', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.detail || `HTTP ${res.status}`);
      }
      const b = await res.json();
      setConfigured(b?.configured || '');
      setRestart(Boolean(b?.restart_required));
      toast.success(
        path
          ? 'Models directory saved — restart to apply'
          : 'Reverted to default — restart to apply',
      );
      refresh();
    } catch (e) {
      setError(e?.message || 'Failed to save models directory');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      className="storagepanel"
      icon={HardDrive}
      title="Models directory"
      actions={
        <InfoHint label="Models directory">
          Where model weights download (the HuggingFace / Torch cache). Point this at a larger or
          faster drive — useful when your system drive is small. Changes apply on the next restart.
        </InfoHint>
      }
    >
      {error && (
        <div
          className="mb-[var(--space-3)] text-[length:var(--text-base)] text-[var(--chrome-severity-err)]"
          role="alert"
        >
          {error}
        </div>
      )}

      <SettingRow
        className="st-row--stack"
        align="start"
        title="Cache location"
        subtitle="Where model weights download"
        control={
          <div className="flex w-full flex-wrap items-center gap-[var(--space-3)]">
            <input
              className="box-border min-w-0 max-w-[520px] flex-[1_1_280px] rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-border)] bg-[var(--chrome-input-bg)] px-[var(--space-3)] py-[var(--space-2)] font-[family-name:var(--chrome-font-mono)] text-[length:var(--text-base)] text-[var(--chrome-fg)] placeholder:text-[var(--chrome-fg-dim)] focus-visible:border-[var(--chrome-accent)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
              type="text"
              value={input}
              placeholder={def || '~/.cache/huggingface'}
              onChange={(e) => setInput(e.target.value)}
              disabled={saving || loading}
              spellCheck={false}
              aria-label="Models directory"
              data-testid="models-dir-input"
            />
            <button
              className="flex-none cursor-pointer rounded-[var(--chrome-radius-pill)] [border:1px_solid_transparent] bg-[var(--chrome-accent)] px-[var(--space-4)] py-[var(--space-2)] font-sans text-[length:var(--text-base)] text-[var(--chrome-bg)] disabled:cursor-default disabled:opacity-50"
              onClick={() => save(input.trim())}
              disabled={saving || loading}
              data-testid="models-dir-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              className="flex-none cursor-pointer rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-border)] bg-transparent px-[var(--space-4)] py-[var(--space-2)] font-sans text-[length:var(--text-base)] text-[var(--chrome-fg-muted)] hover:enabled:bg-[var(--chrome-hover-bg)] hover:enabled:text-[var(--chrome-fg)] disabled:cursor-default disabled:opacity-50"
              onClick={() => {
                setInput('');
                save('');
              }}
              disabled={saving || loading || !configured}
              title="Revert to the default cache location"
            >
              Reset
            </button>
          </div>
        }
      />

      <SettingRow title="Effective now" control={<>{effective || '…'}</>} mono />

      <SettingRow title="Configured" control={<>{configured || 'using default'}</>} mono />

      {restart && (
        <p className="mx-0 mb-0 mt-[var(--space-3)] text-[length:var(--text-base)] text-[var(--chrome-severity-warn)]">
          ↻ Restart OmniVoice to use the new location.
        </p>
      )}
    </SettingsSection>
  );
}
