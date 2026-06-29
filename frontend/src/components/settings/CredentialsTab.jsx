import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import { openExternal } from '../../api/external';
import { Badge, Button } from '../../ui';
import { SettingsSection, SettingRow, SettingsInput, Collapsible } from './primitives';
import ApiKeysPanel from './ApiKeysPanel';
import LLMEndpointPanel from './LLMEndpointPanel';

const CREDENTIAL_FIELDS = [
  { key: 'HF_TOKEN', labelKey: 'credentials.hf_token', placeholderKey: 'hf_xxxxxxxxxxxx',
    helpKey: 'credentials.hf_help', link: 'https://huggingface.co/settings/tokens', isPassword: true },
  { key: 'TRANSLATE_API_KEY', labelKey: 'credentials.translate_key', placeholderKey: 'API key',
    helpKey: 'credentials.translate_help', isPassword: true },
  { key: 'TRANSLATE_BASE_URL', labelKey: 'credentials.llm_base_url', placeholderKey: 'https://api.openai.com/v1',
    helpKey: 'credentials.llm_base_url_help' },
  { key: 'TRANSLATE_MODEL', labelKey: 'credentials.llm_model', placeholderKey: 'gpt-4o',
    helpKey: 'credentials.llm_model_help' },
  { key: 'DEEPL_API_KEY', labelKey: 'credentials.deepl_key', placeholderKey: 'DeepL API key',
    helpKey: 'credentials.deepl_key', isPassword: true },
  { key: 'DEEPL_BASE_URL', labelKey: 'credentials.deepl_base_url', placeholderKey: 'https://api.deepl.com/v2',
    helpKey: 'credentials.deepl_base_url_help' },
  { key: 'MICROSOFT_API_KEY', labelKey: 'credentials.microsoft_key', placeholderKey: 'Microsoft API key',
    helpKey: 'credentials.microsoft_key', isPassword: true },
  { key: 'MICROSOFT_BASE_URL', labelKey: 'credentials.microsoft_base_url', placeholderKey: 'https://api.cognitive.microsofttranslator.com',
    helpKey: 'credentials.microsoft_base_url_help' },
];

export default function CredentialsTab({ info }) {
  const { t } = useTranslation();
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(null);
  const [saved, setSaved] = useState({});

  const save = async (key) => {
    const value = (values[key] || '').trim();
    if (!value) return;
    setSaving(key);
    try {
      const { apiFetch } = await import('../../api/client');
      await apiFetch('/system/set-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      toast.success(t('credentials.saved_session', { key }));
      setSaved(prev => ({ ...prev, [key]: true }));
      setValues(prev => ({ ...prev, [key]: '' }));
    } catch (e) {
      toast.error(t('credentials.save_error', { message: e.message }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <SettingsSection
      icon={KeyRound}
      title={t('settings.credentials')}
      description={t('settings.credentials_desc')}
    >
      {/* Wave 2 AUTH-03 panel — 3-source cascade with Active badge,
          encrypted-at-rest App-source storage, and live whoami status. */}
      <ApiKeysPanel />

      {/* Wave 2.4 — OpenAI-compatible LLM endpoint (Ollama/LM Studio/vLLM). */}
      <LLMEndpointPanel />

      <Collapsible title={t('settings.credentials_more')} icon={KeyRound}>
        <p className="settings-prose">
          <Trans i18nKey="credentials.desc" components={{ 1: <strong /> }} />
        </p>
        {CREDENTIAL_FIELDS.filter(f => f.key !== 'HF_TOKEN').map(field => (
          <SettingRow
            key={field.key}
            align="start"
            className="st-row--stack"
            title={
              <>
                {t(field.labelKey)}
                {field.key === 'HF_TOKEN' && (
                  <Badge tone={info?.has_hf_token || saved.HF_TOKEN ? 'success' : 'warn'} size="xs">
                    {info?.has_hf_token || saved.HF_TOKEN ? t('credentials.saved') : t('credentials.not_set')}
                  </Badge>
                )}
              </>
            }
            note={
              <>
                {t(field.helpKey)}
                {field.link && (
                  <> <a href="#" onClick={e => { e.preventDefault(); openExternal(field.link); }}>{t('credentials.get_token')}</a></>
                )}
              </>
            }
            control={
              <>
                <SettingsInput
                  type={field.isPassword ? 'password' : 'text'}
                  mono
                  placeholder={field.placeholderKey}
                  value={values[field.key] || ''}
                  onChange={e => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && save(field.key)}
                />
                <Button
                  size="sm"
                  variant="subtle"
                  loading={saving === field.key}
                  onClick={() => save(field.key)}
                  disabled={!(values[field.key] || '').trim()}
                >
                  {t('credentials.save')}
                </Button>
              </>
            }
          />
        ))}
      </Collapsible>
    </SettingsSection>
  );
}
