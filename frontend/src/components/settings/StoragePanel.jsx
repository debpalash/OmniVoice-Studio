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
import './StoragePanel.css';

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

  useEffect(() => { refresh(); }, [refresh]);

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
      toast.success(path ? 'Models directory saved — restart to apply' : 'Reverted to default — restart to apply');
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
          Where model weights download (the HuggingFace / Torch cache). Point this
          at a larger or faster drive — useful when your system drive is small.
          Changes apply on the next restart.
        </InfoHint>
      }
    >
      {error && <div className="storagepanel__error" role="alert">{error}</div>}

      <SettingRow
        className="st-row--stack"
        align="start"
        title="Cache location"
        subtitle="Where model weights download"
        control={
          <div className="storagepanel__field">
            <input
              className="storagepanel__input"
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
              className="storagepanel__btn"
              onClick={() => save(input.trim())}
              disabled={saving || loading}
              data-testid="models-dir-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              className="storagepanel__btn storagepanel__btn--ghost"
              onClick={() => { setInput(''); save(''); }}
              disabled={saving || loading || !configured}
              title="Revert to the default cache location"
            >
              Reset
            </button>
          </div>
        }
      />

      <SettingRow
        title="Effective now"
        control={<>{effective || '…'}</>}
        mono
      />

      <SettingRow
        title="Configured"
        control={<>{configured || 'using default'}</>}
        mono
      />

      {restart && (
        <p className="storagepanel__restart">↻ Restart OmniVoice to use the new location.</p>
      )}
    </SettingsSection>
  );
}
