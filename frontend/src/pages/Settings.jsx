import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { copyText } from "../utils/copyText";
import { isTauri as _isTauri } from '../utils/media';
import { normalizeChannel } from '../utils/updateChannel';
import { setChannel } from '../utils/channelControl';
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
  CheckCircle, AlertCircle, Plug, Download, Copy, Building2, KeyRound,
  Keyboard, Wifi, Palette, Activity, ArrowDownToLine,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { openExternal } from '../api/external';
import { API } from '../api/client';
import { addBreadcrumb } from '../utils/breadcrumbs';
import { Trans, useTranslation } from 'react-i18next';
import { systemLogs, systemLogsTauri, clearSystemLogs, clearTauriLogs } from '../api/system';
import i18n, { LANGUAGES } from '../i18n';
import { useSysinfo, useModelStatus, useSystemInfo, queryKeys } from '../api/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { selectEngine } from '../api/engines';
import { setupDownloadStreamUrl } from '../api/setup';
import { getFrontendLogs, clearFrontendLogs } from '../utils/consoleBuffer';
import { resolveAboutVersion } from '../utils/appVersion';
import { Tabs, Segmented, Button, Badge, Table, Progress, Select } from '../ui';
import { useAppStore } from '../store';
import ApiKeysPanel from '../components/settings/ApiKeysPanel';
import LLMEndpointPanel from '../components/settings/LLMEndpointPanel';
import PerformancePanel from '../components/settings/PerformancePanel';
import RefinementPanel from '../components/settings/RefinementPanel';
import AecPanel from '../components/settings/AecPanel';
import VoicePanel from '../components/settings/VoicePanel';
import AppearancePanel from '../components/settings/AppearancePanel';
import StoragePanel from '../components/settings/StoragePanel';
import HFMirrorPanel from '../components/settings/HFMirrorPanel';
import SharingPanel from '../components/settings/SharingPanel';
import RemoteBackendPanel from '../components/settings/RemoteBackendPanel';
import MCPBindingsPanel from '../components/settings/MCPBindingsPanel';
import PronunciationPanel from '../components/settings/PronunciationPanel';
import EngineCompatibilityMatrix from '../components/EngineCompatibilityMatrix';
import DictationDemo from '../components/DictationDemo';
import UpdatesPanel from '../components/UpdatesPanel';
import ReportBugButton from '../components/ReportBugButton';
import './Settings.css';

const TAB_DEFS = [
  { id: 'general',     icon: FileText,      accent: '#83a598' },
  { id: 'models',      icon: Cpu,           accent: '#f3a5b6' },
  { id: 'engines',     icon: Plug,          accent: '#d3869b' },
  { id: 'capture',     icon: Keyboard,      accent: '#83a598' },
  { id: 'sharing',     icon: Wifi,          accent: '#83a598' },
  { id: 'appearance',  icon: Palette,       accent: '#d3869b' },
  { id: 'credentials', icon: KeyRound,      accent: '#fe8019' },
  { id: 'updates',     icon: ArrowDownToLine, accent: '#b8bb26' },
  { id: 'logs',        icon: FileText,      accent: '#fabd2f' },
  { id: 'about',       icon: Info,          accent: '#8ec07c' },
  { id: 'privacy',     icon: ShieldCheck,   accent: '#b8bb26' },
];

const LOG_SOURCE_DEFS = [
  { value: 'backend',  key: 'backend' },
  { value: 'frontend', key: 'frontend' },
  { value: 'tauri',    key: 'tauri' },
];

const MODEL_ROLE_ORDER = ['tts', 'asr', 'diarisation', 'diarization', 'llm'];
const MODEL_ROLE_LABEL = { all: 'All', tts: 'TTS', asr: 'ASR', diarisation: 'Diarisation', diarization: 'Diarisation', llm: 'LLM', other: 'Other' };

