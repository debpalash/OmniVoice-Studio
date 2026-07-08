/**
 * Settings → Models tab → OpenAI-compatible remote ASR panel (#877).
 *
 * A path to Qwen3-ASR, a self-hosted FunASR/SenseVoice server, or OpenAI's
 * own Whisper API — today, without waiting on transformers to ship a direct
 * Qwen3-ASR integration. Configures the `openai-compat-asr` backend's
 * base_url/model/api_key; activating it as the active ASR engine still needs
 * `OMNIVOICE_ASR_BACKEND=openai-compat-asr` (no in-app ASR engine picker
 * exists yet for any ASR backend — this panel only configures this one).
 *
 * Endpoints (loopback-only):
 *   GET /api/settings/asr-openai-compat  → {base_url, model, has_key}
 *   PUT /api/settings/asr-openai-compat  body {base_url?, model?, api_key?}
 *   ('' clears api_key; omitted/null leaves it unchanged — never returned)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiJson, apiFetch } from '../../api/client';
import { SettingsSection, SettingRow, SettingsInput } from './primitives';
import { Button } from '../../ui';

export default function AsrOpenAICompatPanel() {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const d = await apiJson('/api/settings/asr-openai-compat');
      setBaseUrl(d?.base_url || '');
      setModel(d?.model || '');
      setHasKey(Boolean(d?.has_key));
      setApiKey(''); // the key is never returned — the field always starts blank
    } catch (e) {
      setError(e?.message || t('models.asrOpenAICompatLoadError'));
    }
  }, [t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/settings/asr-openai-compat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: baseUrl,
          model,
          // Only send api_key when the user actually typed something —
          // an untouched field must leave the stored key unchanged, not
          // clear it (the field is always blank on load, so "unchanged"
          // and "empty" would otherwise be indistinguishable).
          ...(apiKey ? { api_key: apiKey } : {}),
        }),
      });
      const d = await res.json();
      setBaseUrl(d.base_url || '');
      setModel(d.model || '');
      setHasKey(Boolean(d.has_key));
      setApiKey('');
    } catch (e) {
      setError(e?.message || t('models.asrOpenAICompatSaveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      icon={Mic}
      title={t('models.asrOpenAICompatTitle')}
      description={t('models.asrOpenAICompatDescription')}
    >
      {error && (
        <div className="perfpanel__error" role="alert">
          {error}
        </div>
      )}

      <SettingRow
        stack
        title={t('models.asrOpenAICompatBaseUrlTitle')}
        hint={t('models.asrOpenAICompatBaseUrlHint')}
        control={
          <SettingsInput
            mono
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:8000/v1"
            data-testid="asr-openai-compat-base-url"
          />
        }
      />

      <SettingRow
        stack
        title={t('models.asrOpenAICompatModelTitle')}
        control={
          <SettingsInput
            mono
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="whisper-1"
            data-testid="asr-openai-compat-model"
          />
        }
      />

      <SettingRow
        stack
        title={t('models.asrOpenAICompatApiKeyTitle')}
        hint={
          hasKey ? t('models.asrOpenAICompatKeyConfigured') : t('models.asrOpenAICompatApiKeyHint')
        }
        control={
          <>
            <SettingsInput
              mono
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? '••••••••' : t('models.asrOpenAICompatApiKeyOptional')}
              data-testid="asr-openai-compat-api-key"
            />
            <Button
              variant="subtle"
              size="sm"
              onClick={save}
              loading={saving}
              disabled={saving}
              data-testid="asr-openai-compat-save"
            >
              {t('common.save')}
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}
