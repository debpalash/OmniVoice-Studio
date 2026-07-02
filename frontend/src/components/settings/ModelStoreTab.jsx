import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Cpu, RefreshCw, KeyRound } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { openExternal } from '../../api/external';
import { setupDownloadStreamUrl } from '../../api/setup';
import { useModels, useRecommendations, useInstallModel, useDeleteModel } from '../../api/hooks';
import { Button, Segmented } from '../../ui';
import { SettingsSection, SettingsInput, SETTINGS_SECTION_SURFACE } from './primitives';
import { askConfirm } from './native';
import { fmtBytes } from './models/format';
import { computeRowRuntime } from './models/runtime';
import { reduceModelDownloadEvent, isAutoPurgeTerminal } from './models/downloadReducer';
import { makeModelColumns } from './models/columns';
import RecoBanner from './models/RecoBanner';
import ModelsTable from './models/ModelsTable';

const MODEL_ROLE_ORDER = ['tts', 'asr', 'diarisation', 'diarization', 'llm'];

/**
 * Model store — list every known HF model, show install state, let the
 * user install / reinstall / delete individual models. Per-model download
 * progress is pulled from the shared /setup/download-stream SSE.
 */
export default function ModelStoreTab({ info, modelBadge }) {
  const { t } = useTranslation();
  // Role labels — localized (diarization is an on-disk spelling alias for
  // diarisation; both map to the same label).
  const MODEL_ROLE_LABEL = useMemo(
    () => ({
      all: t('models.role_all'),
      tts: t('models.role_tts'),
      asr: t('models.role_asr'),
      diarisation: t('models.role_diarisation'),
      diarization: t('models.role_diarisation'),
      llm: t('models.role_llm'),
      other: t('models.role_other'),
    }),
    [t],
  );
  const modelsQuery = useModels();
  const recoQuery = useRecommendations();
  const data = modelsQuery.data;
  const loading = modelsQuery.isLoading;
  const reco = recoQuery.data;
  const installMutation = useInstallModel();
  const deleteMutation = useDeleteModel();

  const [busy, setBusy] = useState(new Set()); // repo_ids currently working
  // Per-repo active state. Tracks aggregate download across all files of
  // a running install so the row can show a determinate progress bar.
  // { [repo_id]: { phase, files: { [filename]: { downloaded, total, pct } }, error } }
  const [rowState, setRowState] = useState({});
  const [query, setQuery] = useState('');
  const [installingReco, setInstallingReco] = useState(false);
  const [activeRole, setActiveRole] = useState(null);
  const [sorting, setSorting] = useState([]);
  const [columnFilters, setColumnFilters] = useState([]);
  const esRef = React.useRef(null);
  const tableBodyRef = React.useRef(null);
  // Track download speed per repo: { [repo_id]: { lastBytes, lastTime, speed } }
  const speedRef = React.useRef({});
  // Tick counter — forces re-render every second while a download is active
  // so speed/ETA displays update smoothly between SSE events.
  const [, setTick] = useState(0);
  // Boolean derived from rowState so the interval effect below only re-runs
  // when activity starts/stops — not on every SSE progress event (several per
  // second during installs), which would clear + recreate the 1s tick forever.
  const hasActive = useMemo(
    () =>
      Object.values(rowState).some((s) =>
        ['install_start', 'active', 'delete_start'].includes(s.phase),
      ),
    [rowState],
  );
  useEffect(() => {
    if (!hasActive) return;
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [hasActive]);

  // HF token inline — compact input in the toolbar
  const [hfToken, setHfToken] = useState('');
  const [hfSaved, setHfSaved] = useState(false);
  const [hfSaving, setHfSaving] = useState(false);
  const [hfExpanded, setHfExpanded] = useState(false);
  const saveHfToken = async () => {
    const value = hfToken.trim();
    if (!value) return;
    setHfSaving(true);
    try {
      const { apiFetch } = await import('../../api/client');
      await apiFetch('/system/set-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'HF_TOKEN', value }),
      });
      toast.success(t('models.hf_token_set_toast'));
      setHfSaved(true);
      setHfToken('');
      setHfExpanded(false);
    } catch (e) {
      toast.error(t('settings.save_failed', { message: e.message }));
    } finally {
      setHfSaving(false);
    }
  };
  const hfTokenSet = hfSaved || info?.has_hf_token;

  // Open the progress stream once when the tab mounts; close on unmount.
  useEffect(() => {
    const es = new EventSource(setupDownloadStreamUrl());
    esRef.current = es;
    es.onmessage = (evt) => {
      try {
        const ev = JSON.parse(evt.data);
        if (!ev?.repo_id) return;
        // Pure reducer (see downloadReducer.js) — keeps every SSE transition,
        // including the "install_error persists" fix, unit-testable.
        setRowState((prev) => reduceModelDownloadEvent(prev, ev));
      } catch {
        /* keepalive / ignore */
      }
    };
    return () => es.close();
  }, []);

  // When a SUCCESS terminator fires (install_done / delete_done /
  // install_cancelled), refresh the list so "installed" flips server-side info
  // into the row, then purge the transient entry so the row reverts to the
  // authoritative `installed` flag. `install_error` is deliberately excluded
  // (isAutoPurgeTerminal) — an error row must persist with a Retry/Dismiss
  // affordance until the user acts on it (P1-A), instead of vanishing ~800ms
  // later and hiding the mirror-aware failure text.
  useEffect(() => {
    const term = Object.entries(rowState).find(([, s]) => isAutoPurgeTerminal(s.phase));
    if (!term) return;
    const t = setTimeout(() => {
      modelsQuery.refetch();
      recoQuery.refetch();
      // Clear stale speed data for this repo.
      delete speedRef.current[term[0]];
      setRowState((prev) => {
        const next = { ...prev };
        delete next[term[0]];
        return next;
      });
    }, 800);
    return () => clearTimeout(t);
  }, [rowState, modelsQuery, recoQuery]);

  const reload = useCallback(() => {
    modelsQuery.refetch();
    recoQuery.refetch();
  }, [modelsQuery, recoQuery]);

  const withBusy = useCallback(async (repoId, fn, successMsg) => {
    setBusy((prev) => new Set(prev).add(repoId));
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
    } catch (e) {
      toast.error(e.message || String(e));
    } finally {
      setBusy((prev) => {
        const s = new Set(prev);
        s.delete(repoId);
        return s;
      });
    }
  }, []);

  const onInstall = useCallback(
    (repoId) =>
      withBusy(repoId, () => installMutation.mutateAsync(repoId), t('models.install_started')),
    [installMutation, withBusy],
  );
  const onDelete = useCallback(
    async (repoId) => {
      if (
        !(await askConfirm(
          t('models.delete_confirm', { repoId }),
          t('models.delete_confirm_title'),
        ))
      )
        return;
      return withBusy(
        repoId,
        () => deleteMutation.mutateAsync(repoId),
        t('models.deleted', { repoId }),
      );
    },
    [deleteMutation, withBusy],
  );
  const onReinstall = useCallback(
    async (repoId) => {
      if (
        !(await askConfirm(
          t('models.reinstall_confirm', { repoId }),
          t('models.reinstall_confirm_title'),
        ))
      )
        return;
      await withBusy(
        repoId,
        async () => {
          await deleteMutation.mutateAsync(repoId);
          await installMutation.mutateAsync(repoId);
        },
        t('models.reinstalling'),
      );
    },
    [deleteMutation, installMutation, withBusy],
  );
  // Cancel an in-flight install (P2-A / FDL-11). Optimistically flip the row to
  // `install_cancelled` (an auto-purge terminal) for instant feedback; the
  // backend also emits `install_cancelled` when the retry loop unwinds.
  const onCancel = useCallback(async (repoId) => {
    try {
      const { cancelInstallModel } = await import('../../api/setup');
      await cancelInstallModel(repoId);
      setRowState((prev) => ({
        ...prev,
        [repoId]: { ...(prev[repoId] || { files: {} }), phase: 'install_cancelled' },
      }));
    } catch (e) {
      toast.error(e.message || String(e));
    }
  }, []);
  // Dismiss a persisted install_error row (P1-A): drop the transient entry so
  // the row reverts to its authoritative /models state, and refresh in case a
  // partial download changed on-disk state.
  const onDismissError = useCallback(
    (repoId) => {
      setRowState((prev) => {
        const next = { ...prev };
        delete next[repoId];
        return next;
      });
      delete speedRef.current[repoId];
      modelsQuery.refetch();
      recoQuery.refetch();
    },
    [modelsQuery, recoQuery],
  );

  const onInstallRecommended = async () => {
    if (!reco) return;
    const missing = reco.models.filter((m) => !m.installed);
    if (missing.length === 0) {
      toast.success(t('models.recommended_installed'));
      return;
    }
    setInstallingReco(true);
    try {
      // Parallel install — backend /models/install spawns each download on
      // its own asyncio task so ordering doesn't matter.
      await Promise.all(missing.map((m) => installMutation.mutateAsync(m.repo_id)));
      toast.success(t('models.started_downloading', { count: missing.length }));
    } catch (e) {
      toast.error(t('models.install_failed', { message: e.message || e }));
    } finally {
      setInstallingReco(false);
    }
  };

  const allModels = React.useMemo(() => data?.models || [], [data]);
  const groups = allModels.reduce((acc, m) => {
    const k = (m.role || 'other').toLowerCase();
    (acc[k] = acc[k] || []).push(m);
    return acc;
  }, {});
  const roles = Object.keys(groups).sort((a, b) => {
    const ai = MODEL_ROLE_ORDER.indexOf(a),
      bi = MODEL_ROLE_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  // 'all' is a virtual role — shows every model regardless of category.
  const currentRole =
    activeRole === 'all' ? 'all' : activeRole && groups[activeRole] ? activeRole : 'all';

  const allInstalled = allModels.filter((m) => m.installed).length;

  useEffect(() => {
    setColumnFilters(currentRole === 'all' ? [] : [{ id: 'role', value: currentRole }]);
  }, [currentRole]);

  const getRowRuntime = React.useCallback(
    (m) => computeRowRuntime(m, rowState, busy),
    [busy, rowState],
  );

  const columns = React.useMemo(
    () =>
      makeModelColumns({
        t,
        getRowRuntime,
        speedRef,
        MODEL_ROLE_LABEL,
        onInstall,
        onDelete,
        onReinstall,
        onCancel,
        onDismissError,
      }),
    [
      getRowRuntime,
      onDelete,
      onInstall,
      onReinstall,
      onCancel,
      onDismissError,
      MODEL_ROLE_LABEL,
      t,
    ],
  );

  const table = useReactTable({
    data: allModels,
    columns,
    getRowId: (row) => row.repo_id,
    state: {
      sorting,
      globalFilter: query,
      columnFilters,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setQuery,
    onColumnFiltersChange: setColumnFilters,
    globalFilterFn: (row, _columnId, value) => {
      const q = String(value || '')
        .trim()
        .toLowerCase();
      if (!q) return true;
      const m = row.original;
      return [m.repo_id, m.label, m.note, m.role]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => tableBodyRef.current,
    estimateSize: () => 68,
    overscan: 8,
  });

  if (loading && !data) {
    return (
      <SettingsSection icon={Cpu} title={t('settings.models')}>
        <div className="settings-muted font-sans text-[var(--text-md)] text-[var(--chrome-fg-dim)]">
          {t('common.loading')}
        </div>
      </SettingsSection>
    );
  }
  if (!data) return null;

  return (
    <section className={SETTINGS_SECTION_SURFACE} data-slot="settings-section">
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)] px-[2px] pb-[6px] pt-[2px] font-[family-name:var(--chrome-font-mono)] text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)] max-[580px]:flex-col max-[580px]:items-start">
        <div className="inline-flex flex-wrap items-center gap-[var(--space-2)]">
          <span>
            <strong className="font-semibold text-[var(--chrome-fg)]">
              {fmtBytes(data.total_installed_bytes)}
            </strong>
          </span>
          {data.disk_free_gb != null && (
            <>
              <span className="text-[var(--chrome-fg-dim)]">·</span>
              <span title={t('models.disk_free_title')}>
                {t('models.disk_free', { size: `${data.disk_free_gb} GB` })}
              </span>
            </>
          )}
          <span className="text-[var(--chrome-fg-dim)]">·</span>
          <span title={data.hf_cache_dir}>
            <code className="font-[family-name:var(--chrome-font-mono)] text-[length:var(--text-xs)] text-[var(--chrome-fg)]">
              {data.hf_cache_dir?.replace(/^\/Users\/[^/]+/, '~')}
            </code>
          </span>
          {info && <span className="text-[var(--chrome-fg-dim)]">·</span>}
          {info && <span>{modelBadge}</span>}
          {info?.fast_download?.xet_enabled && (
            <>
              <span className="text-[var(--chrome-fg-dim)]">·</span>
              <span
                className="text-[var(--chrome-accent)]"
                title={
                  t('models.fast_download_title', {
                    version: info.fast_download.xet_version || 'Xet',
                  }) ||
                  `Fast downloads via Xet ${info.fast_download.xet_version || ''} — parallel chunked transfer`
                }
              >
                ⚡ {t('models.fast_download_badge') || 'fast download'}
              </span>
            </>
          )}
        </div>
        <div className="inline-flex items-center gap-[var(--space-2)]">
          {/* Compact HF token inline */}
          {!hfTokenSet && !hfExpanded && (
            <button
              className="inline-flex cursor-pointer items-center gap-1 rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-border)] bg-transparent px-[var(--space-2)] py-[2px] text-[var(--chrome-fg-muted)] hover:bg-[var(--chrome-hover-bg)] hover:text-[var(--chrome-fg)]"
              onClick={() => setHfExpanded(true)}
              title={t('models.hf_set_title')}
            >
              <KeyRound size={11} /> {t('models.hf_token_btn')}
            </button>
          )}
          {!hfTokenSet && hfExpanded && (
            <div className="inline-flex items-center gap-[var(--space-2)]">
              <input
                type="password"
                className="min-w-0 rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-border)] bg-[var(--chrome-input-bg)] px-[var(--space-2)] py-[2px] font-[family-name:var(--chrome-font-mono)] text-[length:var(--text-xs)] text-[var(--chrome-fg)] placeholder:text-[var(--chrome-fg-dim)] focus-visible:border-[var(--chrome-accent)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
                placeholder="hf_xxxxxxxxxxxx"
                value={hfToken}
                onChange={(e) => setHfToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveHfToken();
                  if (e.key === 'Escape') setHfExpanded(false);
                }}
                autoFocus
              />
              <Button
                size="sm"
                variant="subtle"
                onClick={saveHfToken}
                disabled={hfSaving || !hfToken.trim()}
                loading={hfSaving}
              >
                {t('common.save')}
              </Button>
              <a
                href="#"
                className="text-[var(--chrome-accent)] no-underline hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  openExternal('https://huggingface.co/settings/tokens');
                }}
                title="Open huggingface.co/settings/tokens"
              >
                {t('models.get_token')}→
              </a>
            </div>
          )}
          {hfTokenSet && (
            <span className="inline-flex items-center gap-1 text-[var(--chrome-severity-ok)]">
              <KeyRound size={10} /> ✓
            </span>
          )}
          <Button
            variant="subtle"
            size="sm"
            onClick={reload}
            loading={loading}
            leading={<RefreshCw size={11} />}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      <RecoBanner
        reco={reco}
        t={t}
        installMutation={installMutation}
        installingReco={installingReco}
        setInstallingReco={setInstallingReco}
        onInstallRecommended={onInstallRecommended}
      />

      <div className="my-[var(--space-2)] flex items-center gap-[var(--space-2)] max-[580px]:flex-col max-[580px]:items-stretch">
        <Segmented
          size="sm"
          value={currentRole}
          onChange={setActiveRole}
          className="mb-[6px] mt-[4px]"
          items={[
            {
              value: 'all',
              label: `All ${allInstalled}/${allModels.length}`,
            },
            ...roles.map((r) => {
              const installed = groups[r].filter((m) => m.installed).length;
              return {
                value: r,
                label: `${MODEL_ROLE_LABEL[r] || r.toUpperCase()} ${installed}/${groups[r].length}`,
              };
            }),
          ]}
        />
        <SettingsInput
          type="search"
          className="max-w-none flex-1 text-[length:var(--text-xs)] min-w-[120px]"
          placeholder={t('models.search_placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('models.search_label')}
        />
      </div>

      <ModelsTable
        table={table}
        tableRows={tableRows}
        rowVirtualizer={rowVirtualizer}
        tableBodyRef={tableBodyRef}
        getRowRuntime={getRowRuntime}
        t={t}
      />
    </section>
  );
}
