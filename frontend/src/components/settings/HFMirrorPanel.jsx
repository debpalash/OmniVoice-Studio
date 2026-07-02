/**
 * Settings → Models tab → Hugging Face mirror panel (Wave 4.3).
 *
 * Restricted-network users (e.g. behind the Great Firewall) point
 * huggingface_hub at a mirror via HF_ENDPOINT. HF reads it at import time, so
 * the change applies after a restart. Persisted to the durable per-user env.
 *
 * Endpoints (loopback-only):
 *   GET /api/settings/hf-mirror → {configured, effective, presets}
 *   PUT /api/settings/hf-mirror  body {url}  (empty url clears → official)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiJson, apiFetch } from '../../api/client';
import { SettingsSection, SettingRow, SettingsInput } from './primitives';
import { Button } from '../../ui';
import RestartBadge from './RestartBadge';

export default function HFMirrorPanel() {
  const { t } = useTranslation();
  const [state, setState] = useState(null);
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [restart, setRestart] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const d = await apiJson('/api/settings/hf-mirror');
      setState(d);
      setUrl(d?.configured || '');
    } catch (e) {
      setError(e?.message || t('models.mirror_load_error'));
    }
  }, [t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async (value) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/settings/hf-mirror', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value }),
      });
      const d = await res.json();
      setUrl(d.configured || '');
      setRestart(Boolean(d.restart_required));
      refresh();
    } catch (e) {
      setError(e?.message || t('models.mirror_save_error'));
    } finally {
      setSaving(false);
    }
  };

  if (!state) return null;

  return (
    <SettingsSection
      icon={Globe}
      title={t('models.mirror_title')}
      description={t('models.mirror_description')}
      actions={<RestartBadge />}
    >
      {error && (
        <div className="perfpanel__error" role="alert">
          {error}
        </div>
      )}

      <SettingRow
        stack
        title={t('models.mirror_preset_title')}
        hint={t('models.mirror_preset_hint')}
        control={
          <div className="flex flex-wrap items-center gap-[6px] min-w-0 max-w-full">
            {state.presets.map((p) => (
              <Button
                variant="preset"
                key={p.label}
                onClick={() => save(p.url)}
                disabled={saving}
                data-testid={`hf-preset-${p.url || 'official'}`}
              >
                {p.label}
              </Button>
            ))}
          </div>
        }
      />

      <SettingRow
        stack
        title="HF_ENDPOINT"
        subtitle={restart ? t('models.mirror_restart_note') : undefined}
        control={
          <>
            <SettingsInput
              mono
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hf-mirror.com"
              data-testid="hf-mirror-url"
            />
            <Button
              variant="subtle"
              size="sm"
              onClick={() => save(url)}
              loading={saving}
              disabled={saving}
              data-testid="hf-mirror-save"
            >
              {t('common.save')}
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}
