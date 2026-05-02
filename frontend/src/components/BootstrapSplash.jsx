/**
 * First-run bootstrap splash.
 *
 * Two data sources drive this UI:
 *   1. `bootstrap_status` Tauri command (polled every 1 s) — coarse stage.
 *   2. `bootstrap-log` + `bootstrap-progress` Tauri events — live stdout
 *      from `uv sync`, ffmpeg byte counts, etc. The log panel shows the
 *      last N lines so users can see *something* happening during the 5–10
 *      min dependency install.
 */
import { useEffect, useRef, useState } from 'react';
import './BootstrapSplash.css';

// Vite injects package.json version at build time.
const APP_VERSION = __APP_VERSION__ || '0.0.0';

const STAGE_LABEL = {
  checking:           'Checking environment…',
  downloading_uv:     'Downloading uv (Python package manager)…',
  creating_venv:      'Creating Python virtual environment…',
  installing_deps:    'Installing dependencies — first run, 5–10 min.',
  starting_backend:   'Starting backend…',
  ready:              'Ready',
  failed:             'Setup failed',
};

const STEPS = [
  'checking',
  'downloading_uv',
  'creating_venv',
  'installing_deps',
  'starting_backend',
];

const MAX_LOG_LINES = 200;

/** Scan logs + error message for known failure patterns and return actionable hints. */
function detectHints(message, logs) {
  const hints = [];
  const all = (message || '') + '\n' + logs.map(l => l.line).join('\n');
  if (/README\.md/i.test(all))           hints.push('README.md was missing from the bundle. This is now auto-fixed — retry should work.');
  if (/uv.*download|uv.*install/i.test(all) && /timeout|connection/i.test(all)) hints.push('Network timeout downloading uv. Check your internet connection or try the China mirror.');
  if (/uv sync failed/i.test(all))       hints.push('Dependency install failed. "Clean & Retry" will delete the cached venv and start fresh.');
  if (/hatchling|build_editable/i.test(all)) hints.push('Python build backend error. "Clean & Retry" removes the broken venv so it rebuilds from scratch.');
  if (/ffmpeg/i.test(all) && /download|timeout/i.test(all)) hints.push('ffmpeg download failed. This is non-fatal — retry or install ffmpeg manually.');
  if (/port.*in use|address.*in use/i.test(all)) hints.push('Port 3900 is already in use. Close other instances of OmniVoice or apps using that port.');
  if (/no error output/i.test(all))      hints.push('Backend crashed silently. "Clean & Retry" often fixes corrupt venv issues.');
  if (hints.length === 0)                hints.push('Try "Retry" first. If it fails again, "Clean & Retry" will rebuild the environment from scratch.');
  return hints;
}

