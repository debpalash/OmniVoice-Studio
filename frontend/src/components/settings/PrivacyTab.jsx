import React from 'react';
import { ShieldCheck, CheckCircle, AlertCircle } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Badge } from '../../ui';
import { SettingsSection } from './primitives';
import Row from './Row';

export default function PrivacyTab({ info }) {
  const { t } = useTranslation();

  return (
    <SettingsSection icon={ShieldCheck} title={t('settings.privacy')}>
      <p className="settings-prose">
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
      <Row
        label={t('privacy.network_calls')}
        value={
          info?.translate_provider &&
          ['google', 'deepl', 'mymemory', 'microsoft', 'openai'].includes(
            info.translate_provider,
          ) ? (
            <Badge tone="warn">
              <AlertCircle size={11} />{' '}
              {t('privacy.translator_online', { provider: info.translate_provider })}
            </Badge>
          ) : (
            <Badge tone="success">
              <CheckCircle size={11} /> {t('privacy.translator_offline')}
            </Badge>
          )
        }
      />
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
