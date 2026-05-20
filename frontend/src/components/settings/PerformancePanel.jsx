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
import './PerformancePanel.css';

export default function PerformancePanel() {
  const [enabled, setEnabled] = useState(false);
  const [platform, setPlatform] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Header live-metrics toggle (default OFF). Persisted via the Zustand
  // app store so it survives reload without a separate API round-trip.
  const showHeaderLiveStats = useAppStore(s => s.showHeaderLiveStats);
  const setShowHeaderLiveStats = useAppStore(s => s.setShowHeaderLiveStats);

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
  const tooltip = isWindows
    ? 'Sets TORCH_COMPILE_DISABLE=1 on engine subprocesses to dodge the Windows torch.compile OOM (#65).'
    : 'This setting only affects Windows; on macOS/Linux torch.compile is not the OOM source.';

  const onToggle = async (e) => {
    const next = e.target.checked;
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
    <section className="perfpanel" aria-labelledby="perfpanel-heading">
      <h3 id="perfpanel-heading" className="perfpanel__title">
        <Cpu size={14} /> Performance
      </h3>

      {error && (
        <div className="perfpanel__error" role="alert">
          {error}
        </div>
      )}

      <label className="perfpanel__row" title={tooltip}>
        <input
          type="checkbox"
          className="perfpanel__checkbox"
          checked={enabled}
          onChange={onToggle}
          disabled={!isWindows || saving || loading}
          data-testid="torch-compile-toggle"
        />
        <span className="perfpanel__label">Disable torch.compile (Windows)</span>
        {!isWindows && (
          <span className="perfpanel__badge">{platform === null ? '…' : 'not applicable'}</span>
        )}
      </label>

      <p className="perfpanel__help">
        Workaround for{' '}
        <a
          href="https://github.com/debpalash/OmniVoice-Studio/issues/65"
          target="_blank"
          rel="noopener noreferrer"
        >
          #65
        </a>{' '}
        — Windows users may hit Triton / <code>torch.compile</code> OOM during
        model load on GPUs with &lt;16 GB VRAM. Enabling this sets{' '}
        <code>TORCH_COMPILE_DISABLE=1</code> on engine subprocesses, which
        falls back to eager mode. macOS and Linux are unaffected.
      </p>

      <label className="perfpanel__row" title="Show RAM / CPU / VRAM live counters in the top bar.">
        <input
          type="checkbox"
          className="perfpanel__checkbox"
          checked={showHeaderLiveStats}
          onChange={(e) => setShowHeaderLiveStats(e.target.checked)}
          data-testid="header-live-stats-toggle"
        />
        <span className="perfpanel__label">Show live system metrics in header</span>
      </label>

      <p className="perfpanel__help">
        Default off — the header keeps the model-status badge and Flush
        button always visible because they're action-relevant, but RAM /
        CPU / VRAM counters are noise on the welcome screen. Turn this on
        if you want a live resource monitor in the top bar.
      </p>
    </section>
  );
}
