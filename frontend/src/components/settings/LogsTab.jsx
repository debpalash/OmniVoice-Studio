import React from 'react';
import { FileText, RefreshCw, Trash2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Segmented, Button, Badge } from '../../ui';
import { SettingsSection } from './primitives';
import ReportBugButton from '../ReportBugButton';

const LOG_SOURCE_DEFS = [
  { value: 'backend', key: 'backend' },
  { value: 'frontend', key: 'frontend' },
  { value: 'tauri', key: 'tauri' },
];

export default function LogsTab({
  logSource,
  setLogSource,
  logs,
  logMeta,
  loadingLogs,
  refreshLogs,
  onClearLogs,
}) {
  const { t } = useTranslation();

  return (
    <SettingsSection
      icon={FileText}
      title={t('settings.logs')}
      actions={
        <>
          <ReportBugButton />
          <Button
            variant="subtle"
            size="sm"
            onClick={refreshLogs}
            loading={loadingLogs}
            leading={!loadingLogs && <RefreshCw size={11} />}
          >
            {t('common.refresh')}
          </Button>
          <Button variant="danger" size="sm" onClick={onClearLogs} leading={<Trash2 size={11} />}>
            {t('common.clear')}
          </Button>
        </>
      }
    >
      <Segmented
        items={LOG_SOURCE_DEFS.map((d) => ({ ...d, label: t(`common.${d.key}`) }))}
        value={logSource}
        onChange={setLogSource}
      />

      <div className="settings-log-meta">
        <span>{logMeta.path || '—'}</span>
        {logSource === 'tauri' && !logMeta.exists && (
          <Badge tone="warn">
            <AlertCircle size={11} /> {t('logs.no_tauri_log')}
          </Badge>
        )}
      </div>
      <div className="settings-log">
        {logs.length === 0 ? (
          <span className="settings-log__empty">
            {logSource === 'frontend'
              ? t('logs.empty_frontend')
              : logSource === 'tauri'
                ? t('logs.empty_tauri')
                : t('logs.empty_backend')}
          </span>
        ) : (
          logs.join('')
        )}
      </div>
    </SettingsSection>
  );
}
