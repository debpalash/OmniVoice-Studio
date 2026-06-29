import React, { useEffect, useState, useCallback } from 'react';
import { copyText } from "../utils/copyText";
import { normalizeChannel } from '../utils/updateChannel';
import { setChannel } from '../utils/channelControl';
import {
  Cpu, FileText, Info, ShieldCheck, RefreshCw,
  CheckCircle, Plug, KeyRound,
  Keyboard, Wifi, Palette, ArrowDownToLine, Settings2,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { API, apiFetch } from '../api/client';
import { useTranslation } from 'react-i18next';
import { systemLogs, systemLogsTauri, clearSystemLogs, clearTauriLogs } from '../api/system';
import { useSysinfo, useModelStatus, useSystemInfo } from '../api/hooks';
import { getFrontendLogs, clearFrontendLogs } from '../utils/consoleBuffer';
import { resolveAboutVersion } from '../utils/appVersion';
import { Tabs, Badge } from '../ui';
import { SettingsSection } from '../components/settings/primitives';
import { useAppStore } from '../store';
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
import DictationDemo from '../components/DictationDemo';
import UpdatesPanel from '../components/UpdatesPanel';
import GeneralTab from '../components/settings/GeneralTab';
import ModelStoreTab from '../components/settings/ModelStoreTab';
import EnginesTab from '../components/settings/EnginesTab';
import HotkeyTab from '../components/settings/HotkeyTab';
import CredentialsTab from '../components/settings/CredentialsTab';
import AboutTab from '../components/settings/AboutTab';
import PrivacyTab from '../components/settings/PrivacyTab';
import LogsTab from '../components/settings/LogsTab';
import { isTauri, askConfirm } from '../components/settings/native';
import './Settings.css';

// Ordered as a logical flow: setup basics first (General/Appearance), then the
// engine stack (Models/Engines), feature areas (Capture/Sharing), secrets
// (Credentials), maintenance (Updates/Logs), and reference (About/Privacy).
const TAB_DEFS = [
  { id: 'general',     icon: Settings2 },
  { id: 'appearance',  icon: Palette },
  { id: 'models',      icon: Cpu },
  { id: 'engines',     icon: Plug },
  { id: 'capture',     icon: Keyboard },
  { id: 'sharing',     icon: Wifi },
  { id: 'credentials', icon: KeyRound },
  { id: 'updates',     icon: ArrowDownToLine },
  { id: 'logs',        icon: FileText },
  { id: 'about',       icon: Info },
  { id: 'privacy',     icon: ShieldCheck },
];

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
      const r = await apiFetch(`${API}/system/diagnose`);
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
      const r = await apiFetch(`${API}/system/diagnostic-bundle`, { method: 'POST' });
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

  return (
    <div className="settings-page">
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
        <LogsTab
          logSource={logSource}
          setLogSource={setLogSource}
          logs={logs}
          logMeta={logMeta}
          loadingLogs={loadingLogs}
          refreshLogs={refreshLogs}
          onClearLogs={onClearLogs}
        />
      )}

      {activeTab === 'updates' && (
        <SettingsSection icon={ArrowDownToLine} title={t('settings.updates')}>
          <UpdatesPanel />
        </SettingsSection>
      )}

      {activeTab === 'about' && (
        <AboutTab
          appVersion={appVersion}
          tauriVersion={tauriVersion}
          info={info}
          hw={hw}
          status={status}
          updateChannel={updateChannel}
          changeChannel={changeChannel}
          checkForUpdates={checkForUpdates}
          updateState={updateState}
          selfCheck={selfCheck}
          selfCheckRunning={selfCheckRunning}
          runSelfCheck={runSelfCheck}
          bundleBuilding={bundleBuilding}
          saveDiagnosticBundle={saveDiagnosticBundle}
          copyDiagnostics={copyDiagnostics}
        />
      )}

      {activeTab === 'privacy' && <PrivacyTab info={info} />}
      </div>
    </div>
  );
}

