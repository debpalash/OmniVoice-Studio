import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Cpu, RefreshCw, Trash2, ExternalLink, CheckCircle, Download, KeyRound,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { openExternal } from '../../api/external';
import { setupDownloadStreamUrl } from '../../api/setup';
import { useModels, useRecommendations, useInstallModel, useDeleteModel } from '../../api/hooks';
import { Button, Badge, Table, Progress, Segmented } from '../../ui';
import { SettingsSection, SettingsInput } from './primitives';
import { askConfirm } from './native';

const MODEL_ROLE_ORDER = ['tts', 'asr', 'diarisation', 'diarization', 'llm'];
const MODEL_ROLE_LABEL = { all: 'All', tts: 'TTS', asr: 'ASR', diarisation: 'Diarisation', diarization: 'Diarisation', llm: 'LLM', other: 'Other' };

function fmtBytes(n) {
  if (n == null || n < 0) return '—';
  if (n === 0) return '0 B';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Deterministic muted HSL color from an org/user name in a repo_id. */
function orgColor(repoId) {
  const org = (repoId || '').split('/')[0];
  let h = 0;
  for (let i = 0; i < org.length; i++) h = (h * 31 + org.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360}, 35%, 28%)`;
}

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
      const { API } = await import('../../api/client');
      const res = await fetch(`${API}/system/set-env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'HF_TOKEN', value }),
      });
      if (res.ok) {
        toast.success(t('models.hf_token_set_toast'));
        setHfSaved(true);
        setHfToken('');
        setHfExpanded(false);
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.detail || t('models.hf_token_save_failed'));
      }
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

  const getRowRuntime = React.useCallback((m) => {
    const rs = rowState[m.repo_id];
    const rowBusy = busy.has(m.repo_id);
    const isInstalling = rs?.phase === 'install_start' || (rs?.phase === 'active' && !rs.files && !rs.error);
    const isDeleting = rs?.phase === 'delete_start';
    const phase = rs?.phase;
    const fileList = rs?.files ? Object.entries(rs.files) : [];
    const totals = fileList.reduce((a, [, f]) => ({
      downloaded: a.downloaded + (f.downloaded || 0),
      total: a.total + (f.total || 0),
      done: a.done + (f.phase === 'done' ? 1 : 0),
    }), { downloaded: 0, total: 0, done: 0 });
    // Sum backend-reported rate from active (non-done) files
    const backendRate = fileList
      .filter(([, f]) => f.phase !== 'done' && f.rate > 0)
      .reduce((s, [, f]) => s + f.rate, 0);
    const hasFiles = fileList.length > 0;
    const showBar = ['install_start', 'resolving', 'install_retry', 'active', 'delete_start'].includes(phase);
    const activeFilename = fileList.find(([, f]) => f.phase !== 'done')?.[0];
    const unsupported = m.supported === false;

    // Overall progress: prefer the backend aggregate (FDL-06) — it sums bytes
    // across all parallel files/chunks and samples a windowed rate, which is
    // accurate under Xet's parallel fetch. Fall back to per-file summation +
    // the frontend speed sampler only until the first aggregate event lands.
    const agg = rs?.agg || null;
    const plan = rs?.plan || null;
    const dispDownloaded = agg ? (agg.bytes_done || 0) : totals.downloaded;
    // Denominator: aggregate total → preflight "to download" → per-file totals.
    const dispTotal = (agg?.total_bytes ?? plan?.to_download_bytes ?? totals.total) || 0;
    // Bar %: prefer byte-fraction, but under Xet the byte bars don't advance
    // mid-download (only the file-count bar does), so fall back to the file
    // fraction so the bar still moves. Take the max so whichever signal is
    // live drives it; complete() flushes both to 100% at the end.
    const bytePct = dispTotal > 0 ? (dispDownloaded / dispTotal) * 100 : 0;
    const filesTotalForPct = agg?.files_total ?? plan?.n_files ?? 0;
    const filePct = filesTotalForPct > 0 ? ((agg?.files_done ?? 0) / filesTotalForPct) * 100 : 0;
    const aggPct = (dispTotal > 0 || filesTotalForPct > 0) ? Math.max(bytePct, filePct) : null;
    const cachedBytes = plan?.cached_bytes ?? null;
    const filesTotal = agg?.files_total ?? plan?.n_files ?? (hasFiles ? fileList.length : null);
    const filesDone = agg?.files_done ?? totals.done;
    // Backend rate (windowed aggregate) wins over the per-file rate sum.
    const aggRate = agg?.rate ?? null;
    const aggEtaSec = agg?.eta_seconds ?? null;

    return {
      rs,
      rowBusy,
      isInstalling,
      isDeleting,
      phase,
      fileList,
      totals,
      hasFiles,
      aggPct,
      showBar,
      activeFilename,
      unsupported,
      backendRate,
      agg,
      plan,
      dispDownloaded,
      dispTotal,
      cachedBytes,
      filesTotal,
      filesDone,
      aggRate,
      aggEtaSec,
    };
  }, [busy, rowState]);

  const columns = React.useMemo(() => [
    {
      id: 'name',
      accessorFn: m => `${m.label || ''} ${m.repo_id || ''}`,
      header: t('models.column_model'),
      size: 260,
      meta: { className: 'models-row__name' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        return (
          <>
            <span className="models-row__title">
              <span
                className="models-row__avatar"
                style={{ background: orgColor(m.repo_id) }}
                title={m.repo_id.split('/')[0]}
              >
                {m.repo_id.split('/')[0].slice(0, 2).toUpperCase()}
              </span>
              {m.label}
              {m.required && <span className="models-row__tag">{t('models.required_tag')}</span>}
            </span>
            <span className="models-row__repo">
              <code>{m.repo_id}</code>
              {m.note && <span className="models-row__note"> · {m.note}</span>}
            </span>
            {rt.showBar && (
              <div className="models-row__progressline">
                <Progress
                  value={rt.aggPct}
                  tone={rt.isDeleting ? 'warn' : 'brand'}
                  size="xs"
                />
                <span className="models-row__progresstext">
                  {(() => {
                    if (rt.isDeleting) return t('models.removing_cached');
                    const hasAgg = !!rt.agg;
                    if (!rt.hasFiles && !hasAgg) {
                      if (rt.phase === 'resolving') {
                        const dots = '.'.repeat((rt.rs?.resolvingStep || 0) % 4);
                        // Once the preflight plan lands we can show the real size
                        // even before the first byte (FDL-05).
                        const planBytes = rt.plan?.to_download_bytes;
                        const planStr = planBytes ? ` · ${fmtBytes(planBytes)} ${t('models.to_download') || 'to download'}` : '';
                        return `${t('models.resolving_metadata')}${dots}${planStr}`;
                      }
                      if (rt.phase === 'install_retry') {
                        return t('models.retry_attempt', { attempt: rt.rs?.retryAttempt || '?', error: rt.rs?.error || 'reconnecting' });
                      }
                      return t('models.connecting_hf');
                    }

                    // Prefer the backend aggregate's windowed rate (FDL-06).
                    // Fall back to the frontend sampler only until it arrives.
                    let speed = rt.aggRate ?? 0;
                    if (!(speed > 0)) {
                      const sp = speedRef.current[m.repo_id];
                      const now = Date.now();
                      if (sp && rt.dispDownloaded > 0) {
                        const dt = (now - sp.lastTime) / 1000;
                        if (dt >= 1) {
                          sp.speed = Math.max(0, (rt.dispDownloaded - sp.lastBytes) / dt);
                          sp.lastBytes = rt.dispDownloaded;
                          sp.lastTime = now;
                        }
                      } else {
                        speedRef.current[m.repo_id] = { lastBytes: rt.dispDownloaded, lastTime: now, speed: 0 };
                      }
                      speed = rt.backendRate > 0 ? rt.backendRate : (sp?.speed || 0);
                    }

                    // Total unknown and nothing downloaded yet → still resolving
                    if (rt.dispTotal === 0 && rt.dispDownloaded === 0) {
                      const activeFile = rt.activeFilename?.split('/').pop();
                      return activeFile
                        ? t('models.resolving_files_active', { count: rt.fileList.length, file: activeFile })
                        : t('models.resolving_files', { count: rt.fileList.length });
                    }

                    // ETA: prefer the backend's, else derive from remaining/speed.
                    const remaining = Math.max(0, rt.dispTotal - rt.dispDownloaded);
                    const etaSec = rt.aggEtaSec != null ? rt.aggEtaSec
                      : (speed > 0 && rt.dispTotal > 0 ? remaining / speed : 0);
                    const etaStr = etaSec > 0
                      ? etaSec < 60 ? `~${Math.ceil(etaSec)}s`
                      : etaSec < 3600 ? `~${Math.ceil(etaSec / 60)}m`
                      : `~${(etaSec / 3600).toFixed(1)}h`
                      : '';
                    const dlStr = fmtBytes(rt.dispDownloaded) || '0 B';
                    const totalStr = rt.dispTotal > 0 ? fmtBytes(rt.dispTotal) : '…';
                    const pctStr = rt.aggPct != null && rt.aggPct > 0 ? `${Math.round(rt.aggPct)}%` : '';
                    const speedStr = speed > 0 ? `${fmtBytes(speed)}/s` : '';

                    const parts = [
                      `${dlStr} / ${totalStr}`,
                      pctStr,
                      speedStr || (rt.dispDownloaded > 0 ? t('models.measuring') : ''),
                      etaStr,
                    ].filter(Boolean);

                    const extra = [];
                    if (rt.cachedBytes > 0) extra.push(`${fmtBytes(rt.cachedBytes)} ${t('models.cached') || 'cached'}`);
                    if (rt.filesTotal > 1) extra.push(t('models.files_progress', { done: rt.filesDone, total: rt.filesTotal }));
                    if (rt.activeFilename) extra.push(rt.activeFilename.split('/').pop());

                    return extra.length
                      ? `${parts.join(' · ')}  ⸱  ${extra.join(' · ')}`
                      : parts.join(' · ');
                  })()}
                </span>
              </div>
            )}
            {rt.phase === 'install_error' && rt.rs?.error && (
              <span className="models-row__error">{t('models.install_error', { error: rt.rs.error })}</span>
            )}
          </>
        );
      },
    },
    {
      id: 'role',
      accessorFn: m => (m.role || 'other').toLowerCase(),
      header: t('models.column_role'),
      size: 58,
      filterFn: (row, id, value) => !value || row.getValue(id) === value,
      cell: ({ row }) => <span className="models-row__role">{MODEL_ROLE_LABEL[row.getValue('role')] || row.original.role || 'Other'}</span>,
    },
    {
      id: 'size',
      accessorFn: m => m.installed ? (m.size_on_disk_bytes || 0) : (m.size_gb || 0) * 1024 ** 3,
      header: t('models.column_size'),
      size: 68,
      meta: { align: 'right', className: 'models-row__size' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        // During active download, show live downloaded / total
        if (rt.showBar && rt.hasFiles && rt.totals.total > 0) {
          return <span className="models-row__size-live">{fmtBytes(rt.totals.downloaded)}<span className="models-row__size-sep">/</span>{fmtBytes(rt.totals.total)}</span>;
        }
        return m.installed ? fmtBytes(m.size_on_disk_bytes) : `${m.size_gb} GB`;
      },
    },
    {
      id: 'status',
      accessorFn: m => m.installed ? 2 : (m.supported === false ? 0 : 1),
      header: t('models.column_status'),
      size: 96,
      meta: { align: 'center', className: 'models-row__status' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        return rt.isInstalling
          ? <Badge tone="warn" size="xs"><Download size={10} /> {rt.aggPct != null ? `${Math.round(rt.aggPct)}%` : t('models.downloading')}</Badge>
          : rt.isDeleting
            ? <Badge tone="warn" size="xs"><Trash2 size={10} /> {t('models.deleting')}</Badge>
            : rt.rowBusy
              ? <Badge tone="warn" size="xs"><RefreshCw size={10} className="spinner" /> {t('models.working')}</Badge>
              : m.installed
                ? <Badge tone="success" size="xs">{t('models.installed')}</Badge>
                : rt.unsupported
                  ? <Badge tone="neutral" size="xs">{(m.platforms || []).join(', ')}</Badge>
                  : <Badge tone="neutral" size="xs">{t('models.not_installed')}</Badge>;
      },
    },
    {
      id: 'actions',
      header: '',
      size: 90,
      enableSorting: false,
      meta: { align: 'right', className: 'models-row__actions' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        return (
          <>
            <Button
              variant="icon" iconSize="sm"
              onClick={() => openExternal(`https://huggingface.co/${m.repo_id}`)}
              title={t('models.view_on_hf')}
              aria-label={t('models.view_on_hf')}
            >
              <ExternalLink size={11} />
            </Button>
            {!m.installed && !rt.rowBusy && !rt.isInstalling && !rt.unsupported && (
              <Button
                variant="subtle" size="sm"
                onClick={() => onInstall(m.repo_id)}
                leading={<Download size={11} />}
              >
                {t('models.install_btn')}
              </Button>
            )}
            {m.installed && !rt.rowBusy && !rt.isDeleting && (
              <>
                <Button
                  variant="icon" iconSize="sm"
                  onClick={() => onReinstall(m.repo_id)}
                  title={t('models.reinstall_btn')}
                  aria-label={t('models.reinstall_btn')}
                >
                  <RefreshCw size={11} />
                </Button>
                <Button
                  variant="icon" iconSize="sm"
                  onClick={() => onDelete(m.repo_id)}
                  title={t('models.delete_btn')}
                  aria-label={t('models.delete_btn')}
                >
                  <Trash2 size={11} />
                </Button>
              </>
            )}
          </>
        );
      },
    },
  ], [getRowRuntime, onDelete, onInstall, onReinstall, t]);

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

      {reco && reco.all_installed && (
        <div className="reco-banner reco-banner--ok">
          <CheckCircle size={12} color="#8ec07c" />
          <span className="flex-1">{t('models.reco_installed_for', { device: reco.device.label })}</span>
          <span className="reco-banner__gb">{reco.total_gb} GB</span>
        </div>
      )}
      {reco && !reco.all_installed && (
        <div className="reco-banner reco-banner--pending">
          <div className="reco-banner__top">
            <span className="reco-banner__title">{t('models.reco_for', { device: reco.device.label })}</span>
            <div className="reco-banner__btns">
              {(() => {
                const requiredMissing = reco.models.filter(m => m.required && !m.installed);
                const requiredGb = requiredMissing.reduce((s, m) => s + m.size_gb, 0);
                if (requiredMissing.length === 0) return null;
                return (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={async () => {
                      setInstallingReco(true);
                      try {
                        await Promise.all(requiredMissing.map(m => installMutation.mutateAsync(m.repo_id)));
                        toast.success(t('models.started_downloading_required', { count: requiredMissing.length }));
                      } catch (e) { toast.error(t('models.install_failed', { message: e.message || e })); }
                      finally { setInstallingReco(false); }
                    }}
                    disabled={installingReco}
                    leading={installingReco ? <RefreshCw size={12} className="spinner" /> : null}
                  >
                    {installingReco ? t('models.starting') : t('models.required_size', { size: requiredGb.toFixed(1) })}
                  </Button>
                );
              })()}
              <Button variant="subtle" size="sm" onClick={onInstallRecommended} disabled={installingReco}>
                {t('models.all_size', { size: reco.download_gb_remaining })}
              </Button>
            </div>
          </div>
          <div className="reco-banner__grid">
            {reco.models.map(m => (
              <span key={m.repo_id} className={`reco-banner__model ${m.installed ? 'reco-banner__model--ok' : ''}`}>
                {m.installed ? '✓' : '○'} {m.label}
                <span className="reco-banner__model-size">{m.size_gb}</span>
                {m.required && <span className="reco-banner__req">{t('models.req_tag')}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

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

      <Table className="models-table">
        <div className="ui-table-header models-table__header">
          {table.getHeaderGroups().map(headerGroup => (
            <React.Fragment key={headerGroup.id}>
              {headerGroup.headers.map(header => {
                const meta = header.column.columnDef.meta || {};
                const canSort = header.column.getCanSort();
                return (
                  <button
                    key={header.id}
                    type="button"
                    className={[
                      'ui-table-header__cell',
                      `ui-table-header__cell--align-${meta.align || 'left'}`,
                      canSort ? 'models-table__sort' : 'models-table__sort--off',
                    ].join(' ')}
                    style={{ width: header.column.columnDef.size, flex: header.column.id === 'name' ? '1 1 auto' : '0 0 auto' }}
                    onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                    disabled={!canSort}
                    title={canSort ? t('models.sort_by', { column: String(header.column.columnDef.header || '') }) : undefined}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {header.column.getIsSorted() === 'asc' && <span className="models-table__sortmark">↑</span>}
                    {header.column.getIsSorted() === 'desc' && <span className="models-table__sortmark">↓</span>}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>
        <div ref={tableBodyRef} className="models-table__body">
          <div className="models-table__virtual" style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map(virtualRow => {
              const row = tableRows[virtualRow.index];
              const m = row.original;
              const rt = getRowRuntime(m);
              return (
                <div
                  key={row.id}
                  className={`models-row ${m.installed ? 'is-ok' : 'is-off'}${rt.unsupported ? ' is-unsupported' : ''}`}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.getVisibleCells().map(cell => {
                    const meta = cell.column.columnDef.meta || {};
                    return (
                      <div
                        key={cell.id}
                        className={`models-row__cell ${meta.className || ''}`}
                        style={{
                          width: cell.column.columnDef.size,
                          flex: cell.column.id === 'name' ? '1 1 auto' : '0 0 auto',
                          textAlign: meta.align || undefined,
                        }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {tableRows.length === 0 && (
              <div className="models-table__empty">{t('models.no_matches')}</div>
            )}
          </div>
        </div>
      </Table>
    </section>
  );
}
