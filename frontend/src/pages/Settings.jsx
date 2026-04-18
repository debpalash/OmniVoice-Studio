import React, { useEffect, useState, useCallback } from 'react';
import {
  Cpu, FileText, Info, ShieldCheck, RefreshCw, Trash2, ExternalLink,
  CheckCircle, AlertCircle,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { systemInfo, systemLogs, systemLogsTauri, clearSystemLogs, modelStatus as fetchModelStatus } from '../api/system';
import { getFrontendLogs, clearFrontendLogs } from '../utils/consoleBuffer';

const TABS = [
  { id: 'models',  label: 'Models',  Icon: Cpu,          accent: '#f3a5b6' },
  { id: 'logs',    label: 'Logs',    Icon: FileText,     accent: '#fabd2f' },
  { id: 'about',   label: 'About',   Icon: Info,         accent: '#8ec07c' },
  { id: 'privacy', label: 'Privacy', Icon: ShieldCheck,  accent: '#b8bb26' },
];

function Row({ label, value, mono }) {
  return (
    <div className="settings-row">
      <span className="label">{label}</span>
      <span className="value" style={mono ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } : undefined}>
        {value}
      </span>
    </div>
  );
}

export default function Settings() {
  const [activeTab, setActiveTab] = useState('models');
  const [info, setInfo] = useState(null);
  const [status, setStatus] = useState(null);
  const [logSource, setLogSource] = useState('backend'); // backend | frontend | tauri
  const [logs, setLogs] = useState([]);
  const [logMeta, setLogMeta] = useState({ path: '', exists: false });
  const [loadingLogs, setLoadingLogs] = useState(false);

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
        // frontend: in-memory ring buffer
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
      if (!confirm('Clear the in-memory frontend log buffer?')) return;
      clearFrontendLogs();
      toast.success('Frontend logs cleared');
      setLogs([]);
      return;
    }
    if (logSource === 'tauri') {
      toast('Tauri log is managed by the OS — clear it via Finder/Explorer.', { icon: 'ℹ️' });
      return;
    }
    if (!confirm('Clear the crash log? This cannot be undone.')) return;
    try {
      await clearSystemLogs();
      toast.success('Backend logs cleared');
      setLogs([]);
    } catch (e) {
      toast.error('Failed to clear logs');
    }
  };

  const LOG_SOURCES = [
    { id: 'backend',  label: 'Backend' },
    { id: 'frontend', label: 'Frontend' },
    { id: 'tauri',    label: 'Tauri' },
  ];

  const modelBadge = status?.status === 'ready'
    ? <span className="settings-badge"><CheckCircle size={11} /> Ready</span>
    : status?.status === 'loading'
    ? <span className="settings-badge warn"><RefreshCw size={11} className="spinner" /> Loading…</span>
    : <span className="settings-badge warn">Idle</span>;

  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <div className="settings-subtitle">
        Where your files live, what the model's doing, and what's gone wrong lately.
      </div>

      {/* Tab bar */}
      <div className="settings-tabs">
        {TABS.map(({ id, label, Icon, accent }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              className={`settings-tab ${active ? 'active' : ''}`}
              onClick={() => setActiveTab(id)}
              style={active ? { '--tab-accent': accent } : undefined}
            >
              <Icon size={13} /> {label}
            </button>
          );
        })}
      </div>

      {/* Models */}
      {activeTab === 'models' && (
        <section className="settings-section">
          <h2><Cpu size={16} color="#f3a5b6" /> Models</h2>
          {info ? (
            <>
              <Row label="TTS checkpoint" value={info.model_checkpoint} mono />
              <Row label="ASR model (Whisper)" value={info.asr_model} mono />
              <Row label="Translate provider" value={info.translate_provider} />
              <Row label="Device" value={info.device?.toUpperCase()} />
              <Row label="Status" value={modelBadge} />
              <Row label="Idle timeout" value={`${info.idle_timeout_seconds}s`} />
              <Row
                label="Hugging Face token"
                value={info.has_hf_token
                  ? <span className="settings-badge"><CheckCircle size={11} /> Set</span>
                  : <span className="settings-badge warn"><AlertCircle size={11} /> Missing — diarization disabled</span>}
              />
            </>
          ) : (
            <div style={{ color: '#665c54', fontSize: '0.8rem' }}>Loading…</div>
          )}
        </section>
      )}

      {/* Logs */}
      {activeTab === 'logs' && (
        <section className="settings-section">
          <h2 style={{ justifyContent: 'space-between', display: 'flex' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FileText size={16} color="#fabd2f" /> Logs
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={refreshLogs}
                disabled={loadingLogs}
                className="btn-primary"
                style={{ padding: '5px 12px', fontSize: '0.7rem', background: 'rgba(131,165,152,0.15)', color: '#83a598', border: '1px solid rgba(131,165,152,0.3)' }}
              >
                <RefreshCw size={11} className={loadingLogs ? 'spinner' : ''} /> Refresh
              </button>
              <button
                onClick={onClearLogs}
                className="btn-primary"
                style={{ padding: '5px 12px', fontSize: '0.7rem', background: 'rgba(251,73,52,0.12)', color: '#fb4934', border: '1px solid rgba(251,73,52,0.3)' }}
              >
                <Trash2 size={11} /> Clear
              </button>
            </span>
          </h2>

          {/* Sub-tabs: Backend / Frontend / Tauri */}
          <div className="settings-subtabs">
            {LOG_SOURCES.map((src) => (
              <button
                key={src.id}
                className={`settings-subtab ${logSource === src.id ? 'active' : ''}`}
                onClick={() => setLogSource(src.id)}
              >
                {src.label}
              </button>
            ))}
          </div>

          <div style={{ fontSize: '0.7rem', color: '#7c6f64', marginBottom: 8, fontFamily: 'ui-monospace, Menlo, monospace', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{logMeta.path || '—'}</span>
            {logSource === 'tauri' && !logMeta.exists ? (
              <span className="settings-badge warn"><AlertCircle size={11} /> Not found — enable tauri-plugin-log to produce a file</span>
            ) : null}
          </div>
          <div className="settings-log">
            {logs.length === 0
              ? <span style={{ color: '#665c54', fontStyle: 'italic' }}>
                  {logSource === 'frontend'
                    ? 'No frontend console entries captured yet. 🎉'
                    : logSource === 'tauri'
                      ? 'No Tauri log on disk.'
                      : "No backend errors logged. Nothing's broken (yet). 🎉"}
                </span>
              : logs.join('')}
          </div>
        </section>
      )}

      {/* About */}
      {activeTab === 'about' && (
        <section className="settings-section">
          <h2><Info size={16} color="#8ec07c" /> About</h2>
          <Row label="App" value="OmniVoice Studio" />
          <Row label="Python" value={info?.python || '—'} mono />
          <Row label="Platform" value={info?.platform || '—'} />
          <Row label="Data directory" value={info?.data_dir || '—'} mono />
          <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a
              href="https://github.com/k2-fsa/OmniVoice"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary"
              style={{ padding: '6px 14px', fontSize: '0.72rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.06)', color: '#d5c4a1', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <ExternalLink size={12} /> OmniVoice on GitHub
            </a>
            <a
              href="https://huggingface.co/k2-fsa/OmniVoice"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary"
              style={{ padding: '6px 14px', fontSize: '0.72rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.06)', color: '#d5c4a1', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <ExternalLink size={12} /> Model card
            </a>
          </div>
        </section>
      )}

      {/* Privacy */}
      {activeTab === 'privacy' && (
        <section className="settings-section">
          <h2><ShieldCheck size={16} color="#b8bb26" /> Privacy</h2>
          <p style={{ margin: '0 0 10px', color: '#a89984', lineHeight: 1.6, fontSize: '0.84rem' }}>
            Everything runs on <strong style={{ color: '#f5e6c5' }}>this machine</strong>. Your audio, video, and transcripts
            never leave your computer unless you explicitly use an online translator (Google, DeepL, etc.) or
            push to HuggingFace.
          </p>
          <Row label="Uploads stored at" value={info?.data_dir ? `${info.data_dir}/` : '—'} mono />
          <Row label="Outputs stored at" value={info?.outputs_dir || '—'} mono />
          <Row label="Generation history" value={<span className="settings-badge">Local SQLite</span>} />
          <Row
            label="Network calls"
            value={
              info?.translate_provider && ['google', 'deepl', 'mymemory', 'microsoft', 'openai'].includes(info.translate_provider)
                ? <span className="settings-badge warn"><AlertCircle size={11} /> Translator is online: {info.translate_provider}</span>
                : <span className="settings-badge"><CheckCircle size={11} /> Offline translator</span>
            }
          />
          <Row
            label="Model telemetry"
            value={<span className="settings-badge"><CheckCircle size={11} /> None — no tracking</span>}
          />
        </section>
      )}
    </div>
  );
}
