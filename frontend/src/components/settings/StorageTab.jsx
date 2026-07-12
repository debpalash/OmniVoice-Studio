/**
 * Settings → Storage (System group).
 *
 * Shows where OmniVoice keeps its data and outputs (read-only, from systemInfo,
 * each with an Open-folder affordance via the /export/reveal endpoint), then the
 * two destructive affordances, in escalating order:
 *
 *   ResetPanel     — scoped reset. Anything from "forget my theme" to "back to a
 *                    fresh install", per-scope, with real sizes. Leaves a working
 *                    app behind: the shell restarts the backend afterwards.
 *   UninstallPanel — the door out (#1089). Deletes everything including the
 *                    managed Python environment, then quits.
 *
 * NOTE: the models *cache* directory lives in the Models category (StoragePanel).
 */
import React from 'react';
import { FolderOpen, HardDrive } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useSystemInfo } from '../../api/hooks';
import { exportReveal } from '../../api/exports';
import { Button } from '../../ui';
import { SettingsSection } from './primitives';
import Row from './Row';
import HistoryRetentionPanel from './HistoryRetentionPanel';
import ResetPanel from './ResetPanel';
import UninstallPanel from './UninstallPanel';

export default function StorageTab() {
  const { t } = useTranslation();
  const { data: info } = useSystemInfo();

  const openFolder = async (path) => {
    try {
      await exportReveal({ path });
    } catch (e) {
      toast.error(
        e?.message || t('settings.open_folder_failed', { defaultValue: 'Could not open folder' }),
      );
    }
  };

  const pathRow = (label, path, testId) => (
    <Row
      label={label}
      value={
        <>
          <span>{path || '—'}</span>
          {path && (
            <Button
              variant="ghost"
              size="sm"
              leading={<FolderOpen size={12} />}
              onClick={() => openFolder(path)}
              title={path}
              data-testid={testId}
            >
              {t('settings.storage_open_folder', { defaultValue: 'Open folder' })}
            </Button>
          )}
        </>
      }
      mono
    />
  );

  return (
    <>
      <SettingsSection
        icon={HardDrive}
        title={t('settings.storage', { defaultValue: 'Storage' })}
        description={t('settings.storage_desc', {
          defaultValue: 'Where OmniVoice keeps your data and outputs.',
        })}
      >
        {pathRow(
          t('settings.data_dir_at', { defaultValue: 'App data stored at' }),
          info?.data_dir ? `${info.data_dir}/` : '',
          'storage-open-data-dir',
        )}
        {pathRow(t('privacy.outputs_at'), info?.outputs_dir || '', 'storage-open-outputs-dir')}
        {pathRow(t('about.crash_log'), info?.crash_log_path || '', 'storage-open-crash-log')}
      </SettingsSection>

      <HistoryRetentionPanel />

      {/* Scoped reset: preferences → settings → assets → everything. */}
      <ResetPanel />

      {/* The door out (#1089): everything, including the Python env, then quit. */}
      <UninstallPanel />
    </>
  );
}
