/**
 * Settings → Translation (NEW consolidated category).
 *
 * Pulls the previously-scattered translation controls into one home:
 *   • translateQuality pref (fast | cinematic) — zustand store binding.
 *   • LLMEndpointPanel — the OpenAI-compatible endpoint that powers cinematic
 *     translate / glossary extract / dictation refinement (re-hosted as-is).
 *   • Provider credentials — the DEEPL_* / MICROSOFT_* / TRANSLATE_* keys that
 *     used to live in CredentialsTab's "More providers" collapsible. Same
 *     `/system/set-env` save logic; HF_TOKEN stays in Credentials.
 *
 * No logic rewrite — this is reorganization. Every binding is preserved.
 */
import React, { useState } from 'react';
import { Languages, KeyRound } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Segmented } from '../../ui';
import { useAppStore } from '../../store';
import { SettingsSection, SettingRow, SettingsInput, Collapsible } from './primitives';
import { Button } from '../../ui';
import LLMEndpointPanel from './LLMEndpointPanel';

// Translation provider credentials (HF_TOKEN intentionally excluded — it lives
// in the Credentials category). Identical field set to the old CredentialsTab.
const PROVIDER_FIELDS = [
  {
    key: 'TRANSLATE_API_KEY',
    labelKey: 'credentials.translate_key',
    placeholder: 'API key',
    helpKey: 'credentials.translate_help',
    isPassword: true,
  },
  {
    key: 'TRANSLATE_BASE_URL',
    labelKey: 'credentials.llm_base_url',
    placeholder: 'https://api.openai.com/v1',
    helpKey: 'credentials.llm_base_url_help',
  },
  {
    key: 'TRANSLATE_MODEL',
    labelKey: 'credentials.llm_model',
    placeholder: 'gpt-4o',
    helpKey: 'credentials.llm_model_help',
  },
  {
    key: 'DEEPL_API_KEY',
    labelKey: 'credentials.deepl_key',
    placeholder: 'DeepL API key',
    helpKey: 'credentials.deepl_key',
    isPassword: true,
  },
  {
    key: 'DEEPL_BASE_URL',
    labelKey: 'credentials.deepl_base_url',
    placeholder: 'https://api.deepl.com/v2',
    helpKey: 'credentials.deepl_base_url_help',
  },
  {
    key: 'MICROSOFT_API_KEY',
    labelKey: 'credentials.microsoft_key',
    placeholder: 'Microsoft API key',
    helpKey: 'credentials.microsoft_key',
    isPassword: true,
  },
  {
    key: 'MICROSOFT_BASE_URL',
    labelKey: 'credentials.microsoft_base_url',
    placeholder: 'https://api.cognitive.microsofttranslator.com',
    helpKey: 'credentials.microsoft_base_url_help',
  },
];

export default function TranslationTab() {
  const { t } = useTranslation();
  const translateQuality = useAppStore((s) => s.translateQuality);
  const setTranslateQuality = useAppStore((s) => s.setTranslateQuality);

  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(null);

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
      setValues((prev) => ({ ...prev, [key]: '' }));
    } catch (e) {
      toast.error(t('credentials.save_error', { message: e.message }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <SettingsSection
        icon={Languages}
        title={t('settings.translation', { defaultValue: 'Translation' })}
        description={t('settings.translation_desc', {
          defaultValue: 'How dubbing translates dialogue, and which engine does it.',
        })}
      >
        <SettingRow
          title={t('settings.translate_quality', { defaultValue: 'Translation quality' })}
          subtitle={t('settings.translate_quality_desc', {
            defaultValue: 'Fast is literal and quick; Cinematic uses the LLM for natural phrasing.',
          })}
          control={
            <Segmented
              size="sm"
              value={translateQuality}
              onChange={setTranslateQuality}
              items={[
                { value: 'fast', label: t('settings.translate_fast', { defaultValue: 'Fast' }) },
                {
                  value: 'autofit',
                  label: t('settings.translate_autofit', { defaultValue: 'Autofit' }),
                },
                {
                  value: 'cinematic',
                  label: t('settings.translate_cinematic', { defaultValue: 'Cinematic' }),
                },
              ]}
            />
          }
        />
      </SettingsSection>

      <LLMEndpointPanel />

      <SettingsSection
        icon={KeyRound}
        title={t('settings.translation_providers', { defaultValue: 'Translation providers' })}
        description={t('settings.translation_providers_desc', {
          defaultValue: 'API keys for online translators, set for this session.',
        })}
      >
        <Collapsible
          title={t('settings.credentials_more', { defaultValue: 'Provider keys' })}
          icon={KeyRound}
          defaultOpen
        >
          {PROVIDER_FIELDS.map((field) => (
            <SettingRow
              key={field.key}
              align="start"
              stack
              title={t(field.labelKey)}
              note={t(field.helpKey)}
              control={
                <>
                  <SettingsInput
                    type={field.isPassword ? 'password' : 'text'}
                    mono
                    placeholder={field.placeholder}
                    value={values[field.key] || ''}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    onKeyDown={(e) => e.key === 'Enter' && save(field.key)}
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
    </>
  );
}
