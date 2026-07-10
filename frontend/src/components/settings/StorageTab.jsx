/**
 * Settings → Storage (System group).
 *
 * Shows where OmniVoice keeps its data and outputs (read-only, from systemInfo)
 * and provides a NEW "Factory reset" action that clears the locally-persisted
 * UI preferences (the zustand `omnivoice.app` localStorage blob) behind a
 * confirm Dialog, then reloads.
 *
 * NOTE: the models *cache* directory lives in the Models category (StoragePanel)
 * — this category is about the app's own data/outputs paths and a clean-slate
 * reset of UI prefs. Factory reset only touches localStorage prefs; it never
 * deletes the user's voices, projects, or outputs on disk.
 */
import React, { useState } from 'react';
import { HardDrive, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useSystemInfo } from '../../api/hooks';
import { Button, Dialog } from '../../ui';
import { SettingsSection } from './primitives';
import Row from './Row';
import HistoryRetentionPanel from './HistoryRetentionPanel';

// The zustand persist key (see store/index.ts `name`). Clearing it resets every
// persisted UI preference to its slice default on the next load.
const PREFS_LS_KEY = 'omnivoice.app';

export default function StorageTab() {
  const { t } = useTranslation();
  const { data: info } = useSystemInfo();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const factoryReset = () => {
    try {
      localStorage.removeItem(PREFS_LS_KEY);
      toast.success(
        t('settings.factory_reset_done', { defaultValue: 'Preferences cleared — reloading…' }),
      );
      setConfirmOpen(false);
      // Reload so the store rehydrates from defaults across the whole app.
      setTimeout(() => window.location.reload(), 350);
    } catch (e) {
      toast.error(
        t('settings.factory_reset_failed', { defaultValue: 'Reset failed', message: e?.message }),
      );
    }
  };

  return (
    <>
      <SettingsSection
        icon={HardDrive}
        title={t('settings.storage', { defaultValue: 'Storage' })}
        description={t('settings.storage_desc', {
          defaultValue: 'Where OmniVoice keeps your data and outputs.',
        })}
      >
        <Row
          label={t('privacy.uploads_at')}
          value={info?.data_dir ? `${info.data_dir}/` : '—'}
          mono
        />
        <Row label={t('privacy.outputs_at')} value={info?.outputs_dir || '—'} mono />
        <Row label={t('about.crash_log')} value={info?.crash_log_path || '—'} mono />
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
