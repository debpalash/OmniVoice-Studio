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
import { Segmented, Button, Badge } from '../../ui';
import { SettingsSection, SettingRow } from './primitives';
import { useAppStore } from '../../store';
import { isTauri } from './native';
import Row from './Row';

export default function AboutTab({
  appVersion,
  tauriVersion,
  info,
  hw,
  status,
  updateChannel,
  changeChannel,
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
      <Row label={t('about.platform')} value={info?.platform || '—'} />
      <Row label={t('about.architecture')} value={info?.arch || '—'} mono />
      <Row label={t('about.python')} value={info?.python || '—'} mono />
      <Row label={t('about.compute_device')} value={info?.device || '—'} mono />
      <Row
        label={t('about.gpu_active')}
        value={
          hw?.gpu_active ? (
            <Badge tone="success">
              <CheckCircle size={11} /> {t('about.yes')}
            </Badge>
          ) : (
            <Badge tone="neutral">{t('about.no')}</Badge>
          )
        }
      />
      <Row
        label={t('about.ram')}
        value={hw ? `${hw.ram?.toFixed(2)} / ${hw.total_ram?.toFixed(2)} GB` : '—'}
        mono
      />
      <Row label={t('about.vram')} value={hw ? `${hw.vram?.toFixed(2)} GB` : '—'} mono />
      <Row
        label={t('about.backend')}
        value={
          <Badge
            tone={
              status?.status === 'ready'
                ? 'success'
                : status?.status === 'loading'
                  ? 'warn'
                  : 'neutral'
            }
          >
            {status?.status || 'unknown'}
          </Badge>
        }
      />
      <Row
        label={t('about.active_model')}
        value={status?.repo_id || info?.model_checkpoint || '—'}
        mono
      />
      <Row label={t('about.asr_model')} value={info?.asr_model || '—'} mono />
      <Row label={t('about.translator')} value={info?.translate_provider || '—'} />
      <Row
        label={t('about.hf_token')}
        value={info?.has_hf_token ? t('about.yes') : t('about.no')}
      />
      <Row label={t('about.data_dir')} value={info?.data_dir || '—'} mono />
      <Row label={t('about.outputs')} value={info?.outputs_dir || '—'} mono />
      <Row label={t('about.crash_log')} value={info?.crash_log_path || '—'} mono />
      {/* Auto-updater + channel toggle are desktop-only (Tauri). The Docker
          web build updates by pulling a new image tag, so hide these rows
          there to avoid a non-functional control (issue #249). */}
      {isTauri() && (
        <>
          <SettingRow
            title={t('about.update_channel')}
            hint={updateChannel === 'preview' ? t('about.channel_preview_hint') : undefined}
            control={
              <Segmented
                size="xs"
                value={updateChannel}
                onChange={changeChannel}
                items={[
                  { value: 'stable', label: t('about.channel_stable') },
                  { value: 'preview', label: t('about.channel_preview') },
                ]}
              />
            }
          />
          <Row
            label={t('about.update_endpoint')}
            value={
              updateChannel === 'preview'
                ? 'releases/download/preview/latest.json'
                : 'releases/latest/download/latest.json'
            }
            mono
          />
        </>
      )}
      <div className="settings-link-row">
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
                  {c.hint && <span className="settings-muted"> — {c.hint}</span>}
                </span>
              }
            />
          ))}
          <p className="settings-muted">
            {selfCheck.summary.ok
              ? t('about.self_check_healthy')
              : t('about.self_check_attention', { count: selfCheck.summary.failures })}
          </p>
        </div>
      )}
    </SettingsSection>
  );
}
