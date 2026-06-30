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
import { apiJson, apiFetch } from '../../api/client';
import { useAppStore } from '../../store';
import { SettingsSection, SettingRow, SettingsToggle } from './primitives';
import './PerformancePanel.css';

export default function PerformancePanel() {
  const [enabled, setEnabled] = useState(false);
  const [platform, setPlatform] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Header live-metrics toggle (default OFF). Persisted via the Zustand
  // app store so it survives reload without a separate API round-trip.
  const showHeaderLiveStats = useAppStore((s) => s.showHeaderLiveStats);
  const setShowHeaderLiveStats = useAppStore((s) => s.setShowHeaderLiveStats);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson('/api/settings/perf/torch-compile-disabled');
      setEnabled(Boolean(data?.enabled));
      setPlatform(data?.platform ?? null);
    } catch (e) {
      setError(e?.message || 'Failed to load performance settings');
    } finally {
      setLoading(false);
    }
  }, []);

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
      setError(err?.message || 'Failed to save setting');
      // Re-sync on failure so the UI doesn't show a stale state
      refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection icon={Cpu} title="Performance">
      {error && (
        <div className="perfpanel__error" role="alert">
          {error}
        </div>
      )}

      <SettingRow
        title="Disable torch.compile (Windows)"
        subtitle={!isWindows ? (platform === null ? '…' : 'not applicable') : undefined}
        note={isWindows ? 'Falls back to eager mode — fixes Triton OOM on <16 GB GPUs.' : undefined}
        hint={
          <>
            Workaround for{' '}
            <a
              href="https://github.com/debpalash/OmniVoice-Studio/issues/65"
              target="_blank"
              rel="noopener noreferrer"
            >
              #65
            </a>{' '}
            — Windows users may hit Triton / <code>torch.compile</code> OOM during model load on
            GPUs with &lt;16 GB VRAM. Enabling this sets <code>TORCH_COMPILE_DISABLE=1</code> on
            engine subprocesses, which falls back to eager mode. macOS and Linux are unaffected.
          </>
        }
        control={
          <SettingsToggle
            checked={enabled}
            onChange={onToggle}
            disabled={!isWindows || saving || loading}
            aria-label="Disable torch.compile (Windows)"
            data-testid="torch-compile-toggle"
          />
        }
      />

      <SettingRow
        title="Show live system metrics in header"
        note="Adds a live RAM / CPU / VRAM monitor to the top bar (off by default)."
        hint={
          <>
            Default off — the header keeps the model-status badge and Flush button always visible
            because they're action-relevant, but RAM / CPU / VRAM counters are noise on the welcome
            screen. Turn this on if you want a live resource monitor in the top bar.
          </>
        }
        control={
          <SettingsToggle
            checked={showHeaderLiveStats}
            onChange={setShowHeaderLiveStats}
            aria-label="Show live system metrics in header"
          />
        }
      />
    </SettingsSection>
  );
}
