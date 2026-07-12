/**
 * Settings → Storage (System group).
 *
 * Shows where OmniVoice keeps its data and outputs (read-only, from systemInfo,
 * each with an Open-folder affordance via the /export/reveal endpoint) and a
 * "Factory reset" action that clears every locally-persisted UI preference —
 * the full registry in utils/prefKeys.js, not just the zustand blob — behind a
 * confirm Dialog, then reloads.
 *
 * NOTE: the models *cache* directory lives in the Models category (StoragePanel)
 * — this category is about the app's own data/outputs paths and a clean-slate
 * reset of UI prefs. Factory reset only touches localStorage prefs; it never
 * deletes the user's voices, projects, or outputs on disk, and never wipes the
 * remote-backend connection or dictation history (see prefKeys.PRESERVED_KEYS).
 */
import React, { useState } from 'react';
import { FolderOpen, HardDrive, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useSystemInfo } from '../../api/hooks';
import { exportReveal } from '../../api/exports';
import { clearLocalPreferences } from '../../utils/prefKeys';
import { Button, Dialog } from '../../ui';
import { SettingsSection } from './primitives';
import Row from './Row';
import HistoryRetentionPanel from './HistoryRetentionPanel';
import UninstallPanel from './UninstallPanel';

export default function StorageTab() {
  const { t } = useTranslation();
  const { data: info } = useSystemInfo();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const factoryReset = () => {
    try {
      clearLocalPreferences();
      toast.success(
        t('settings.factory_reset_done', { defaultValue: 'Preferences cleared — reloading…' }),
      );
      setConfirmOpen(false);
      // Reload so the store rehydrates from defaults across the whole app.
      setTimeout(() => window.location.reload(), 350);
    } catch (e) {
      toast.error(
        t('settings.factory_reset_failed', {
          defaultValue: 'Reset failed: {{message}}',
          message: e?.message || e,
        }),
      );
    }
  };

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

      <SettingsSection
        icon={RotateCcw}
        title={t('settings.factory_reset', { defaultValue: 'Factory reset' })}
        description={t('settings.factory_reset_desc', {
          defaultValue:
            'Reset all in-app preferences to their defaults. Your files stay untouched.',
        })}
      >
        <p className="m-0 mb-[var(--space-4)] [font-family:var(--font-sans)] text-[length:var(--text-md)] leading-[1.6] text-[var(--chrome-fg-muted)]">
          {t('settings.factory_reset_body', {
            defaultValue:
              'Clears locally-saved settings (theme, language, dub knobs, gallery favorites, and other UI preferences). It does NOT delete your voices, projects, or generated audio on disk.',
          })}
        </p>
        <Button
          variant="danger"
          size="md"
          leading={<RotateCcw size={13} />}
          onClick={() => setConfirmOpen(true)}
          data-testid="factory-reset-open"
        >
          {t('settings.factory_reset', { defaultValue: 'Factory reset' })}
        </Button>
      </SettingsSection>

      {/* The real uninstaller (#1089) — factory reset above only clears UI prefs. */}
      <UninstallPanel />

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('settings.factory_reset_confirm_title', { defaultValue: 'Reset preferences?' })}
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={factoryReset}
              data-testid="factory-reset-confirm"
            >
              {t('settings.factory_reset_confirm', { defaultValue: 'Reset and reload' })}
            </Button>
          </>
        }
      >
        <p className="m-0 [font-family:var(--font-sans)] text-[length:var(--text-md)] leading-[1.6] text-[var(--chrome-fg)]">
          {t('settings.factory_reset_confirm_body', {
            defaultValue:
              'This clears all saved UI preferences and reloads the app. Your voices, projects, and outputs on disk are not affected. Continue?',
          })}
        </p>
      </Dialog>
    </>
  );
}
