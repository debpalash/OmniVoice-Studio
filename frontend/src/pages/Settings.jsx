import React, { useEffect, useState, useCallback } from 'react';
import {
  Cpu, FileText, Info, ShieldCheck, RefreshCw, Trash2, ExternalLink,
  CheckCircle, AlertCircle, Plug, Mic, MessageSquare, Download, Copy,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { systemInfo, systemLogs, systemLogsTauri, clearSystemLogs, clearTauriLogs, modelStatus as fetchModelStatus, sysinfo as fetchSysinfo } from '../api/system';
import { listEngines, selectEngine } from '../api/engines';
import { listModels, installModel, deleteModel, setupDownloadStreamUrl, getRecommendations } from '../api/setup';
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

/**
 * Model store — list every known HF model, show install state, let the
 * user install / reinstall / delete individual models. Per-model download
 * progress is pulled from the shared /setup/download-stream SSE.
 */
export function ModelStoreTab({ info, modelBadge }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(new Set()); // repo_ids currently working
  // Per-repo active state. Tracks aggregate download across all files of
  // a running install so the row can show a determinate progress bar.
  // { [repo_id]: { phase, files: { [filename]: { downloaded, total, pct } }, error } }
  const [rowState, setRowState] = useState({});
  const [query, setQuery] = useState('');
  const [reco, setReco] = useState(null);       // /setup/recommendations payload
  const [installingReco, setInstallingReco] = useState(false);
  const [activeRole, setActiveRole] = useState(null);
  const esRef = React.useRef(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await listModels()); }
    catch (e) { toast.error(`Failed to list models: ${e.message}`); }
    finally { setLoading(false); }
  }, []);

  const reloadReco = useCallback(async () => {
    try { setReco(await getRecommendations()); }
    catch (e) { /* non-fatal — Recommendation card just hides */ void e; }
  }, []);

  useEffect(() => { reload(); reloadReco(); }, [reload, reloadReco]);

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
      reload();
      // Clear the terminal entry so the row reverts to the authoritative
      // `installed` flag from /models without keeping stale progress.
      setRowState(prev => {
        const next = { ...prev };
        delete next[term[0]];
        return next;
      });
    }, 800);
    return () => clearTimeout(t);
  }, [rowState, reload]);

  const withBusy = async (repoId, fn, successMsg) => {
    setBusy(prev => new Set(prev).add(repoId));
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
      await reload();
    } catch (e) {
      toast.error(e.message || String(e));
    } finally {
      setBusy(prev => { const s = new Set(prev); s.delete(repoId); return s; });
    }
  };

  const onInstall = (repoId) => withBusy(repoId, () => installModel(repoId), 'Install started — progress in the row');
  const onDelete  = async (repoId) => {
    if (!(await askConfirm(`Delete ${repoId}? You can reinstall it later.`, 'Delete model'))) return;
    return withBusy(repoId, () => deleteModel(repoId), `Deleted ${repoId}`);
  };
  const onReinstall = async (repoId) => {
    if (!(await askConfirm(`Reinstall ${repoId}? This will delete the current copy and download again.`, 'Reinstall model'))) return;
    await withBusy(repoId, async () => {
      await deleteModel(repoId);
      await installModel(repoId);
    }, 'Reinstalling');
  };

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
      await Promise.all(missing.map(m => installModel(m.repo_id)));
      toast.success(`Started downloading ${missing.length} model${missing.length > 1 ? 's' : ''}`);
      await Promise.all([reload(), reloadReco()]);
    } catch (e) {
      toast.error(`Install failed: ${e.message || e}`);
    } finally {
      setInstallingReco(false);
    }
  };

  if (loading && !data) {
    return (
      <section className="settings-section">
        <h2><Cpu size={16} color="#f3a5b6" /> Models</h2>
        <div className="settings-muted">Loading…</div>
      </section>
    );
  }
  if (!data) return null;

  const groups = (data.models || []).reduce((acc, m) => {
    const k = (m.role || 'other').toLowerCase();
    (acc[k] = acc[k] || []).push(m);
    return acc;
  }, {});
  const ROLE_ORDER = ['tts', 'asr', 'diarisation', 'diarization', 'llm'];
  const ROLE_LABEL = { tts: 'TTS', asr: 'ASR', diarisation: 'Diarisation', diarization: 'Diarisation', llm: 'LLM', other: 'Other' };
  const roles = Object.keys(groups).sort((a, b) => {
    const ai = ROLE_ORDER.indexOf(a), bi = ROLE_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  const currentRole = activeRole && groups[activeRole] ? activeRole : roles[0];
  const q = query.trim().toLowerCase();
  const rows = (currentRole ? groups[currentRole] : []).filter(m =>
    !q || m.repo_id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q));

  const COLUMNS = [
    { key: 'name',    label: 'Model',   flex: 3 },
    { key: 'size',    label: 'Size',    width: 80,  align: 'right' },
    { key: 'status',  label: 'Status',  width: 110, align: 'center' },
    { key: 'actions', label: '',        width: 108, align: 'right' },
  ];

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
        <div className="reco-banner">
          <CheckCircle size={12} color="#8ec07c" />
          <span className="reco-banner__text">
            Recommended bundle installed for <strong>{reco.device.label}</strong>
          </span>
          <span className="reco-banner__size">{reco.total_gb} GB</span>
        </div>
      )}
      {reco && !reco.all_installed && (
        <div className="reco-banner reco-banner--action">
          <div className="reco-banner__body">
            <div className="reco-banner__title">Recommended for {reco.device.label}</div>
            <div className="reco-banner__rationale">{reco.rationale}</div>
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
        {roles.length > 1 && (
          <Segmented
            size="sm"
            value={currentRole}
            onChange={setActiveRole}
            className="models-roletabs"
            items={roles.map(r => {
              const installed = groups[r].filter(m => m.installed).length;
              return {
                value: r,
                label: `${ROLE_LABEL[r] || r.toUpperCase()} ${installed}/${groups[r].length}`,
              };
            })}
          />
        )}
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
        <Table.Header columns={COLUMNS} />
        <div className="models-table__body">
          {rows.map((m) => {
            const rs = rowState[m.repo_id];
            const rowBusy = busy.has(m.repo_id);
            const isInstalling = rs?.phase === 'install_start' || (rs?.phase === 'active' && !rs.files && !rs.error);
            const isDeleting = rs?.phase === 'delete_start';
            const phase = rs?.phase;
            // Aggregate current download progress across all in-flight files.
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
            return (
              <div key={m.repo_id} className={`models-row ${m.installed ? 'is-ok' : 'is-off'}`}>
                <div className="models-row__cell models-row__name" style={{ flex: 3 }}>
                  <span className="models-row__title">
                    {m.label}
                    {m.required && <span className="models-row__tag">required</span>}
                  </span>
                  <span className="models-row__repo">
                    <code>{m.repo_id}</code>
                    {m.note && <span className="models-row__note"> · {m.note}</span>}
                  </span>
                  {showBar && (
                    <div className="models-row__progressline">
                      <Progress
                        value={aggPct}
                        tone={isDeleting ? 'warn' : 'brand'}
                        size="xs"
                      />
                      <span className="models-row__progresstext">
                        {isDeleting
                          ? 'Removing cached revisions…'
                          : hasFiles
                            ? `${fmtBytes(totals.downloaded)}${totals.total ? ` / ${fmtBytes(totals.total)}` : ''} · ${fileList.length} file${fileList.length === 1 ? '' : 's'}${totals.done ? ` · ${totals.done} done` : ''}${activeFilename ? ` · ${activeFilename.split('/').pop()}` : ''}`
                            : 'Preparing download…'}
                      </span>
                    </div>
                  )}
                  {phase === 'install_error' && rs?.error && (
                    <span className="models-row__error">Install failed: {rs.error}</span>
                  )}
                </div>
                <div className="models-row__cell models-row__size" style={{ width: 80, textAlign: 'right' }}>
                  {m.installed ? fmtBytes(m.size_on_disk_bytes) : `${m.size_gb} GB`}
                </div>
                <div className="models-row__cell" style={{ width: 110, display: 'flex', justifyContent: 'center' }}>
                  {isInstalling
                    ? <Badge tone="warn" size="xs"><Download size={10} /> {aggPct != null ? `${Math.round(aggPct)}%` : 'downloading'}</Badge>
                    : isDeleting
                      ? <Badge tone="warn" size="xs"><Trash2 size={10} /> deleting</Badge>
                      : rowBusy
                        ? <Badge tone="warn" size="xs"><RefreshCw size={10} className="spinner" /> working</Badge>
                        : m.installed
                          ? <Badge tone="success" size="xs">installed</Badge>
                          : <Badge tone="neutral" size="xs">not installed</Badge>}
                </div>
                <div className="models-row__cell models-row__actions" style={{ width: 108 }}>
                  {!m.installed && !rowBusy && !isInstalling && (
                    <Button
                      variant="subtle" size="sm"
                      onClick={() => onInstall(m.repo_id)}
                      leading={<Download size={11} />}
                    >
                      Install
                    </Button>
                  )}
                  {m.installed && !rowBusy && !isDeleting && (
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
                </div>
              </div>
            );
          })}
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
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState(null);
  const [logSource, setLogSource] = useState('backend');
  const [logs, setLogs] = useState([]);
  const [logMeta, setLogMeta] = useState({ path: '', exists: false });
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const [tauriVersion, setTauriVersion] = useState(null);
  const [hw, setHw] = useState(null);
  const [updateState, setUpdateState] = useState('idle'); // idle|checking|downloading|uptodate|error

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

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const s = await fetchSysinfo();
        if (!cancelled) setHw(s);
      } catch { /* backend not up yet */ }
    };
    pull();
    const iv = setInterval(pull, 6000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

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

  const refreshInfo = useCallback(async () => {
    try {
      const [i, s] = await Promise.all([systemInfo(), fetchModelStatus()]);
      setInfo(i); setStatus(s);
    } catch (e) { /* ignore */ }
  }, []);

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
    refreshInfo();
    const iv = setInterval(refreshInfo, 4000);
    return () => clearInterval(iv);
  }, [refreshInfo]);

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