function formatBytes(n) {
  if (!n || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function BootstrapSplash({ stage, message }) {
  const label = STAGE_LABEL[stage] || stage;
  const stepIndex = Math.max(0, STEPS.indexOf(stage));
  const isFailed = stage === 'failed';
  const [logs, setLogs] = useState([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState(null);
  const [region, setRegionState] = useState('auto');
  const [retrying, setRetrying] = useState(false);
  const logRef = useRef(null);

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setLogs([]);
      await invoke('retry_bootstrap');
    } catch (e) { console.error('retry failed', e); }
    finally { setRetrying(false); }
  };

  const handleCleanRetry = async () => {
    if (retrying) return;
    if (!confirm('This will delete the cached Python environment and re-download all dependencies (~5-10 min). Continue?')) return;
    setRetrying(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setLogs([]);
      await invoke('clean_and_retry_bootstrap');
    } catch (e) { console.error('clean retry failed', e); }
    finally { setRetrying(false); }
  };

  // Load persisted region on mount.
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const r = await invoke('get_region');
        if (r) setRegionState(r);
      } catch { /* older build without region support */ }
    })();
  }, []);

  const handleRegionChange = async (newRegion) => {
    setRegionState(newRegion);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_region', { region: newRegion });
    } catch { /* silent */ }
  };

  // Subscribe to live log + progress events from the Rust bootstrap.
  // Also backfill any logs emitted before the webview finished loading.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('__TAURI_INTERNALS__' in window)) return;
    let unlistenLog = null;
    let unlistenProgress = null;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { invoke } = await import('@tauri-apps/api/core');
        if (cancelled) return;

        // Backfill: fetch all log lines buffered on the Rust side before
        // the webview was ready to receive events.
        try {
          const buffered = await invoke('get_bootstrap_logs');
          if (!cancelled && Array.isArray(buffered) && buffered.length > 0) {
            setLogs(buffered.map(({ stage: s, line }) => ({
              stage: s, line, t: Date.now(),
            })));
          }
        } catch { /* command may not exist in older builds */ }

        // Subscribe to live events for anything new from here on.
        unlistenLog = await listen('bootstrap-log', (e) => {
          const { stage: s, line } = e.payload || {};
          if (!line) return;
          setLogs((prev) => {
            // Deduplicate against backfill by checking the last few lines.
            const lastFew = prev.slice(-5);
            if (lastFew.some(l => l.stage === s && l.line === line)) return prev;
            const next = prev.concat([{ stage: s, line, t: Date.now() }]);
            return next.length > MAX_LOG_LINES
              ? next.slice(next.length - MAX_LOG_LINES)
              : next;
          });
        });
        unlistenProgress = await listen('bootstrap-progress', (e) => {
          setProgress(e.payload || null);
        });
      } catch {
        /* not in Tauri or listen unavailable — silent */
      }
    })();
    return () => {
      cancelled = true;
      if (unlistenLog) unlistenLog();
      if (unlistenProgress) unlistenProgress();
    };
  }, []);

  // Auto-scroll the log panel to the latest line whenever it opens or
  // new lines arrive.
  useEffect(() => {
    if (logsOpen && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, logsOpen]);

  // Auto-expand logs on failure so users can see + copy the full output.
  // Also expand on failure (in case user collapsed manually).
  useEffect(() => {
    if (isFailed) setLogsOpen(true);
  }, [isFailed]);

  const handleCopyLogs = () => {
    const logText = logs.length === 0
      ? 'No log output captured.'
      : logs.map(l => `[${l.stage}] ${l.line}`).join('\n');
    const full = isFailed && message
      ? `ERROR: ${message}\n\n--- Bootstrap Logs ---\n${logText}`
      : logText;
    navigator.clipboard.writeText(full).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const stageProgress = progress && progress.stage === stage ? progress : null;
  const pctFromBytes = stageProgress?.percent != null ? stageProgress.percent : null;

  return (
    <div className="bootstrap-splash">
      <div className="bootstrap-splash__card">
        <div className="bootstrap-splash__title-row">
          <h1>OmniVoice Studio</h1>
          <span className="bootstrap-splash__version">v{APP_VERSION}</span>
          <div className="bootstrap-splash__region">
            <select
              className="bootstrap-splash__region-select"
              value={region}
              onChange={(e) => handleRegionChange(e.target.value)}
            >
              <option value="auto">🌐 Auto-detect</option>
              <option value="global">🌐 Global (direct)</option>
              <option value="china">🇨🇳 China (mirror)</option>
              <option value="russia">🇷🇺 Russia (mirror)</option>
              <option value="restricted">🌍 Restricted (mirror)</option>
            </select>
          </div>
        </div>
        <p className="bootstrap-splash__status">{label}</p>
        {isFailed ? (
          <>
            <pre className="bootstrap-splash__error">{message || 'Unknown error'}</pre>
            <div className="bootstrap-splash__hints">
              <strong>💡 What to try:</strong>
              <ul>
                {detectHints(message, logs).map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            </div>
            <div className="bootstrap-splash__actions">
              <button className="bootstrap-splash__retry-btn" onClick={handleRetry} disabled={retrying}>
                {retrying ? '⏳ Retrying…' : '🔄 Retry'}
              </button>
              <button className="bootstrap-splash__retry-btn bootstrap-splash__retry-btn--danger" onClick={handleCleanRetry} disabled={retrying}>
                🧹 Clean & Retry
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="bootstrap-splash__bar">
              <div
                className="bootstrap-splash__bar-fill"
                style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
              />
            </div>
            {stageProgress && (
              <div className="bootstrap-splash__sub-progress">
                <div className="bootstrap-splash__sub-bar">
                  <div
                    className="bootstrap-splash__sub-bar-fill"
                    style={{ width: `${pctFromBytes ?? 0}%` }}
                  />
                </div>
                <span className="bootstrap-splash__sub-label">
                  {formatBytes(stageProgress.bytes_done)}
                  {stageProgress.bytes_total > 0
                    ? ` / ${formatBytes(stageProgress.bytes_total)}`
                    : ''}
                  {pctFromBytes != null ? ` (${pctFromBytes}%)` : ''}
                </span>
              </div>
            )}
            <ol className="bootstrap-splash__steps">
              {STEPS.map((s, i) => (
                <li
                  key={s}
                  className={
                    i < stepIndex ? 'done' :
                    i === stepIndex ? 'active' :
                    'pending'
                  }
                >
                  {STAGE_LABEL[s]}
                </li>
              ))}
            </ol>
          </>
        )}
        {/* Live log panel — always visible so users see what's happening */}
        <div className="bootstrap-splash__log-header">
          <button
            type="button"
            className="bootstrap-splash__log-toggle"
            onClick={() => setLogsOpen((v) => !v)}
          >
            {logsOpen ? '▾ Hide logs' : '▸ Show logs'}
          </button>
          <span className="bootstrap-splash__log-count">
            {logs.length > 0 && `${logs.length} lines`}
          </span>
          <button
            type="button"
            className="bootstrap-splash__copy-btn"
            onClick={handleCopyLogs}
          >
            {copied ? '✓ Copied!' : '📋 Copy'}
          </button>
        </div>
        {logsOpen && (
          <pre className="bootstrap-splash__logs" ref={logRef}>
            {logs.length === 0
              ? 'Waiting for output…'
              : logs.map((l, i) => `[${l.stage}] ${l.line}`).join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Hook: polls the Rust `bootstrap_status` command every pollMs ms. Returns
 * the current stage (string) + message. In a non-Tauri context (dev web),
 * returns 'ready' immediately so the splash never mounts.
 */
export function useBootstrapStage(pollMs = 1000) {
  const [state, setState] = useState({ stage: 'checking', message: null });

  useEffect(() => {
    if (typeof window === 'undefined') { setState({ stage: 'ready', message: null }); return; }
    if (!('__TAURI_INTERNALS__' in window)) { setState({ stage: 'ready', message: null }); return; }
    if (import.meta.env.DEV) { setState({ stage: 'ready', message: null }); return; }

    let cancelled = false;
    let timer = null;
    const invoke = async () => {
      try {
        const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
        return tauriInvoke;
      } catch {
        return null;
      }
    };
    (async () => {
      const tauriInvoke = await invoke();
      if (!tauriInvoke) { setState({ stage: 'ready', message: null }); return; }
      const tick = async () => {
        if (cancelled) return;
        try {
          const res = await tauriInvoke('bootstrap_status');
          if (cancelled) return;
          // Rust returns { stage: 'ready' } or { stage: 'failed', message: '…' } etc.
          setState({ stage: res.stage || 'ready', message: res.message || null });
          if (res.stage !== 'ready' && res.stage !== 'failed') {
            timer = setTimeout(tick, pollMs);
          }
        } catch {
          setState({ stage: 'ready', message: null });
        }
      };
      tick();
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);

  return state;
}
