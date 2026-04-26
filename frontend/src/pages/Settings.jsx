import React, { useEffect, useState, useCallback } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Cpu, FileText, Info, ShieldCheck, RefreshCw, Trash2, ExternalLink,
  CheckCircle, AlertCircle, Plug, Mic, MessageSquare, Download, Copy,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { systemLogs, systemLogsTauri, clearSystemLogs, clearTauriLogs } from '../api/system';
import { useSysinfo, useModelStatus, useSystemInfo } from '../api/hooks';
import { listEngines, selectEngine } from '../api/engines';
import { setupDownloadStreamUrl } from '../api/setup';
import { getFrontendLogs, clearFrontendLogs } from '../utils/consoleBuffer';
import { Tabs, Segmented, Button, Badge, Panel, Table, Progress } from '../ui';
import { useAppStore } from '../store';
import './Settings.css';

const TABS = [
  { id: 'models',  label: 'Models',  icon: Cpu,          accent: '#f3a5b6' },
  { id: 'engines', label: 'Engines', icon: Plug,         accent: '#d3869b' },
  { id: 'logs',    label: 'Logs',    icon: FileText,     accent: '#fabd2f' },
  { id: 'about',   label: 'About',   icon: Info,         accent: '#8ec07c' },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck,  accent: '#b8bb26' },
];

const FAMILY_META = {
  tts: { label: 'TTS', icon: Cpu,           tint: 'brand'   },
  asr: { label: 'ASR', icon: Mic,           tint: 'info'    },
  llm: { label: 'LLM', icon: MessageSquare, tint: 'violet'  },
};

const LOG_SOURCES = [
  { value: 'backend',  label: 'Backend' },
  { value: 'frontend', label: 'Frontend' },
  { value: 'tauri',    label: 'Tauri' },
];

const MODEL_ROLE_ORDER = ['tts', 'asr', 'diarisation', 'diarization', 'llm'];
const MODEL_ROLE_LABEL = { all: 'All', tts: 'TTS', asr: 'ASR', diarisation: 'Diarisation', diarization: 'Diarisation', llm: 'LLM', other: 'Other' };

