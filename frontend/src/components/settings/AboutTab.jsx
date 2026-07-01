import React from 'react';
import {
  Info,
  CheckCircle,
  AlertCircle,
  Download,
  Activity,
  Copy,
  ExternalLink,
  Building2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openExternal } from '../../api/external';
import { resolveAboutVersion } from '../../utils/appVersion';
import { Button, Badge } from '../../ui';
import { SettingsSection } from './primitives';
import { useAppStore } from '../../store';
import { isTauri } from './native';
import Row from './Row';

/**
 * Settings → About.
 *
 * Identity + diagnostics only. The device / RAM / VRAM / backend readouts moved
 * to Performance & Device; the data/outputs paths moved to Storage; the update
 * channel + endpoint moved to Updates (the single update home). What remains is
 * app identity, the HF-token quick status, and the diagnostics actions.
 */
export default function AboutTab({
  appVersion,
  tauriVersion,
  info,
  checkForUpdates,
  updateState,
  selfCheck,
  selfCheckRunning,
  runSelfCheck,
  bundleBuilding,
  saveDiagnosticBundle,
  copyDiagnostics,
}) {
  const { t } = useTranslation();

  return (
    <SettingsSection icon={Info} title={t('settings.about')}>
      <Row label={t('about.app')} value="OmniVoice Studio" />
      <Row label={t('about.version')} value={resolveAboutVersion(appVersion, info)} mono />
      <Row
        label={t('about.tauri_runtime')}
        value={tauriVersion || (isTauri() ? '—' : t('about.web_preview'))}
        mono
      />
      <Row
        label={t('about.hf_token')}
        value={info?.has_hf_token ? t('about.yes') : t('about.no')}
      />

      <div className="settings-link-row mt-[var(--space-5)] flex flex-wrap gap-[var(--space-4)]">
        {isTauri() && (
          <Button
            variant="primary"
            size="md"
            leading={<Download size={12} />}
            onClick={checkForUpdates}
            loading={updateState === 'checking' || updateState === 'downloading'}
          >
            {updateState === 'downloading' ? t('about.downloading') : t('about.check_updates')}
          </Button>
        )}
        <Button
          variant="subtle"
          size="md"
          leading={!selfCheckRunning && <Activity size={12} />}
          onClick={runSelfCheck}
          loading={selfCheckRunning}
        >
          {t('about.self_check')}
        </Button>
        <Button
          variant="subtle"
          size="md"
          leading={!bundleBuilding && <Download size={12} />}
          onClick={saveDiagnosticBundle}
          loading={bundleBuilding}
        >
          {t('about.save_bundle')}
        </Button>
        <Button variant="subtle" size="md" leading={<Copy size={12} />} onClick={copyDiagnostics}>
          {t('about.copy_diagnostics')}
        </Button>
        <Button
          variant="subtle"
          size="md"
          leading={<ExternalLink size={12} />}
          onClick={() => openExternal('https://github.com/k2-fsa/OmniVoice')}
        >
          {t('about.github')}
        </Button>
        <Button
          variant="subtle"
          size="md"
          leading={<ExternalLink size={12} />}
          onClick={() => openExternal('https://huggingface.co/k2-fsa/OmniVoice')}
        >
          {t('about.model_card')}
        </Button>
        <Button
          variant="subtle"
          size="md"
          leading={<Building2 size={12} />}
          onClick={() => {
            useAppStore.getState().setMode?.('enterprise');
          }}
        >
          {t('about.commercial_license')}
        </Button>
      </div>
      {selfCheck && (
        <div className="settings-selfcheck">
          {selfCheck.checks.map((c) => (
            <Row
              key={c.id}
              label={c.label}
              value={
                <span>
                  <Badge
                    tone={c.status === 'ok' ? 'success' : c.status === 'warn' ? 'warn' : 'danger'}
                  >
                    {c.status === 'ok' ? <CheckCircle size={11} /> : <AlertCircle size={11} />}{' '}
                    {t(`about.self_check_${c.status}`)}
                  </Badge>{' '}
                  {c.detail}
                  {c.hint && (
                    <span className="settings-muted font-sans text-[var(--text-md)] text-[var(--chrome-fg-dim)]">
                      {' '}
                      — {c.hint}
                    </span>
                  )}
                </span>
              }
            />
          ))}
          <p className="settings-muted font-sans text-[var(--text-md)] text-[var(--chrome-fg-dim)]">
            {selfCheck.summary.ok
              ? t('about.self_check_healthy')
              : t('about.self_check_attention', { count: selfCheck.summary.failures })}
          </p>
        </div>
      )}
    </SettingsSection>
  );
}
