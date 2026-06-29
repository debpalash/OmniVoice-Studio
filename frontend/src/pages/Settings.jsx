import React, { useEffect, useState, useCallback } from 'react';
import { copyText } from "../utils/copyText";
import { normalizeChannel } from '../utils/updateChannel';
import { setChannel } from '../utils/channelControl';
import {
  Cpu, FileText, Info, ShieldCheck, RefreshCw, Trash2, ExternalLink,
  CheckCircle, AlertCircle, Plug, Download, Copy, Building2, KeyRound,
  Keyboard, Wifi, Palette, Activity, ArrowDownToLine, Settings2,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { openExternal } from '../api/external';
import { API } from '../api/client';
import { Trans, useTranslation } from 'react-i18next';
import { systemLogs, systemLogsTauri, clearSystemLogs, clearTauriLogs } from '../api/system';
import { useSysinfo, useModelStatus, useSystemInfo } from '../api/hooks';
import { getFrontendLogs, clearFrontendLogs } from '../utils/consoleBuffer';
import { resolveAboutVersion } from '../utils/appVersion';
import { Tabs, Segmented, Button, Badge } from '../ui';
import { SettingsSection, SettingRow } from '../components/settings/primitives';
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
import ReportBugButton from '../components/ReportBugButton';
import GeneralTab from '../components/settings/GeneralTab';
import ModelStoreTab from '../components/settings/ModelStoreTab';
import EnginesTab from '../components/settings/EnginesTab';
import HotkeyTab from '../components/settings/HotkeyTab';
import CredentialsTab from '../components/settings/CredentialsTab';
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

const LOG_SOURCE_DEFS = [
  { value: 'backend',  key: 'backend' },
  { value: 'frontend', key: 'frontend' },
  { value: 'tauri',    key: 'tauri' },
];



// About/Privacy read-only data rows delegate to the shared SettingRow primitive
// so they pick up the redesigned grid + mono value styling unchanged.
function Row({ label, value, mono }) {
  return <SettingRow title={label} control={value} mono={mono} />;
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
        <SettingsSection
          icon={FileText}
          title={t('settings.logs')}
          actions={
            <>
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
            </>
          }
        >
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
        </SettingsSection>
      )}

      {activeTab === 'updates' && (
        <SettingsSection icon={ArrowDownToLine} title={t('settings.updates')}>
          <UpdatesPanel />
        </SettingsSection>
      )}

      {activeTab === 'about' && (
        <SettingsSection icon={Info} title={t('settings.about')}>
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
              <SettingRow
                title={t('about.update_channel')}
                hint={updateChannel === 'preview' ? t('about.channel_preview_hint') : undefined}
                control={
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
        </SettingsSection>
      )}

      {activeTab === 'privacy' && (
        <SettingsSection icon={ShieldCheck} title={t('settings.privacy')}>
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
        </SettingsSection>
      )}
      </div>
    </div>
  );
}

