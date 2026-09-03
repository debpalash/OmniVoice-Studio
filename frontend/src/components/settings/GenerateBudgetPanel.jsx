/**
 * Settings → Performance & Device → Compute-time budget (#1787).
 *
 * Surfaces the two env vars that bound how long one synthesis job is allowed
 * to run before it is abandoned as "too heavy for the available compute" —
 * `OMNIVOICE_GENERATE_TIMEOUT_S` (accelerated/GPU-family hosts) and
 * `OMNIVOICE_CPU_GENERATE_TIMEOUT_S` (CPU-only hosts, which are legitimately
 * slower). Before this panel the only control was the env var itself, which a
 * desktop-installer user has no obvious way to set — the timeout error told
 * people to "raise the generation timeout" with no UI path to do it (#1774,
 * #1778 duplicates).
 *
 * Both values are read once by services/model_manager.py at backend IMPORT
 * time, so saving here (via the same /system/set-env + prefs.json persistence
 * every other row on this page uses) does not change the running process —
 * it takes effect on the next backend restart, which is what `env_prefs`
 * restores before `services.model_manager` is first imported. Hence the
 * `RestartBadge` on every row here: never imply an instant effect this
 * control cannot deliver.
 */
import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { apiJson, apiPost } from '../../api/client';
import { Button } from '../../ui';
import { SettingsSection, SettingRow, SettingsInput } from './primitives';
import RestartBadge from './RestartBadge';

// Keep in sync with backend/api/routers/system.py's _MAX_GENERATE_TIMEOUT_S.
const MAX_TIMEOUT_S = 21600; // 6 hours

function BudgetRow({ envKey, label, note, currentValue }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Prefill once the effective value arrives; don't clobber an in-progress
  // edit on a background refetch.
  useEffect(() => {
    setValue((prev) => (prev ? prev : currentValue != null ? String(currentValue) : ''));
  }, [currentValue]);

  const save = async () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_TIMEOUT_S) {
      toast.error(
        t('settings.generate_timeout_invalid', {
          defaultValue: `Enter a number of seconds greater than 0 and at most ${MAX_TIMEOUT_S}.`,
          max: MAX_TIMEOUT_S,
        }),
      );
      return;
    }
    setSaving(true);
    try {
      await apiPost('/system/set-env', { key: envKey, value: String(n) });
      toast.success(
        t('settings.generate_timeout_saved', {
          defaultValue: 'Saved. Restart VoiceStudio for the new budget to take effect.',
        }),
      );
    } catch (e) {
      toast.error(t('settings.save_failed', { message: e.message }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={
        <>
          {label}
          <RestartBadge />
        </>
      }
      subtitle={
        <code className="rounded-[4px] bg-[var(--chrome-hover-bg)] px-[6px] py-[2px] font-mono text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)]">
          {envKey}
        </code>
      }
      note={note}
      control={
        <>
          <SettingsInput
            type="number"
            min={1}
            max={MAX_TIMEOUT_S}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            aria-label={label}
            data-testid={`generate-timeout-input-${envKey}`}
          />
          <Button
            size="sm"
            variant="subtle"
            onClick={save}
            loading={saving}
            disabled={!value.trim()}
            data-testid={`generate-timeout-save-${envKey}`}
          >
            {t('credentials.save')}
          </Button>
        </>
      }
    />
  );
}

export default function GenerateBudgetPanel() {
  const { t } = useTranslation();
  const [info, setInfo] = useState(null);

  useEffect(() => {
    const ctrl = { aborted: false };
    (async () => {
      try {
        const data = await apiJson('/system/info');
        if (!ctrl.aborted) setInfo(data);
      } catch {
        // Loopback-only; if unreachable just leave the inputs empty.
      }
    })();
    return () => {
      ctrl.aborted = true;
    };
  }, []);

  return (
    <SettingsSection
      icon={Timer}
      title={t('settings.generate_budget_title', { defaultValue: 'Compute-time budget' })}
      description={t('settings.generate_budget_desc', {
        defaultValue:
          'How long one generation may run before it is abandoned as too heavy for this hardware. CPU renders are legitimately slower than accelerated ones, so they get their own, higher floor.',
      })}
    >
      <BudgetRow
        envKey="OMNIVOICE_GENERATE_TIMEOUT_S"
        label={t('settings.generate_timeout_gpu', { defaultValue: 'Accelerated (GPU) budget' })}
        note={t('settings.generate_timeout_gpu_note', {
          defaultValue: 'Used when generation runs on CUDA, ROCm, MPS, or another accelerator.',
        })}
        currentValue={info?.generate_timeout_s}
      />
      <BudgetRow
        envKey="OMNIVOICE_CPU_GENERATE_TIMEOUT_S"
        label={t('settings.generate_timeout_cpu', { defaultValue: 'CPU budget' })}
        note={t('settings.generate_timeout_cpu_note', {
          defaultValue:
            'Used when generation runs on the CPU — long text legitimately takes longer here.',
        })}
        currentValue={info?.cpu_generate_timeout_s}
      />
    </SettingsSection>
  );
}
