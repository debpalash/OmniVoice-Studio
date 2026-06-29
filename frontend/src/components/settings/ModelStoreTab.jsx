import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Cpu, RefreshCw, KeyRound,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { openExternal } from '../../api/external';
import { setupDownloadStreamUrl } from '../../api/setup';
import { useModels, useRecommendations, useInstallModel, useDeleteModel } from '../../api/hooks';
import { Button, Segmented } from '../../ui';
import { SettingsSection, SettingsInput } from './primitives';
import { askConfirm } from './native';
import { fmtBytes } from './models/format';
import { computeRowRuntime } from './models/runtime';
import { makeModelColumns } from './models/columns';
import RecoBanner from './models/RecoBanner';
import ModelsTable from './models/ModelsTable';

const MODEL_ROLE_ORDER = ['tts', 'asr', 'diarisation', 'diarization', 'llm'];
const MODEL_ROLE_LABEL = { all: 'All', tts: 'TTS', asr: 'ASR', diarisation: 'Diarisation', diarization: 'Diarisation', llm: 'LLM', other: 'Other' };

/**
 * Model store — list every known HF model, show install state, let the
 * user install / reinstall / delete individual models. Per-model download
 * progress is pulled from the shared /setup/download-stream SSE.
 */
export default function ModelStoreTab({ info, modelBadge }) {
  const { t } = useTranslation();
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
  const hasActive = useMemo(() => Object.values(rowState).some(s =>
    ['install_start', 'active', 'delete_start'].includes(s.phase)), [rowState]);
  useEffect(() => {
    if (!hasActive) return;
    const iv = setInterval(() => setTick(t => t + 1), 1000);
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
    } catch (e) { toast.error(t('settings.save_failed', { message: e.message })); }
    finally { setHfSaving(false); }
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
        setRowState(prev => {
          const cur = prev[ev.repo_id] || { phase: 'active', files: {} };
          // Lifecycle events (install_start/install_done/install_error,
          // delete_start/delete_done) flip the row's phase without
          // touching per-file accounting.
          if (ev.phase === 'install_start' || ev.phase === 'delete_start') {
            return { ...prev, [ev.repo_id]: { phase: ev.phase, files: {}, error: null } };
          }
          // Heartbeat from backend while resolving repo metadata
          if (ev.phase === 'resolving') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'resolving', resolvingStep: ev.step || 0 } };
          }
          if (ev.phase === 'install_retry') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'install_retry', retryAttempt: ev.attempt, error: ev.error } };
          }
          if (ev.phase === 'install_done') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'install_done' } };
          }
          if (ev.phase === 'delete_done') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'delete_done' } };
          }
          if (ev.phase === 'install_error') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'install_error', error: ev.error } };
          }
          if (ev.phase === 'install_cancelled') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'install_cancelled' } };
          }
          // Pre-flight plan (FDL-05): accurate total/cached/remaining BEFORE
          // bytes flow. Keep the current phase (usually resolving) — the plan
          // is metadata, not a state change.
          if (ev.phase === 'install_plan') {
            return { ...prev, [ev.repo_id]: { ...cur, plan: {
              total_bytes: ev.total_bytes ?? null,
              cached_bytes: ev.cached_bytes ?? null,
              to_download_bytes: ev.to_download_bytes ?? null,
              n_files: ev.n_files ?? null,
              n_cached: ev.n_cached ?? null,
            } } };
          }
          // Overall aggregate (FDL-06): one rolling event that is the source of
          // truth for the overall bar / speed / remaining / ETA.
          if (ev.phase === 'aggregate') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'active', agg: {
              bytes_done: ev.bytes_done ?? 0,
              total_bytes: ev.total_bytes ?? null,
              rate: ev.rate ?? 0,
              eta_seconds: ev.eta_seconds ?? null,
              files_done: ev.files_done ?? 0,
              files_total: ev.files_total ?? null,
            } } };
          }
          // Per-file tqdm events — aggregate across files.
          const files = { ...cur.files, [ev.filename]: {
            downloaded: ev.downloaded || 0,
            total: ev.total || 0,
            pct: ev.pct || 0,
            phase: ev.phase,
            rate: ev.rate || 0,
          }};
          return { ...prev, [ev.repo_id]: { ...cur, phase: 'active', files } };
        });
      } catch { /* keepalive / ignore */ }
    };
    return () => es.close();
  }, []);

  // When a lifecycle terminator fires, refresh the list so "installed"
  // flips server-side info into the row.
  useEffect(() => {
    const term = Object.entries(rowState).find(([, s]) =>
      ['install_done', 'delete_done', 'install_error', 'install_cancelled'].includes(s.phase));
    if (!term) return;
    const t = setTimeout(() => {
      modelsQuery.refetch();
      recoQuery.refetch();
      // Clear stale speed data for this repo.
      delete speedRef.current[term[0]];
      // Clear the terminal entry so the row reverts to the authoritative
      // `installed` flag from /models without keeping stale progress.
      setRowState(prev => {
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
    setBusy(prev => new Set(prev).add(repoId));
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
    } catch (e) {
      toast.error(e.message || String(e));
    } finally {
      setBusy(prev => { const s = new Set(prev); s.delete(repoId); return s; });
    }
  }, []);

  const onInstall = useCallback((repoId) =>
    withBusy(repoId, () => installMutation.mutateAsync(repoId), t('models.install_started')),
    [installMutation, withBusy]);
  const onDelete = useCallback(async (repoId) => {
    if (!(await askConfirm(t('models.delete_confirm', { repoId }), t('models.delete_confirm_title')))) return;
    return withBusy(repoId, () => deleteMutation.mutateAsync(repoId), t('models.deleted', { repoId }));
  }, [deleteMutation, withBusy]);
  const onReinstall = useCallback(async (repoId) => {
    if (!(await askConfirm(t('models.reinstall_confirm', { repoId }), t('models.reinstall_confirm_title')))) return;
    await withBusy(repoId, async () => {
      await deleteMutation.mutateAsync(repoId);
      await installMutation.mutateAsync(repoId);
    }, t('models.reinstalling'));
  }, [deleteMutation, installMutation, withBusy]);

  const onInstallRecommended = async () => {
    if (!reco) return;
    const missing = reco.models.filter(m => !m.installed);
    if (missing.length === 0) {
      toast.success(t('models.recommended_installed'));
      return;
    }
    setInstallingReco(true);
    try {
      // Parallel install — backend /models/install spawns each download on
      // its own asyncio task so ordering doesn't matter.
      await Promise.all(missing.map(m => installMutation.mutateAsync(m.repo_id)));
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
    const ai = MODEL_ROLE_ORDER.indexOf(a), bi = MODEL_ROLE_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  // 'all' is a virtual role — shows every model regardless of category.
  const currentRole = activeRole === 'all' ? 'all'
    : activeRole && groups[activeRole] ? activeRole
    : 'all';

  const allInstalled = allModels.filter(m => m.installed).length;

  useEffect(() => {
    setColumnFilters(currentRole === 'all' ? [] : [{ id: 'role', value: currentRole }]);
  }, [currentRole]);

  const getRowRuntime = React.useCallback(
    (m) => computeRowRuntime(m, rowState, busy),
    [busy, rowState],
  );

  const columns = React.useMemo(
    () => makeModelColumns({ t, getRowRuntime, speedRef, MODEL_ROLE_LABEL, onInstall, onDelete, onReinstall }),
    [getRowRuntime, onDelete, onInstall, onReinstall, t],
  );

  const table = useReactTable({
    data: allModels,
    columns,
    getRowId: row => row.repo_id,
    state: {
      sorting,
      globalFilter: query,
      columnFilters,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setQuery,
    onColumnFiltersChange: setColumnFilters,
    globalFilterFn: (row, _columnId, value) => {
      const q = String(value || '').trim().toLowerCase();
      if (!q) return true;
      const m = row.original;
      return [m.repo_id, m.label, m.note, m.role]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(q));
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
        <div className="settings-muted">{t('common.loading')}</div>
      </SettingsSection>
    );
  }
  if (!data) return null;

  return (
    <section className="st-section">
      <div className="models-toolbar">
        <div className="models-toolbar__stats">
          <span><strong>{fmtBytes(data.total_installed_bytes)}</strong></span>
          <span className="models-toolbar__sep">·</span>
          <span className="models-toolbar__cache" title={data.hf_cache_dir}><code>{data.hf_cache_dir?.replace(/^\/Users\/[^/]+/, '~')}</code></span>
          {info && <span className="models-toolbar__sep">·</span>}
          {info && <span>{modelBadge}</span>}
          {info?.fast_download?.xet_enabled && (
            <>
              <span className="models-toolbar__sep">·</span>
              <span
                className="models-toolbar__fast"
                title={t('models.fast_download_title', {
                  version: info.fast_download.xet_version || 'Xet',
                }) || `Fast downloads via Xet ${info.fast_download.xet_version || ''} — parallel chunked transfer`}
              >
                ⚡ {t('models.fast_download_badge') || 'fast download'}
              </span>
            </>
          )}
        </div>
        <div className="models-toolbar__actions">
          {/* Compact HF token inline */}
          {!hfTokenSet && !hfExpanded && (
            <button
              className="models-toolbar__hf-btn"
              onClick={() => setHfExpanded(true)}
              title={t('models.hf_set_title')}
            >
              <KeyRound size={11} /> {t('models.hf_token_btn')}
            </button>
          )}
          {!hfTokenSet && hfExpanded && (
            <div className="models-toolbar__hf-row">
              <input
                type="password"
                className="models-toolbar__hf-input"
                placeholder="hf_xxxxxxxxxxxx"
                value={hfToken}
                onChange={e => setHfToken(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveHfToken(); if (e.key === 'Escape') setHfExpanded(false); }}
                autoFocus
              />
              <Button size="sm" variant="subtle" onClick={saveHfToken} disabled={hfSaving || !hfToken.trim()} loading={hfSaving}>
                {t('common.save')}
              </Button>
              <a
                href="#"
                className="models-toolbar__hf-link"
                onClick={e => { e.preventDefault(); openExternal('https://huggingface.co/settings/tokens'); }}
                title="Open huggingface.co/settings/tokens"
              >
                {t('models.get_token')}→
              </a>
            </div>
          )}
          {hfTokenSet && (
            <span className="models-toolbar__hf-ok"><KeyRound size={10} /> ✓</span>
          )}
          <Button variant="subtle" size="sm" onClick={reload} loading={loading} leading={<RefreshCw size={11} />}>
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

      <div className="models-controls">
        <Segmented
          size="sm"
          value={currentRole}
          onChange={setActiveRole}
          className="models-roletabs"
          items={[
            {
              value: 'all',
              label: `All ${allInstalled}/${allModels.length}`,
            },
            ...roles.map(r => {
              const installed = groups[r].filter(m => m.installed).length;
              return {
                value: r,
                label: `${MODEL_ROLE_LABEL[r] || r.toUpperCase()} ${installed}/${groups[r].length}`,
              };
            }),
          ]}
        />
        <SettingsInput
          type="search"
          className="models-search"
          placeholder={t('models.search_placeholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
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
