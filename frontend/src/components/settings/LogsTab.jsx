import React, { useEffect, useRef } from 'react';
import { Copy, FileText, FolderOpen, RefreshCw, Trash2, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { exportReveal } from '../../api/exports';
import { copyText } from '../../utils/copyText';
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
  const scrollRef = useRef(null);

  // Fresh log loads land scrolled to the newest entries — the tail is the
  // whole point of checking logs; without this the viewer opens at the oldest
  // line of the tailed window on every refresh.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  // The frontend "log" is an in-memory buffer — there is no file to reveal.
  const hasLogFile = logSource !== 'frontend' && !!logMeta.exists && !!logMeta.path;

  const openLogFolder = async () => {
    try {
      await exportReveal({ path: logMeta.path });
    } catch (e) {
      toast.error(
        e?.message || t('settings.open_folder_failed', { defaultValue: 'Could not open folder' }),
      );
    }
  };

  const copyLogs = async () => {
    const ok = await copyText(logs.join(''));
    if (ok) {
      toast.success(t('logs.log_copied', { source: t(`common.${logSource}`) }));
    } else {
      toast.error(t('logs.copy_failed_short', { defaultValue: 'Could not copy the log' }));
    }
  };

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
            onClick={copyLogs}
            disabled={logs.length === 0}
            leading={<Copy size={11} />}
            data-testid="logs-copy"
          >
            {t('logs.copy_visible', { defaultValue: 'Copy visible log' })}
          </Button>
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
        aria-label={t('logs.source', { defaultValue: 'Log source' })}
      />

      <div className="settings-log-meta flex items-center gap-[var(--space-4)] my-[var(--space-4)] font-mono text-[var(--text-base)] text-[var(--chrome-fg-dim)]">
        <span>{logMeta.path || '—'}</span>
        {hasLogFile && (
          <Button
            variant="ghost"
            size="sm"
            onClick={openLogFolder}
            leading={<FolderOpen size={11} />}
            title={logMeta.path}
            data-testid="logs-open-folder"
          >
            {t('settings.storage_open_folder', { defaultValue: 'Open folder' })}
          </Button>
        )}
        {logSource === 'tauri' && !logMeta.exists && (
          <Badge tone="warn">
            <AlertCircle size={11} /> {t('logs.no_tauri_log')}
          </Badge>
        )}
      </div>
      <div
        ref={scrollRef}
        tabIndex={0}
        role="log"
        aria-label={t('settings.logs')}
        data-testid="logs-scroll"
        className="bg-[var(--chrome-bg)] [border:1px_solid_var(--chrome-border)] rounded-[var(--chrome-radius-pill)] px-[12px] py-[10px] max-h-[280px] overflow-auto font-mono text-[0.72rem] text-[var(--chrome-fg-muted)] whitespace-pre-wrap break-words focus-visible:outline-none focus-visible:border-[var(--chrome-accent)] focus-visible:shadow-[var(--focus-ring)]"
      >
        {logs.length === 0 ? (
          <span className="settings-log__empty font-sans text-[var(--chrome-fg-dim)]">
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