function Row({ label, value, mono }) {
  return (
    <div className="settings-row">
      <span className="label">{label}</span>
      <span className={`value ${mono ? 'settings-row__mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function fmtBytes(n) {
  if (!n || n <= 0) return '—';
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

import { useModels, useRecommendations, useInstallModel, useDeleteModel } from '../api/hooks';

/**
 * Model store — list every known HF model, show install state, let the
 * user install / reinstall / delete individual models. Per-model download
 * progress is pulled from the shared /setup/download-stream SSE.
 */
export function ModelStoreTab({ info, modelBadge }) {
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
          if (ev.phase === 'install_done') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'install_done' } };
          }
          if (ev.phase === 'delete_done') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'delete_done' } };
          }
          if (ev.phase === 'install_error') {
            return { ...prev, [ev.repo_id]: { ...cur, phase: 'install_error', error: ev.error } };
          }
          // Per-file tqdm events — aggregate across files.
          const files = { ...cur.files, [ev.filename]: {
            downloaded: ev.downloaded || 0,
            total: ev.total || 0,
            pct: ev.pct || 0,
            phase: ev.phase,
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
      ['install_done', 'delete_done', 'install_error'].includes(s.phase));
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
    withBusy(repoId, () => installMutation.mutateAsync(repoId), 'Install started — progress in the row'),
    [installMutation, withBusy]);
  const onDelete = useCallback(async (repoId) => {
    if (!(await askConfirm(`Delete ${repoId}? You can reinstall it later.`, 'Delete model'))) return;
    return withBusy(repoId, () => deleteMutation.mutateAsync(repoId), `Deleted ${repoId}`);
  }, [deleteMutation, withBusy]);
  const onReinstall = useCallback(async (repoId) => {
    if (!(await askConfirm(`Reinstall ${repoId}? This will delete the current copy and download again.`, 'Reinstall model'))) return;
    await withBusy(repoId, async () => {
      await deleteMutation.mutateAsync(repoId);
      await installMutation.mutateAsync(repoId);
    }, 'Reinstalling');
  }, [deleteMutation, installMutation, withBusy]);

  const onInstallRecommended = async () => {
    if (!reco) return;
    const missing = reco.models.filter(m => !m.installed);
    if (missing.length === 0) {
      toast.success('Recommended models are already installed.');
      return;
    }
    setInstallingReco(true);
    try {
      // Parallel install — backend /models/install spawns each download on
      // its own asyncio task so ordering doesn't matter.
      await Promise.all(missing.map(m => installMutation.mutateAsync(m.repo_id)));
      toast.success(`Started downloading ${missing.length} model${missing.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast.error(`Install failed: ${e.message || e}`);
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
    const hasFiles = fileList.length > 0;
    const aggPct = totals.total > 0 ? (totals.downloaded / totals.total) * 100 : null;
    const showBar = phase === 'install_start' || phase === 'active' || phase === 'delete_start';
    const activeFilename = fileList.find(([, f]) => f.phase !== 'done')?.[0];
    const unsupported = m.supported === false;

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
    };
  }, [busy, rowState]);

  const columns = React.useMemo(() => [
    {
      id: 'name',
      accessorFn: m => `${m.label || ''} ${m.repo_id || ''}`,
      header: 'Model',
      size: 420,
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
              {m.required && <span className="models-row__tag">required</span>}
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
                  {rt.isDeleting
                    ? 'Removing cached revisions…'
                    : rt.hasFiles
                      ? (() => {
                          const sp = speedRef.current[m.repo_id];
                          const now = Date.now();
                          if (sp && rt.totals.downloaded > 0) {
                            const dt = (now - sp.lastTime) / 1000;
                            if (dt >= 2) {
                              sp.speed = Math.max(0, (rt.totals.downloaded - sp.lastBytes) / dt);
                              sp.lastBytes = rt.totals.downloaded;
                              sp.lastTime = now;
                            }
                          } else {
                            speedRef.current[m.repo_id] = { lastBytes: rt.totals.downloaded, lastTime: now, speed: 0 };
                          }
                          const speed = sp?.speed || 0;
                          const speedStr = speed > 0 ? ` · ${fmtBytes(speed)}/s` : '';
                          const pctStr = rt.aggPct != null ? ` (${Math.round(rt.aggPct)}%)` : '';
                          const parts = [
                            `${fmtBytes(rt.totals.downloaded)}${rt.totals.total ? ` / ${fmtBytes(rt.totals.total)}` : ''}${pctStr}${speedStr}`,
                          ];
                          if (rt.fileList.length > 1) {
                            parts.push(`${rt.totals.done}/${rt.fileList.length} files`);
                          }
                          if (rt.activeFilename) {
                            parts.push(rt.activeFilename.split('/').pop());
                          }
                          return parts.join(' · ');
                        })()
                      : 'Preparing download…'}
                </span>
              </div>
            )}
            {rt.phase === 'install_error' && rt.rs?.error && (
              <span className="models-row__error">Install failed: {rt.rs.error}</span>
            )}
          </>
        );
      },
    },
    {
      id: 'role',
      accessorFn: m => (m.role || 'other').toLowerCase(),
      header: 'Role',
      size: 92,
      filterFn: (row, id, value) => !value || row.getValue(id) === value,
      cell: ({ row }) => <span className="models-row__role">{MODEL_ROLE_LABEL[row.getValue('role')] || row.original.role || 'Other'}</span>,
    },
    {
      id: 'size',
      accessorFn: m => m.installed ? (m.size_on_disk_bytes || 0) : (m.size_gb || 0) * 1024 ** 3,
      header: 'Size',
      size: 86,
      meta: { align: 'right', className: 'models-row__size' },
      cell: ({ row }) => {
        const m = row.original;
        return m.installed ? fmtBytes(m.size_on_disk_bytes) : `${m.size_gb} GB`;
      },
    },
    {
      id: 'status',
      accessorFn: m => m.installed ? 2 : (m.supported === false ? 0 : 1),
      header: 'Status',
      size: 116,
      meta: { align: 'center', className: 'models-row__status' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        return rt.isInstalling
          ? <Badge tone="warn" size="xs"><Download size={10} /> {rt.aggPct != null ? `${Math.round(rt.aggPct)}%` : 'downloading'}</Badge>
          : rt.isDeleting
            ? <Badge tone="warn" size="xs"><Trash2 size={10} /> deleting</Badge>
            : rt.rowBusy
              ? <Badge tone="warn" size="xs"><RefreshCw size={10} className="spinner" /> working</Badge>
              : m.installed
                ? <Badge tone="success" size="xs">installed</Badge>
                : rt.unsupported
                  ? <Badge tone="neutral" size="xs">{(m.platforms || []).join(', ')}</Badge>
                  : <Badge tone="neutral" size="xs">not installed</Badge>;
      },
    },
    {
      id: 'actions',
      header: '',
      size: 118,
      enableSorting: false,
      meta: { align: 'right', className: 'models-row__actions' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        return (
          <>
            <Button
              variant="icon" iconSize="sm"
              onClick={() => window.open(`https://huggingface.co/${m.repo_id}`, '_blank', 'noopener,noreferrer')}
              title="View on HuggingFace"
              aria-label="View on HuggingFace"
            >
              <ExternalLink size={11} />
            </Button>
            {!m.installed && !rt.rowBusy && !rt.isInstalling && !rt.unsupported && (
              <Button
                variant="subtle" size="sm"
                onClick={() => onInstall(m.repo_id)}
                leading={<Download size={11} />}
              >
                Install
              </Button>
            )}
            {m.installed && !rt.rowBusy && !rt.isDeleting && (
              <>
                <Button
                  variant="icon" iconSize="sm"
                  onClick={() => onReinstall(m.repo_id)}
                  title="Reinstall"
                  aria-label="Reinstall"
                >
                  <RefreshCw size={11} />
                </Button>
                <Button
                  variant="icon" iconSize="sm"
                  onClick={() => onDelete(m.repo_id)}
                  title="Delete"
                  aria-label="Delete"
                >
                  <Trash2 size={11} />
                </Button>
              </>
            )}
          </>
        );
      },
    },
  ], [getRowRuntime, onDelete, onInstall, onReinstall]);

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
      <section className="settings-section">
        <h2><Cpu size={16} color="#f3a5b6" /> Models</h2>
        <div className="settings-muted">Loading…</div>
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="settings-section settings-section--compact">
      <div className="models-toolbar">
        <div className="models-toolbar__stats">
          <span><strong>{fmtBytes(data.total_installed_bytes)}</strong> on disk</span>
          <span className="models-toolbar__sep">·</span>
          <span className="models-toolbar__cache">cache: <code>{data.hf_cache_dir}</code></span>
          {info && <span className="models-toolbar__sep">·</span>}
          {info && <span>model: {modelBadge}</span>}
        </div>
        <Button variant="subtle" size="sm" onClick={reload} loading={loading} leading={<RefreshCw size={11} />}>
          Refresh
        </Button>
      </div>

      {reco && reco.all_installed && (
        <div className="mb-4 flex items-center gap-3 rounded-[var(--chrome-radius-pill)] border border-[color-mix(in_srgb,#8ec07c_30%,transparent)] border-l-2 border-l-[#8ec07c] bg-[color-mix(in_srgb,#8ec07c_5%,transparent)] px-4 py-[6px] font-[var(--font-sans)] text-[var(--text-sm)] text-[var(--chrome-fg-muted)]">
          <CheckCircle size={12} color="#8ec07c" />
          <span className="flex-1">
            Recommended bundle installed for <strong>{reco.device.label}</strong>
          </span>
          <span className="text-[var(--text-xs)] text-[var(--chrome-fg-dim)]">{reco.total_gb} GB</span>
        </div>
      )}
      {reco && !reco.all_installed && (
        <div className="mb-4 flex flex-wrap items-start gap-3 rounded-[var(--chrome-radius-pill)] border border-[color-mix(in_srgb,#f3a5b6_30%,transparent)] border-l-2 border-l-[#f3a5b6] bg-[color-mix(in_srgb,#f3a5b6_5%,transparent)] px-4 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="text-[var(--text-sm)] font-semibold text-[var(--chrome-fg)]">Recommended for {reco.device.label}</div>
            <div className="text-[var(--text-xs)] leading-[1.4] text-[var(--chrome-fg-muted)]">{reco.rationale}</div>
            <div className="mt-1 flex flex-col gap-0.5">
              {reco.models.map(m => (
                <span key={m.repo_id} className={`inline-flex items-center gap-2 text-[var(--text-xs)] leading-[1.5] ${m.installed ? 'text-[var(--chrome-fg)]' : 'text-[var(--chrome-fg-muted)]'}`}>
                  {m.installed ? '✓' : '○'} {m.label}
                  <span className="font-[var(--chrome-font-mono)] text-[var(--text-2xs)] text-[var(--chrome-fg-dim)]">{m.size_gb} GB</span>
                  {m.required && (
                    <span className="rounded-[var(--chrome-radius-pill,999px)] border border-[color-mix(in_srgb,#d3869b_35%,transparent)] px-1 text-[0.58rem] uppercase tracking-[0.04em] text-[#d3869b]">
                      required
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={onInstallRecommended}
            disabled={installingReco}
            leading={installingReco ? <RefreshCw size={12} className="spinner" /> : null}
          >
            {installingReco ? 'Starting…' : `Install ~${reco.download_gb_remaining} GB`}
          </Button>
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
        <input
          type="search"
          className="models-search"
          placeholder="Search models…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search models"
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
                    title={canSort ? `Sort by ${String(header.column.columnDef.header || '')}` : undefined}
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
              <div className="models-table__empty">No models match your filters.</div>
            )}
          </div>
        </div>
      </Table>
    </section>
  );
}


export function EnginesTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(null);
  const [activeFam, setActiveFam] = useState('tts');
  const reviewMode = useAppStore(s => s.reviewMode);
  const setReviewMode = useAppStore(s => s.setReviewMode);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await listEngines()); }
    catch (e) { toast.error(`Failed to load engines: ${e.message}`); }
    finally { setLoading(false); }
  }, []);

  const onSelect = useCallback(async (family, backendId) => {
    setSwitching(`${family}:${backendId}`);
    try {
      const r = await selectEngine(family, backendId);
      toast.success(`${family.toUpperCase()} → ${r.active}`);
      await reload();
    } catch (e) {
      toast.error(e.message || 'Failed to switch engine');
    } finally {
      setSwitching(null);
    }
  }, [reload]);

  useEffect(() => { reload(); }, [reload]);

  if (loading && !data) {
    return <section className="settings-section"><div className="settings-muted">Loading engines…</div></section>;
  }
  if (!data) return null;

  const fams = ['tts', 'asr', 'llm'].filter(f => data[f]);
  const currentFam = fams.includes(activeFam) ? activeFam : fams[0];
  const family = currentFam ? data[currentFam] : null;
  const famTint = currentFam ? FAMILY_META[currentFam].tint : 'neutral';

  const COLUMNS = [
    { key: 'name',    label: 'Backend', flex: 3 },
    { key: 'status',  label: 'Status',  width: 120, align: 'center' },
    { key: 'action',  label: '',        width: 90,  align: 'right' },
  ];

  return (
    <section className="settings-section settings-section--compact">
      <div className="models-toolbar">
        <div className="models-toolbar__stats">
          <Segmented
            size="xs"
            value={reviewMode}
            onChange={setReviewMode}
            items={[
              { value: 'on',  label: 'Review' },
              { value: 'off', label: 'Rapid-fire' },
            ]}
          />
          <span className="models-toolbar__sep">·</span>
          <span>
            {reviewMode === 'on' ? 'Stage banners on' : 'Stage banners off'}
          </span>
        </div>
        <Button variant="subtle" size="sm" onClick={reload} loading={loading} leading={<RefreshCw size={11} />}>
          Refresh
        </Button>
      </div>

      {fams.length > 1 && (
        <Segmented
          size="sm"
          value={currentFam}
          onChange={setActiveFam}
          className="models-roletabs"
          items={fams.map(f => ({
            value: f,
            label: `${FAMILY_META[f].label} · ${data[f].active}`,
          }))}
        />
      )}

      {family && (
        <Table className="models-table">
          <Table.Header columns={COLUMNS} />
          <div className="models-table__body">
            {family.backends.map(b => {
              const isActive = family.active === b.id;
              const isSwitching = switching === `${currentFam}:${b.id}`;
              return (
                <div key={b.id} className={`models-row ${b.available ? 'is-ok' : 'is-off'}`}>
                  <div className="models-row__cell models-row__name" style={{ flex: 3 }}>
                    <span className="models-row__title">
                      {b.display_name}
                      {isActive && <Badge tone={famTint} size="xs">active</Badge>}
                    </span>
                    <span className="models-row__repo">
                      <code>{b.id}</code>
                      {!b.available && b.reason && <span className="models-row__note"> · {b.reason}</span>}
                    </span>
                  </div>
                  <div className="models-row__cell" style={{ width: 120, display: 'flex', justifyContent: 'center' }}>
                    {b.available
                      ? <Badge tone="success" size="xs">ready</Badge>
                      : <Badge tone="warn" size="xs">unavailable</Badge>}
                  </div>
                  <div className="models-row__cell models-row__actions" style={{ width: 90 }}>
                    {!isActive && b.available && (
                      <Button
                        variant="subtle" size="sm"
                        onClick={() => onSelect(currentFam, b.id)}
                        loading={isSwitching}
                      >
                        Use
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Table>
      )}
    </section>
  );
}


const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Tauri v2's webview disables native window.confirm/alert — they return
// false silently, making Delete/Reinstall buttons appear dead. Route through
// the dialog plugin when running in Tauri, fall back to browser confirm
// elsewhere (vite dev, tests).
async function askConfirm(message, title = 'Confirm') {
  if (isTauri()) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, { title, kind: 'warning' });
  }
  return Promise.resolve(window.confirm(message));
}

export default function Settings() {
  const [activeTab, setActiveTab] = useState('models');
  const [logSource, setLogSource] = useState('backend');
  const [logs, setLogs] = useState([]);
  const [logMeta, setLogMeta] = useState({ path: '', exists: false });
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const [tauriVersion, setTauriVersion] = useState(null);
  const [updateState, setUpdateState] = useState('idle'); // idle|checking|downloading|uptodate|error

  // TanStack Query — shared cache with App.jsx, no duplicate requests
  const { data: hw } = useSysinfo();
  const { data: status } = useModelStatus();
  const { data: info } = useSystemInfo();

  useEffect(() => {
    if (!isTauri()) return;
    (async () => {
      try {
        const app = await import('@tauri-apps/api/app');
        setAppVersion(await app.getVersion());
        if (app.getTauriVersion) setTauriVersion(await app.getTauriVersion());
      } catch { /* web preview */ }
    })();
  }, []);

  // sysinfo polling is now handled by useSysinfo() hook above

  const copyDiagnostics = useCallback(async () => {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const ua = nav.userAgent || '—';
    const lang = nav.language || '—';
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return '—'; } })();
    const fmtGB = (v) => (typeof v === 'number' ? `${v.toFixed(2)} GB` : '—');
    const lines = [
      '### OmniVoice Studio diagnostics',
      '',
      `- **App version:** ${appVersion || '—'}`,
      `- **Tauri runtime:** ${tauriVersion || (isTauri() ? '—' : 'web preview')}`,
      `- **Platform:** ${info?.platform || '—'}`,
      `- **Architecture:** ${nav.userAgentData?.platform || nav.platform || '—'}`,
      `- **Locale / timezone:** ${lang} / ${tz}`,
      `- **Python:** ${info?.python || '—'}`,
      `- **Compute device:** ${info?.device || '—'}`,
      `- **GPU active:** ${hw?.gpu_active ? 'yes' : 'no'}`,
      `- **RAM:** ${fmtGB(hw?.ram)} used / ${fmtGB(hw?.total_ram)} total`,
      `- **VRAM (allocated):** ${fmtGB(hw?.vram)}`,
      `- **Backend status:** ${status?.status || 'unknown'}`,
      `- **Active model:** ${status?.repo_id || info?.model_checkpoint || '—'}`,
      `- **ASR model:** ${info?.asr_model || '—'}`,
      `- **Translator:** ${info?.translate_provider || '—'}`,
      `- **HF token set:** ${info?.has_hf_token ? 'yes' : 'no'}`,
      `- **Data directory:** ${info?.data_dir || '—'}`,
      `- **Outputs directory:** ${info?.outputs_dir || '—'}`,
      `- **Crash log:** ${info?.crash_log_path || '—'}`,
      `- **Update endpoint:** https://github.com/debpalash/OmniVoice-Studio/releases/latest/download/latest.json`,
      `- **User agent:** ${ua}`,
    ];
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Diagnostics copied — paste into your issue report.');
    } catch (e) {
      toast.error('Copy failed: ' + (e?.message || e));
    }
  }, [appVersion, tauriVersion, info, status, hw]);

  const checkForUpdates = useCallback(async () => {
    if (!isTauri()) {
      toast('Updater only runs in the desktop app.', { icon: 'ℹ️' });
      return;
    }
    setUpdateState('checking');
    try {
      const [{ check }, { relaunch }, { ask }] = await Promise.all([
        import('@tauri-apps/plugin-updater'),
        import('@tauri-apps/plugin-process'),
        import('@tauri-apps/plugin-dialog'),
      ]);
      const update = await check();
      if (!update) {
        setUpdateState('uptodate');
        toast.success("You're on the latest version.");
        return;
      }
      const proceed = await ask(
        `Version ${update.version} is available.\n\n${update.body || 'See release notes on GitHub.'}\n\nDownload and install now?`,
        { title: 'Update available', kind: 'info' },
      );
      if (!proceed) { setUpdateState('idle'); return; }
      setUpdateState('downloading');
      const t = toast.loading(`Downloading ${update.version}…`);
      await update.downloadAndInstall();
      toast.success('Installed — relaunching.', { id: t });
      await relaunch();
    } catch (e) {
      setUpdateState('error');
      toast.error('Update check failed: ' + (e?.message || e));
    }
  }, []);

  // refreshInfo polling replaced by TanStack Query (useSystemInfo + useModelStatus)
  const refreshInfo = useCallback(() => {}, []);

  const refreshLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      if (logSource === 'backend') {
        const r = await systemLogs(400);
        setLogs(r.lines || []);
        setLogMeta({ path: r.path || '', exists: !!r.exists });
      } else if (logSource === 'tauri') {
        const r = await systemLogsTauri(400);
        setLogs(r.lines || []);
        setLogMeta({ path: r.path || '—', exists: !!r.exists, candidates: r.candidates });
      } else {
        const entries = getFrontendLogs();
        const lines = entries.map((e) => {
          const ts = new Date(e.t).toISOString().slice(11, 23);
          return `[${ts}] [${e.level}] ${e.msg}\n`;
        });
        setLogs(lines);
        setLogMeta({ path: 'in-memory (last 500)', exists: true });
      }
    } catch (e) {
      toast.error('Failed to load logs: ' + e.message);
    } finally {
      setLoadingLogs(false);
    }
  }, [logSource]);

  useEffect(() => {
    if (activeTab === 'logs') refreshLogs();
  }, [activeTab, logSource, refreshLogs]);

  const onClearLogs = async () => {
    if (logSource === 'frontend') {
      if (!(await askConfirm('Clear the in-memory frontend log buffer?', 'Clear logs'))) return;
      clearFrontendLogs();
      toast.success('Frontend logs cleared');
      setLogs([]);
      return;
    }
    if (logSource === 'tauri') {
      if (!(await askConfirm('Truncate the Tauri-side log files? The OS will continue to write new entries.', 'Clear Tauri logs'))) return;
      try {
        const r = await clearTauriLogs();
        if (!r?.cleared?.length) {
          toast('Nothing to clear — no Tauri log file on disk yet.', { icon: 'ℹ️' });
        } else {
          toast.success(`Cleared ${r.cleared.length} Tauri log file(s)`);
          setLogs([]);
        }
      } catch (e) {
        toast.error('Failed to clear Tauri logs: ' + e.message);
      }
      return;
    }
    if (!(await askConfirm('Clear the backend runtime + crash logs? This cannot be undone.', 'Clear logs'))) return;
    try {
      await clearSystemLogs();
      toast.success('Backend logs cleared');
      setLogs([]);
    } catch (e) {
      toast.error('Failed to clear logs');
    }
  };

  const modelBadge =
    status?.status === 'ready'   ? <Badge tone="success"><CheckCircle size={11} /> Ready</Badge>
  : status?.status === 'loading' ? <Badge tone="warn"><RefreshCw size={11} className="spinner" /> Loading…</Badge>
                                 : <Badge tone="warn">Idle</Badge>;

  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <div className="settings-subtitle">
        Where your files live, what the model's doing, and what's gone wrong lately.
      </div>

      <Tabs
        items={TABS}
        value={activeTab}
        onChange={setActiveTab}
        className="settings-tabs-ui"
      />

      {activeTab === 'models' && <ModelStoreTab info={info} modelBadge={modelBadge} />}

      {activeTab === 'engines' && <EnginesTab />}

      {activeTab === 'logs' && (
        <section className="settings-section">
          <h2 className="settings-section__head-row">
            <span className="settings-section__head-left">
              <FileText size={16} color="#fabd2f" /> Logs
            </span>
            <span className="settings-section__head-actions">
              <Button
                variant="subtle"
                size="sm"
                onClick={refreshLogs}
                loading={loadingLogs}
                leading={!loadingLogs && <RefreshCw size={11} />}
              >
                Refresh
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={onClearLogs}
                leading={<Trash2 size={11} />}
              >
                Clear
              </Button>
            </span>
          </h2>

          <Segmented
            items={LOG_SOURCES}
            value={logSource}
            onChange={setLogSource}
          />

          <div className="settings-log-meta">
            <span>{logMeta.path || '—'}</span>
            {logSource === 'tauri' && !logMeta.exists && (
              <Badge tone="warn">
                <AlertCircle size={11} /> No Tauri log on disk yet — launch via the desktop build to produce one
              </Badge>
            )}
          </div>
          <div className="settings-log">
            {logs.length === 0
              ? <span className="settings-log__empty">
                  {logSource === 'frontend'
                    ? 'No frontend console entries captured yet. Interact with the app — every console.* will appear here.'
                    : logSource === 'tauri'
                      ? 'No Tauri log available. Runs in the desktop shell only.'
                      : "Runtime log is empty. Activity will appear here as the backend logs it."}
                </span>
              : logs.join('')}
          </div>
        </section>
      )}

      {activeTab === 'about' && (
        <section className="settings-section">
          <h2><Info size={16} color="#8ec07c" /> About</h2>
          <Row label="App"             value="OmniVoice Studio" />
          <Row label="Version"         value={appVersion || '—'} mono />
          <Row label="Tauri runtime"   value={tauriVersion || (isTauri() ? '—' : 'web preview')} mono />
          <Row label="Platform"        value={info?.platform || '—'} />
          <Row label="Architecture"    value={typeof navigator !== 'undefined' ? (navigator.userAgentData?.platform || navigator.platform || '—') : '—'} mono />
          <Row label="Python"          value={info?.python || '—'} mono />
          <Row label="Compute device"  value={info?.device || '—'} mono />
          <Row label="GPU active"      value={hw?.gpu_active
            ? <Badge tone="success"><CheckCircle size={11} /> yes</Badge>
            : <Badge tone="neutral">no</Badge>} />
          <Row label="RAM"             value={hw ? `${hw.ram?.toFixed(2)} / ${hw.total_ram?.toFixed(2)} GB` : '—'} mono />
          <Row label="VRAM"            value={hw ? `${hw.vram?.toFixed(2)} GB` : '—'} mono />
          <Row label="Backend"         value={<Badge tone={status?.status === 'ready' ? 'success' : status?.status === 'loading' ? 'warn' : 'neutral'}>{status?.status || 'unknown'}</Badge>} />
          <Row label="Active model"    value={status?.repo_id || info?.model_checkpoint || '—'} mono />
          <Row label="ASR model"       value={info?.asr_model || '—'} mono />
          <Row label="Translator"      value={info?.translate_provider || '—'} />
          <Row label="HF token set"    value={info?.has_hf_token ? 'yes' : 'no'} />
          <Row label="Data directory"  value={info?.data_dir || '—'} mono />
          <Row label="Outputs"         value={info?.outputs_dir || '—'} mono />
          <Row label="Crash log"       value={info?.crash_log_path || '—'} mono />
          <Row label="Update endpoint" value="releases/latest/download/latest.json" mono />
          <div className="settings-link-row">
            <Button
              variant="primary"
              size="md"
              leading={<Download size={12} />}
              onClick={checkForUpdates}
              loading={updateState === 'checking' || updateState === 'downloading'}
              disabled={!isTauri()}
            >
              {updateState === 'downloading' ? 'Downloading…' : 'Check for updates'}
            </Button>
            <Button
              variant="subtle"
              size="md"
              leading={<Copy size={12} />}
              onClick={copyDiagnostics}
            >
              Copy diagnostics
            </Button>
            <Button
              variant="subtle"
              size="md"
              leading={<ExternalLink size={12} />}
              onClick={() => window.open('https://github.com/k2-fsa/OmniVoice', '_blank', 'noopener,noreferrer')}
            >
              OmniVoice on GitHub
            </Button>
            <Button
              variant="subtle"
              size="md"
              leading={<ExternalLink size={12} />}
              onClick={() => window.open('https://huggingface.co/k2-fsa/OmniVoice', '_blank', 'noopener,noreferrer')}
            >
              Model card
            </Button>
          </div>
        </section>
      )}

      {activeTab === 'privacy' && (
        <section className="settings-section">
          <h2><ShieldCheck size={16} color="#b8bb26" /> Privacy</h2>
          <p className="settings-prose">
            Everything runs on <strong>this machine</strong>. Your audio, video, and transcripts
            never leave your computer unless you explicitly use an online translator (Google, DeepL, etc.) or
            push to HuggingFace.
          </p>
          <Row label="Uploads stored at"   value={info?.data_dir ? `${info.data_dir}/` : '—'} mono />
          <Row label="Outputs stored at"   value={info?.outputs_dir || '—'} mono />
          <Row label="Generation history"  value={<Badge tone="neutral">Local SQLite</Badge>} />
          <Row
            label="Network calls"
            value={
              info?.translate_provider && ['google', 'deepl', 'mymemory', 'microsoft', 'openai'].includes(info.translate_provider)
                ? <Badge tone="warn"><AlertCircle size={11} /> Translator is online: {info.translate_provider}</Badge>
                : <Badge tone="success"><CheckCircle size={11} /> Offline translator</Badge>
            }
          />
          <Row
            label="Model telemetry"
            value={<Badge tone="success"><CheckCircle size={11} /> None — no tracking</Badge>}
          />
        </section>
      )}
    </div>
  );
}
