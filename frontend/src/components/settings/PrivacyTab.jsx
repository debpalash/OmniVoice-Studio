import React from 'react';
import { ShieldCheck, CheckCircle, AlertCircle } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Badge, Button } from '../../ui';
import { useAppStore } from '../../store';
import { SettingsSection } from './primitives';
import Row from './Row';

// Providers that send dialogue text to a third-party service vs. the ones that
// run fully on-device (backend/api/routers/dub_translate.py). Anything else —
// including the backend's safe-defaults value 'unknown' or a missing
// system-info payload — must NOT get the confident green "offline" claim.
const ONLINE_PROVIDERS = ['google', 'deepl', 'mymemory', 'microsoft', 'openai'];
const OFFLINE_PROVIDERS = ['nllb', 'argos', 'libretranslate'];

export default function PrivacyTab({ info }) {
  const { t } = useTranslation();
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  const provider = info?.translate_provider;

  let translatorBadge;
  if (provider && ONLINE_PROVIDERS.includes(provider)) {
    translatorBadge = (
      <span className="inline-flex items-center gap-[var(--space-2)]">
        <Badge tone="warn">
          <AlertCircle size={11} /> {t('privacy.translator_online', { provider })}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openSettingsTab('translation')}
          data-testid="privacy-change-translator"
        >
          {t('privacy.change_translator', { defaultValue: 'Change translator' })}
        </Button>
      </span>
    );
  } else if (provider && OFFLINE_PROVIDERS.includes(provider)) {
    translatorBadge = (
      <Badge tone="success">
        <CheckCircle size={11} /> {t('privacy.translator_offline')}
      </Badge>
    );
  } else {
    // Backend down, errored (translate_provider: 'unknown'), or an
    // unrecognized provider — don't render a privacy assurance without data.
    translatorBadge = (
      <Badge tone="neutral" data-testid="privacy-translator-unknown">
        {t('privacy.translator_unknown', { defaultValue: 'Unknown' })}
      </Badge>
    );
  }

  return (
    <SettingsSection icon={ShieldCheck} title={t('settings.privacy')}>
      <p className="settings-prose m-0 mb-[var(--space-5)] font-sans text-[var(--text-md)] leading-[1.6] text-[var(--chrome-fg-muted)]">
        <Trans i18nKey="privacy.desc" components={{ 1: <strong /> }} />
      </p>
      <Row
        label={t('privacy.uploads_at')}
        value={info?.data_dir ? `${info.data_dir}/` : '—'}
        mono
      />
      <Row label={t('privacy.outputs_at')} value={info?.outputs_dir || '—'} mono />
      <Row
        label={t('privacy.gen_history')}
        value={<Badge tone="neutral">{t('privacy.local_sqlite')}</Badge>}
      />
      <Row label={t('privacy.network_calls')} value={translatorBadge} />
      <Row
        label={t('privacy.model_telemetry')}
        value={
          <Badge tone="success">
            <CheckCircle size={11} /> {t('privacy.no_tracking')}
          </Badge>
        }
      />
    </SettingsSection>
  );
}