function GeneralTab() {
  const { t } = useTranslation();
  const locale = useAppStore(s => s.locale);
  const setLocale = useAppStore(s => s.setLocale);
  const theme = useAppStore(s => s.theme);
  const setTheme = useAppStore(s => s.setTheme);
  const { data: sysInfo } = useSystemInfo();
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxySaved, setProxySaved] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  const [ffmpegPath, setFfmpegPath] = useState('');
  const [ffmpegSaving, setFfmpegSaving] = useState(false);
  const queryClient = useQueryClient();

  // Sync inputs with persisted values from backend on load
  useEffect(() => {
    if (!proxyUrl && !proxySaved) setProxyUrl(sysInfo?.proxy_url || '');
  }, [sysInfo?.proxy_url]);

  useEffect(() => {
    if (!ffmpegPath) setFfmpegPath(sysInfo?.ffmpeg_path || '');
  }, [sysInfo?.ffmpeg_path]);

  const ffmpegOk = sysInfo?.ffmpeg_ok;
  const ffmpegCurrent = sysInfo?.ffmpeg_path;

  const saveFfmpeg = async () => {
    const value = ffmpegPath.trim();
    setFfmpegSaving(true);
    try {
      const { API } = await import('../api/client');
      const r = await fetch(`${API}/system/set-env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'FFMPEG_PATH', value }),
      });
      if (r.ok) {
        toast.success(t('settings.ffmpeg_saved'));
        setFfmpegPath('');
        queryClient.invalidateQueries({ queryKey: queryKeys.systemInfo });
      } else {
        const d = await r.json().catch(() => ({}));
        toast.error(d.detail || t('credentials.save_failed'));
      }
    } catch (e) { toast.error(t('settings.save_failed', { message: e.message })); }
    finally { setFfmpegSaving(false); }
  };

  const handleLocaleChange = (e) => {
    const id = e.target.value;
    setLocale(id);
    i18n.changeLanguage(id);
  };

  const saveProxy = async () => {
    const value = proxyUrl.trim();
    setProxySaving(true);
    try {
      const { API } = await import('../api/client');
      const setEnv = (key, val) => fetch(`${API}/system/set-env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: val }),
      });
      const r = await setEnv('HTTP_PROXY', value);
      if (r.ok) {
        await Promise.all([
          setEnv('HTTPS_PROXY', value),
          setEnv('ALL_PROXY', value),
          setEnv('http_proxy', value),
          setEnv('https_proxy', value),
          setEnv('all_proxy', value),
        ]);
        toast.success(t('settings.proxy_saved'));
        setProxySaved(true);
        queryClient.invalidateQueries({ queryKey: queryKeys.systemInfo });
      } else {
        const d = await r.json().catch(() => ({}));
        toast.error(d.detail || t('settings.proxy_save_failed'));
      }
    } catch (e) { toast.error(t('settings.save_failed', { message: e.message })); }
    finally { setProxySaving(false); }
  };

  const clearProxy = async () => {
    setProxySaving(true);
    try {
      const { API } = await import('../api/client');
      const setEnv = (key, val) => fetch(`${API}/system/set-env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: val }),
      });
      await Promise.all([
        setEnv('HTTP_PROXY', ''),
        setEnv('HTTPS_PROXY', ''),
        setEnv('ALL_PROXY', ''),
        setEnv('http_proxy', ''),
        setEnv('https_proxy', ''),
        setEnv('all_proxy', ''),
      ]);
      setProxyUrl('');
      setProxySaved(false);
      toast.success(t('settings.proxy_cleared'));
      queryClient.invalidateQueries({ queryKey: queryKeys.systemInfo });
    } catch (e) { toast.error(t('settings.clear_failed', { message: e.message })); }
    finally { setProxySaving(false); }
  };

  return (
    <section className="settings-section">
      <h2><FileText size={16} color="#83a598" /> {t('settings.general')}</h2>

      <div className="settings-row">
        <span className="label">{t('settings.language')}</span>
        <span className="value">
          <Select size="sm" value={locale} onChange={handleLocaleChange}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </Select>
        </span>
      </div>

      <div className="settings-row">
        <span className="label">{t('settings.theme')}</span>
        <span className="value">
          <Select size="sm" value={theme} onChange={e => setTheme(e.target.value)}>
            <option value="gruvbox">Gruvbox</option>
            <option value="midnight">Midnight</option>
            <option value="nord">Nord</option>
            <option value="solarized">Solarized</option>
            <option value="rose-pine">Rose Pine</option>
            <option value="catppuccin">Catppuccin</option>
          </Select>
        </span>
      </div>

      <hr className="settings-divider" />

      <div className="settings-credential">
        <div className="settings-credential__header">
          <label className="settings-credential__label">{t('settings.proxy')}</label>
          {proxySaved && <Badge tone="success" size="xs">{t('credentials.saved')}</Badge>}
        </div>
        <p className="settings-credential__help">{t('settings.proxy_desc')}</p>
        <div className="settings-credential__row">
          <input
            type="text"
            className="settings-credential__input"
            placeholder="http://127.0.0.1:7890 or socks5://127.0.0.1:7890"
            value={proxyUrl}
            onChange={e => setProxyUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveProxy()}
          />
          <Button size="sm" variant="subtle" onClick={saveProxy} loading={proxySaving} disabled={!proxyUrl.trim()}>
            {t('credentials.save')}
          </Button>
          {proxySaved && (
            <Button size="sm" variant="ghost" onClick={clearProxy} loading={proxySaving}>
              {t('settings.proxy_clear')}
            </Button>
          )}
        </div>
      </div>

      <hr className="settings-divider" />

      <div className="settings-credential">
        <div className="settings-credential__header">
          <label className="settings-credential__label">{t('settings.ffmpeg')}</label>
          <Badge tone={ffmpegOk ? 'success' : 'warn'} size="xs">
            {ffmpegOk ? t('settings.ffmpeg_found') : t('settings.ffmpeg_missing')}
          </Badge>
        </div>
        <p className="settings-credential__help">
          {ffmpegCurrent ? `${t('settings.ffmpeg_current')}: ${ffmpegCurrent}` : t('settings.ffmpeg_desc')}
        </p>
        <div className="settings-credential__row">
          <input
            type="text"
            className="settings-credential__input"
            placeholder="D:\ffmpeg\bin\ffmpeg.exe"
            value={ffmpegPath}
            onChange={e => setFfmpegPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveFfmpeg()}
          />
          <Button size="sm" variant="subtle" onClick={saveFfmpeg} loading={ffmpegSaving} disabled={!ffmpegPath.trim()}>
            {t('credentials.save')}
          </Button>
        </div>
      </div>

    </section>
  );
}

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

import { useModels, useRecommendations, useInstallModel, useDeleteModel } from '../api/hooks';

/**
 * Model store — list every known HF model, show install state, let the
 * user install / reinstall / delete individual models. Per-model download
 * progress is pulled from the shared /setup/download-stream SSE.
 */
export function ModelStoreTab({ info, modelBadge }) {
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
      const { API } = await import('../api/client');
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
      <section className="settings-section">
        <h2><Cpu size={16} color="#f3a5b6" /> {t('settings.models')}</h2>
        <div className="settings-muted">{t('common.loading')}</div>
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="settings-section settings-section--compact">
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
        <input
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


export function EnginesTab() {
  const { t } = useTranslation();
  const reviewMode = useAppStore(s => s.reviewMode);
  const setReviewMode = useAppStore(s => s.setReviewMode);

  // Plan 02-04 / ENGINE-06 — engine selection is wired through the
  // matrix component's optional onSelect callback so the matrix doubles
  // as a picker. Keeps a single source of truth for the engine list +
  // its install / GPU / isolation state.
  const onSelect = useCallback(async (family, backendId) => {
    try {
      addBreadcrumb(`engine:${family}=${backendId}`);
      const r = await selectEngine(family, backendId);
      toast.success(t('settings.engine_switched', { family: family.toUpperCase(), engine: r.active }));
    } catch (e) {
      toast.error(e.message || t('engines.switch_failed'));
    }
  }, []);

  return (
    <section className="settings-section settings-section--compact">
      <div className="models-toolbar">
        <div className="models-toolbar__stats">
          <Segmented
            size="xs"
            value={reviewMode}
            onChange={setReviewMode}
            items={[
              { value: 'on',  label: t('engines.review_on') },
              { value: 'off', label: t('engines.review_off') },
            ]}
          />
          <span className="models-toolbar__sep">·</span>
          <span>
            {reviewMode === 'on' ? t('engines.banners_on') : t('engines.banners_off')}
          </span>
        </div>
      </div>

      <EngineCompatibilityMatrix family="tts" onSelect={onSelect} />
    </section>
  );
}


const isTauri = () => _isTauri;

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
  const { t } = useTranslation();
  // One-shot deep-link: a caller (e.g. the footer version badge → Updates) can
  // set `pendingSettingsTab` and navigate here; consume it as the initial tab.
  const pendingSettingsTab = useAppStore((s) => s.pendingSettingsTab);
  const setPendingSettingsTab = useAppStore((s) => s.setPendingSettingsTab);
  const [activeTab, setActiveTab] = useState(() => pendingSettingsTab || 'models');
  const [logSource, setLogSource] = useState('backend');
  const [logs, setLogs] = useState([]);
  const [logMeta, setLogMeta] = useState({ path: '', exists: false });
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const [tauriVersion, setTauriVersion] = useState(null);
  const [updateState, setUpdateState] = useState('idle'); // idle|checking|downloading|uptodate|error
  const updateChannel = useAppStore((s) => s.updateChannel);

  // Consume a one-shot deep-link tab (covers the case where Settings is already
  // open and the value changes after mount); clear it so a later plain open of
  // Settings doesn't jump tabs.
  useEffect(() => {
    if (pendingSettingsTab) {
      setActiveTab(pendingSettingsTab);
      setPendingSettingsTab(null);
    }
  }, [pendingSettingsTab, setPendingSettingsTab]);

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

  const changeChannel = useCallback(async (ch) => {
    try {
      const next = await setChannel(useAppStore.getState(), ch);
      toast.success(t('about.channel_set', { channel: t(`about.channel_${next}`) }));
    } catch (e) {
      toast.error(t('settings.channel_set_failed', { message: e?.message || e }));
    }
  }, [t]);

  // sysinfo polling is now handled by useSysinfo() hook above

  // Self-check (/system/diagnose) — device, ffmpeg, HF token, disk, engines,
  // hub reachability. The report comes back pre-scrubbed (backend core/scrub)
  // so "Copy" output is safe to paste straight into a GitHub issue.
  const [selfCheck, setSelfCheck] = useState(null);
  const [selfCheckRunning, setSelfCheckRunning] = useState(false);
  const runSelfCheck = useCallback(async () => {
    setSelfCheckRunning(true);
    try {
      const r = await fetch(`${API}/system/diagnose`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSelfCheck(await r.json());
    } catch (e) {
      toast.error(t('about.self_check_failed', { message: e?.message || e }));
    } finally {
      setSelfCheckRunning(false);
    }
  }, [t]);

  // Diagnostic bundle — zip of self-check + error journal + scrubbed log
  // tails, saved to the outputs dir and revealed so the user can drag it
  // onto a GitHub issue (logs never fit in the prefilled-URL report).
  const [bundleBuilding, setBundleBuilding] = useState(false);
  const saveDiagnosticBundle = useCallback(async () => {
    setBundleBuilding(true);
    try {
      const r = await fetch(`${API}/system/diagnostic-bundle`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      toast.success(t('about.bundle_saved', { filename: j.filename }));
      try {
        const { exportReveal } = await import('../api/exports');
        await exportReveal({ path: j.path });
      } catch { /* reveal is best-effort — the toast already names the file */ }
    } catch (e) {
      toast.error(t('about.bundle_failed', { message: e?.message || e }));
    } finally {
      setBundleBuilding(false);
    }
  }, [t]);

  const copyDiagnostics = useCallback(async () => {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const ua = nav.userAgent || '—';
    const lang = nav.language || '—';
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return '—'; } })();
    const fmtGB = (v) => (typeof v === 'number' ? `${v.toFixed(2)} GB` : '—');
    const lines = [
      '### OmniVoice Studio diagnostics',
      '',
      `- **App version:** ${resolveAboutVersion(appVersion, info)}`,
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
      `- **Update channel:** ${updateChannel}`,
      `- **Update endpoint:** ${updateChannel === 'preview'
        ? 'https://github.com/debpalash/OmniVoice-Studio/releases/download/preview/latest.json'
        : 'https://github.com/debpalash/OmniVoice-Studio/releases/latest/download/latest.json'}`,
      `- **User agent:** ${ua}`,
    ];
    const text = lines.join('\n');
    try {
      await copyText(text);
      toast.success(t('settings.diagnostics_copied'));
    } catch (e) {
      toast.error(t('settings.copy_failed', { message: e?.message || e }));
    }
  }, [appVersion, tauriVersion, info, status, hw, updateChannel, t]);

  const checkForUpdates = useCallback(async () => {
    if (!isTauri()) {
      toast(t('settings.updater_desktop'), { icon: 'ℹ️' });
      return;
    }
    setUpdateState('checking');
    try {
      const [{ invoke }, { relaunch }, { ask }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/plugin-process'),
        import('@tauri-apps/plugin-dialog'),
      ]);
      const channel = normalizeChannel(updateChannel);
      const update = await invoke('check_update', { channel });
      if (!update) {
        setUpdateState('uptodate');
        toast.success(t('settings.latest_version'));
        return;
      }
      const proceed = await ask(
        t('settings.updater_available_body', {
          version: update.version,
          notes: update.notes || t('settings.updater_notes_fallback'),
        }),
        { title: t('settings.updater_available_title'), kind: 'info' },
      );
      if (!proceed) { setUpdateState('idle'); return; }
      setUpdateState('downloading');
      const tid = toast.loading(t('settings.updater_downloading', { version: update.version }));
      await invoke('install_update', { channel });
      toast.success(t('settings.updater_installed'), { id: tid });
      await relaunch();
    } catch (e) {
      setUpdateState('error');
      toast.error(t('settings.update_check_failed', { message: e?.message || e }));
    }
  }, [updateChannel, t]);

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
      toast.error(t('settings.logs_load_failed', { message: e.message }));
    } finally {
      setLoadingLogs(false);
    }
  }, [logSource, t]);

  useEffect(() => {
    if (activeTab === 'logs') refreshLogs();
  }, [activeTab, logSource, refreshLogs]);

  const onClearLogs = async () => {
    if (logSource === 'frontend') {
      if (!(await askConfirm(t('settings.clear_frontend_confirm'), t('settings.clear_frontend_title')))) return;
      clearFrontendLogs();
      toast.success(t('settings.frontend_logs_cleared'));
      setLogs([]);
      return;
    }
    if (logSource === 'tauri') {
      if (!(await askConfirm(t('settings.clear_tauri_confirm'), t('settings.clear_tauri_title')))) return;
      try {
        const r = await clearTauriLogs();
        if (!r?.cleared?.length) {
          toast(t('settings.nothing_to_clear'), { icon: 'ℹ️' });
        } else {
          toast.success(t('settings.cleared_tauri', { count: r.cleared.length }));
          setLogs([]);
        }
      } catch (e) {
        toast.error(t('settings.clear_tauri_failed', { message: e.message }));
      }
      return;
    }
    if (!(await askConfirm(t('settings.clear_backend_confirm'), t('settings.clear_backend_title')))) return;
    try {
      await clearSystemLogs();
      toast.success(t('settings.backend_logs_cleared'));
      setLogs([]);
    } catch (e) {
      toast.error(t('settings.clear_backend_failed'));
    }
  };

  const modelBadge =
    status?.status === 'ready'   ? <Badge tone="success"><CheckCircle size={11} /> {t('models.ready_badge')}</Badge>
  : status?.status === 'loading' ? <Badge tone="warn"><RefreshCw size={11} className="spinner" /> {t('models.loading_badge')}</Badge>
                                 : <Badge tone="warn">{t('models.idle_badge')}</Badge>;

  // The active tab's accent (from TAB_DEFS) threads down to the content edge as
  // --settings-accent, so the coloured active tab and the content panel read as
  // one connected unit (see .settings-content in Settings.css).
  const activeAccent = TAB_DEFS.find((d) => d.id === activeTab)?.accent || 'var(--chrome-accent)';

  return (
    <div className="settings-page" style={{ '--settings-accent': activeAccent }}>
      <Tabs
        items={TAB_DEFS.map(def => ({ ...def, label: t(`settings.${def.id}`) }))}
        value={activeTab}
        onChange={setActiveTab}
        className="settings-tabs-ui"
      />

      <div className="settings-content">
      {activeTab === 'general' && (
        <>
          <GeneralTab />
          <PronunciationPanel />
          <PerformancePanel />
        </>
      )}

      {activeTab === 'models' && (
        <>
          <StoragePanel />
          <HFMirrorPanel />
          <ModelStoreTab info={info} modelBadge={modelBadge} />
        </>
      )}

      {activeTab === 'engines' && <EnginesTab />}

      {activeTab === 'capture' && (
        <>
          <VoicePanel />
          <DictationDemo />
          <HotkeyTab />
          <RefinementPanel />
          <AecPanel />
        </>
      )}

      {activeTab === 'sharing' && (
        <>
          <SharingPanel />
          <RemoteBackendPanel />
          <MCPBindingsPanel />
        </>
      )}

      {activeTab === 'appearance' && <AppearancePanel />}

      {activeTab === 'credentials' && <CredentialsTab info={info} />}

      {activeTab === 'logs' && (
        <section className="settings-section">
          <h2 className="settings-section__head-row">
            <span className="settings-section__head-left">
              <FileText size={16} color="#fabd2f" /> {t('settings.logs')}
            </span>
            <span className="settings-section__head-actions">
              <ReportBugButton />
              <Button
                variant="subtle"
                size="sm"
                onClick={refreshLogs}
                loading={loadingLogs}
                leading={!loadingLogs && <RefreshCw size={11} />}
              >
                {t('common.refresh')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={onClearLogs}
                leading={<Trash2 size={11} />}
              >
                {t('common.clear')}
              </Button>
            </span>
          </h2>

          <Segmented
            items={LOG_SOURCE_DEFS.map(d => ({ ...d, label: t(`common.${d.key}`) }))}
            value={logSource}
            onChange={setLogSource}
          />

          <div className="settings-log-meta">
            <span>{logMeta.path || '—'}</span>
            {logSource === 'tauri' && !logMeta.exists && (
              <Badge tone="warn">
                <AlertCircle size={11} /> {t('logs.no_tauri_log')}
              </Badge>
            )}
          </div>
          <div className="settings-log">
            {logs.length === 0
              ? <span className="settings-log__empty">
                  {logSource === 'frontend'
                    ? t('logs.empty_frontend')
                    : logSource === 'tauri'
                      ? t('logs.empty_tauri')
                      : t('logs.empty_backend')}
                </span>
              : logs.join('')}
          </div>
        </section>
      )}

      {activeTab === 'updates' && (
        <section className="settings-section">
          <h2><ArrowDownToLine size={16} color="#b8bb26" /> {t('settings.updates')}</h2>
          <UpdatesPanel />
        </section>
      )}

      {activeTab === 'about' && (
        <section className="settings-section">
          <h2><Info size={16} color="#8ec07c" /> {t('settings.about')}</h2>
          <Row label={t('about.app')}             value="OmniVoice Studio" />
          <Row label={t('about.version')}         value={resolveAboutVersion(appVersion, info)} mono />
          <Row label={t('about.tauri_runtime')}   value={tauriVersion || (isTauri() ? '—' : t('about.web_preview'))} mono />
          <Row label={t('about.platform')}        value={info?.platform || '—'} />
          <Row label={t('about.architecture')}    value={info?.arch || '—'} mono />
          <Row label={t('about.python')}          value={info?.python || '—'} mono />
          <Row label={t('about.compute_device')}  value={info?.device || '—'} mono />
          <Row label={t('about.gpu_active')}      value={hw?.gpu_active
            ? <Badge tone="success"><CheckCircle size={11} /> {t('about.yes')}</Badge>
            : <Badge tone="neutral">{t('about.no')}</Badge>} />
          <Row label={t('about.ram')}             value={hw ? `${hw.ram?.toFixed(2)} / ${hw.total_ram?.toFixed(2)} GB` : '—'} mono />
          <Row label={t('about.vram')}            value={hw ? `${hw.vram?.toFixed(2)} GB` : '—'} mono />
          <Row label={t('about.backend')}         value={<Badge tone={status?.status === 'ready' ? 'success' : status?.status === 'loading' ? 'warn' : 'neutral'}>{status?.status || 'unknown'}</Badge>} />
          <Row label={t('about.active_model')}    value={status?.repo_id || info?.model_checkpoint || '—'} mono />
          <Row label={t('about.asr_model')}       value={info?.asr_model || '—'} mono />
          <Row label={t('about.translator')}      value={info?.translate_provider || '—'} />
          <Row label={t('about.hf_token')}        value={info?.has_hf_token ? t('about.yes') : t('about.no')} />
          <Row label={t('about.data_dir')}        value={info?.data_dir || '—'} mono />
          <Row label={t('about.outputs')}         value={info?.outputs_dir || '—'} mono />
          <Row label={t('about.crash_log')}       value={info?.crash_log_path || '—'} mono />
          {/* Auto-updater + channel toggle are desktop-only (Tauri). The Docker
              web build updates by pulling a new image tag, so hide these rows
              there to avoid a non-functional control (issue #249). */}
          {isTauri() && (
            <>
              <Row
                label={t('about.update_channel')}
                value={
                  <Segmented
                    size="xs"
                    value={updateChannel}
                    onChange={changeChannel}
                    items={[
                      { value: 'stable',  label: t('about.channel_stable') },
                      { value: 'preview', label: t('about.channel_preview') },
                    ]}
                  />
                }
              />
              <Row
                label={t('about.update_endpoint')}
                value={updateChannel === 'preview'
                  ? 'releases/download/preview/latest.json'
                  : 'releases/latest/download/latest.json'}
                mono
              />
              {updateChannel === 'preview' && (
                <p className="settings-muted">{t('about.channel_preview_hint')}</p>
              )}
            </>
          )}
          <div className="settings-link-row">
            {isTauri() && (
              <Button
                variant="primary"
                size="md"
                leading={<Download size={12} />}
                onClick={checkForUpdates}
                loading={updateState === 'checking' || updateState === 'downloading'}
              >
                {updateState === 'downloading' ? t('about.downloading') : t('about.check_updates')}
              </Button>
            )}
            <Button
              variant="subtle"
              size="md"
              leading={!selfCheckRunning && <Activity size={12} />}
              onClick={runSelfCheck}
              loading={selfCheckRunning}
            >
              {t('about.self_check')}
            </Button>
            <Button
              variant="subtle"
              size="md"
              leading={!bundleBuilding && <Download size={12} />}
              onClick={saveDiagnosticBundle}
              loading={bundleBuilding}
            >
              {t('about.save_bundle')}
            </Button>
            <Button
              variant="subtle"
              size="md"
              leading={<Copy size={12} />}
              onClick={copyDiagnostics}
            >
              {t('about.copy_diagnostics')}
            </Button>
            <Button
              variant="subtle"
              size="md"
              leading={<ExternalLink size={12} />}
              onClick={() => openExternal('https://github.com/k2-fsa/OmniVoice')}
            >
              {t('about.github')}
            </Button>
            <Button
              variant="subtle"
              size="md"
              leading={<ExternalLink size={12} />}
              onClick={() => openExternal('https://huggingface.co/k2-fsa/OmniVoice')}
            >
              {t('about.model_card')}
            </Button>
            <Button
              variant="subtle"
              size="md"
              leading={<Building2 size={12} />}
              onClick={() => { useAppStore.getState().setMode?.('enterprise'); }}
            >
              {t('about.commercial_license')}
            </Button>
          </div>
          {selfCheck && (
            <div className="settings-selfcheck">
              {selfCheck.checks.map((c) => (
                <Row
                  key={c.id}
                  label={c.label}
                  value={
                    <span>
                      <Badge tone={c.status === 'ok' ? 'success' : c.status === 'warn' ? 'warn' : 'danger'}>
                        {c.status === 'ok'
                          ? <CheckCircle size={11} />
                          : <AlertCircle size={11} />} {t(`about.self_check_${c.status}`)}
                      </Badge>
                      {' '}{c.detail}
                      {c.hint && <span className="settings-muted"> — {c.hint}</span>}
                    </span>
                  }
                />
              ))}
              <p className="settings-muted">
                {selfCheck.summary.ok
                  ? t('about.self_check_healthy')
                  : t('about.self_check_attention', { count: selfCheck.summary.failures })}
              </p>
            </div>
          )}
        </section>
      )}

      {activeTab === 'privacy' && (
        <section className="settings-section">
          <h2><ShieldCheck size={16} color="#b8bb26" /> {t('settings.privacy')}</h2>
          <p className="settings-prose">
            <Trans i18nKey="privacy.desc" components={{ 1: <strong /> }} />
          </p>
          <Row label={t('privacy.uploads_at')}   value={info?.data_dir ? `${info.data_dir}/` : '—'} mono />
          <Row label={t('privacy.outputs_at')}   value={info?.outputs_dir || '—'} mono />
          <Row label={t('privacy.gen_history')}  value={<Badge tone="neutral">{t('privacy.local_sqlite')}</Badge>} />
          <Row
            label={t('privacy.network_calls')}
            value={
              info?.translate_provider && ['google', 'deepl', 'mymemory', 'microsoft', 'openai'].includes(info.translate_provider)
                ? <Badge tone="warn"><AlertCircle size={11} /> {t('privacy.translator_online', { provider: info.translate_provider })}</Badge>
                : <Badge tone="success"><CheckCircle size={11} /> {t('privacy.translator_offline')}</Badge>
            }
          />
          <Row
            label={t('privacy.model_telemetry')}
            value={<Badge tone="success"><CheckCircle size={11} /> {t('privacy.no_tracking')}</Badge>}
          />
        </section>
      )}
      </div>
    </div>
  );
}

// ── Credentials Tab ───────────────────────────────────────────────────────

// Flat field list rendered by CredentialsTab. HF_TOKEN is handled by
// <ApiKeysPanel/> (3-source cascade) and filtered out of this loop; the
// rest are session/persisted env keys set via /system/set-env. labelKey/
// helpKey are i18n keys; placeholderKey holds a literal example value
// (URL / token shape) rendered as-is, matching the original design.
const CREDENTIAL_FIELDS = [
  { key: 'HF_TOKEN', labelKey: 'credentials.hf_token', placeholderKey: 'hf_xxxxxxxxxxxx',
    helpKey: 'credentials.hf_help', link: 'https://huggingface.co/settings/tokens', isPassword: true },
  { key: 'TRANSLATE_API_KEY', labelKey: 'credentials.translate_key', placeholderKey: 'API key',
    helpKey: 'credentials.translate_help', isPassword: true },
  { key: 'TRANSLATE_BASE_URL', labelKey: 'credentials.llm_base_url', placeholderKey: 'https://api.openai.com/v1',
    helpKey: 'credentials.llm_base_url_help' },
  { key: 'TRANSLATE_MODEL', labelKey: 'credentials.llm_model', placeholderKey: 'gpt-4o',
    helpKey: 'credentials.llm_model_help' },
  { key: 'DEEPL_API_KEY', labelKey: 'credentials.deepl_key', placeholderKey: 'DeepL API key',
    helpKey: 'credentials.deepl_key', isPassword: true },
  { key: 'DEEPL_BASE_URL', labelKey: 'credentials.deepl_base_url', placeholderKey: 'https://api.deepl.com/v2',
    helpKey: 'credentials.deepl_base_url_help' },
  { key: 'MICROSOFT_API_KEY', labelKey: 'credentials.microsoft_key', placeholderKey: 'Microsoft API key',
    helpKey: 'credentials.microsoft_key', isPassword: true },
  { key: 'MICROSOFT_BASE_URL', labelKey: 'credentials.microsoft_base_url', placeholderKey: 'https://api.cognitive.microsofttranslator.com',
    helpKey: 'credentials.microsoft_base_url_help' },
];

// Convert a KeyboardEvent into a tauri-plugin-global-shortcut accelerator
// string, e.g. "CmdOrCtrl+Shift+Space". Returns null when only modifiers
// are held (the user hasn't picked a "real" key yet).
function keyEventToAccelerator(e) {
  const isMacLike = typeof navigator !== 'undefined'
    && /Mac|iPad|iPhone|iPod/.test(navigator.platform || '');
  const mods = [];
  if (e.metaKey) mods.push(isMacLike ? 'Cmd' : 'Super');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  // e.code is the physical key — already in the shape tauri expects for
  // Letter/Digit/Function keys ("KeyA", "Digit1", "F5"). Strip the prefix
  // so we get "A" / "1" / "F5" which matches the accelerator grammar.
  let key = e.code;
  if (!key) return null;
  if (key.startsWith('Key')) key = key.slice(3);
  else if (key.startsWith('Digit')) key = key.slice(5);
  // Skip pure modifier keys — we want the user to pick a real trigger.
  if (/^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/.test(key)) return null;

  if (mods.length === 0) return null;
  return [...mods, key].join('+');
}

function HotkeyTab() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState('');
  const [saving, setSaving] = useState(false);
  const tauri = isTauri();

  // Load the saved shortcut on mount.
  useEffect(() => {
    if (!tauri) return;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const v = await invoke('get_dictation_shortcut');
        setCurrent(v || '');
      } catch (e) {
        toast.error(t('settings.shortcut_load_failed', { message: e?.message || e }));
      }
    })();
  }, [tauri]);

  // While recording, swallow keystrokes globally and convert the next real
  // press into an accelerator string. Escape cancels.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        setPending('');
        return;
      }
      const accel = keyEventToAccelerator(e);
      if (accel) {
        setPending(accel);
        setRecording(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording]);

  const save = async () => {
    if (!pending || pending === current) return;
    setSaving(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const saved = await invoke('set_dictation_shortcut', { accelerator: pending });
      setCurrent(saved);
      setPending('');
      toast.success(t('settings.shortcut_set', { shortcut: saved }));
    } catch (e) {
      // Common cause: the OS or another app already owns the combo. Surface
      // the raw error so the user can pick something else.
      toast.error(t('settings.shortcut_register_failed', { message: e?.message || e }));
    } finally {
      setSaving(false);
    }
  };

  const resetDefault = async () => {
    setSaving(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const saved = await invoke('set_dictation_shortcut', {
        accelerator: 'CmdOrCtrl+Shift+Space',
      });
      setCurrent(saved);
      setPending('');
      toast.success(t('settings.shortcut_reset'));
    } catch (e) {
      toast.error(t('settings.shortcut_reset_failed', { message: e?.message || e }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2><Keyboard size={16} color="#83a598" /> {t('settings.capture')}</h2>

      {!tauri && (
        <p className="settings-prose">
          <Trans i18nKey="capture.desc" components={{ 1: <kbd /> }} />
        </p>
      )}

      <div className="settings-row">
        <span className="label">{t('capture.active_shortcut')}</span>
        <span className="value settings-row__mono">{current || '—'}</span>
      </div>

      <div className="settings-row">
        <span className="label">{recording ? t('capture.press_key') : t('capture.new_shortcut')}</span>
        <span className="value settings-row__mono">
          {recording ? t('capture.listening') : (pending || '—')}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="subtle"
          onClick={() => { setPending(''); setRecording(true); }}
          disabled={!tauri || saving}
          leading={<Keyboard size={12} />}
        >
          {recording ? t('capture.recording') : t('capture.record_shortcut')}
        </Button>
        <Button
          size="sm"
          onClick={save}
          disabled={!tauri || !pending || pending === current}
          loading={saving}
        >
          {t('capture.save')}
        </Button>
        <Button
          size="sm"
          variant="subtle"
          onClick={resetDefault}
          disabled={!tauri || saving}
        >
          {t('capture.reset_default')}
        </Button>
      </div>

      <p className="settings-prose" style={{ marginTop: 12 }}>
        <Trans i18nKey="capture.desc_detail" components={{ 1: <code />, 2: <code /> }} />
      </p>
    </section>
  );
}

function CredentialsTab({ info }) {
  const { t } = useTranslation();
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(null);
  const [saved, setSaved] = useState({});

  const save = async (key) => {
    const value = (values[key] || '').trim();
    if (!value) return;
    setSaving(key);
    try {
      const { API } = await import('../api/client');
      const res = await fetch(`${API}/system/set-env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      if (res.ok) {
        toast.success(t('credentials.saved_session', { key }));
        setSaved(prev => ({ ...prev, [key]: true }));
        setValues(prev => ({ ...prev, [key]: '' }));
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.detail || t('credentials.save_failed'));
      }
    } catch (e) {
      toast.error(t('credentials.save_error', { message: e.message }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="settings-section">
      <h2><KeyRound size={16} color="#fe8019" /> {t('settings.credentials')}</h2>

      {/* Wave 2 AUTH-03 panel — 3-source cascade with Active badge,
          encrypted-at-rest App-source storage, and live whoami status. */}
      <ApiKeysPanel />

      {/* Wave 2.4 — OpenAI-compatible LLM endpoint (Ollama/LM Studio/vLLM). */}
      <LLMEndpointPanel />

      <p className="settings-prose">
        <Trans i18nKey="credentials.desc" components={{ 1: <strong /> }} />
      </p>
      {CREDENTIAL_FIELDS.filter(f => f.key !== 'HF_TOKEN').map(field => (
        <div key={field.key} className="settings-credential">
          <div className="settings-credential__header">
            <label className="settings-credential__label">{t(field.labelKey)}</label>
            {field.key === 'HF_TOKEN' && (
              <Badge tone={info?.has_hf_token || saved.HF_TOKEN ? 'success' : 'warn'} size="xs">
                {info?.has_hf_token || saved.HF_TOKEN ? t('credentials.saved') : t('credentials.not_set')}
              </Badge>
            )}
          </div>
          <div className="settings-credential__row">
            <input
              type={field.isPassword ? 'password' : 'text'}
              className="settings-credential__input"
              placeholder={field.placeholderKey}
              value={values[field.key] || ''}
              onChange={e => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && save(field.key)}
            />
            <Button
              size="sm"
              variant="subtle"
              loading={saving === field.key}
              onClick={() => save(field.key)}
              disabled={!(values[field.key] || '').trim()}
            >
              {t('credentials.save')}
            </Button>
          </div>
          <p className="settings-credential__help">
            {t(field.helpKey)}
            {field.link && (
              <> <a href="#" onClick={e => { e.preventDefault(); openExternal(field.link); }}>{t('credentials.get_token')}</a></>
            )}
          </p>
        </div>
      ))}
    </section>
  );
}
