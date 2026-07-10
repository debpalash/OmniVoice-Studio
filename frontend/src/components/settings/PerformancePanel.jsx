/**
 * Settings → Performance panel (Wave 2 INST-12 UI half).
 *
 * Toggles the `Disable torch.compile (Windows)` setting that backend
 * engine launchers read via `services.engine_env.build_engine_env()`.
 *
 * The toggle is disabled (with an explainer tooltip) on non-Windows
 * platforms — torch.compile OOMs the same Triton kernel cache
 * differently on macOS / Linux, so toggling it there would just slow
 * the engine for no gain (issue #65).
 *
 * Endpoints:
 *   GET /api/settings/perf/torch-compile-disabled
 *     → {"enabled": bool, "platform": "darwin"|"linux"|"win32"}
 *   PUT /api/settings/perf/torch-compile-disabled
 *     body {"enabled": bool}  (loopback-only)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { apiJson, apiFetch } from '../../api/client';
import { SettingsSection, SettingRow, SettingsToggle } from './primitives';
import RestartBadge from './RestartBadge';

export default function PerformancePanel() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [platform, setPlatform] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson('/api/settings/perf/torch-compile-disabled');
      setEnabled(Boolean(data?.enabled));
      setPlatform(data?.platform ?? null);
    } catch (e) {
      setError(
        e?.message ||
          t('settings.perf_load_failed', { defaultValue: 'Failed to load performance settings' }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isWindows = platform === 'win32';

  const onToggle = async (next) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/settings/perf/torch-compile-disabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const body = await res.json().catch(() => ({}));
      setEnabled(Boolean(body?.enabled ?? next));
    } catch (err) {
      setError(
        err?.message || t('settings.perf_save_failed', { defaultValue: 'Failed to save setting' }),
      );
      // Re-sync on failure so the UI doesn't show a stale state
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const toggleLabel = t('settings.perf_torch_compile', {
    defaultValue: 'Disable torch.compile (Windows)',
  });

  return (
    <SettingsSection icon={Cpu} title={t('settings.perf_title', { defaultValue: 'Performance' })}>
      {error && (
        <div className="perfpanel__error" role="alert">
          {error}
        </div>
      )}

      <SettingRow
        title={
          <>
            {toggleLabel}
            <RestartBadge />
          </>
        }
        subtitle={
          !isWindows
            ? platform === null
              ? '…'
              : t('settings.perf_torch_compile_na', {
                  defaultValue: 'Windows only — not needed on this platform',
                })
            : undefined
        }
        note={
          isWindows
            ? t('settings.perf_torch_compile_note', {
                defaultValue: 'Falls back to eager mode — fixes Triton OOM on <16 GB GPUs.',
              })
            : undefined
        }
        hint={
          <Trans
            i18nKey="settings.perf_torch_compile_hint"
            defaults="Workaround for <issueLink>#65</issueLink> — Windows users may hit Triton / <code>torch.compile</code> OOM during model load on GPUs with less than 16 GB VRAM. Enabling this sets <code>TORCH_COMPILE_DISABLE=1</code> on engine subprocesses, which falls back to eager mode. macOS and Linux are unaffected."
            components={{
              // Trans injects the link text ("#65") from the translation string.
              issueLink: (
                <a
                  href="https://github.com/debpalash/OmniVoice-Studio/issues/65"
                  target="_blank"
                  rel="noopener noreferrer"
                />
              ),
              code: <code />,
            }}
          />
        }
        control={
          <SettingsToggle
            checked={enabled}
            onChange={onToggle}
            disabled={!isWindows || saving || loading}
            aria-label={toggleLabel}
            data-testid="torch-compile-toggle"
          />
        }
      />
    </SettingsSection>
  );
}
