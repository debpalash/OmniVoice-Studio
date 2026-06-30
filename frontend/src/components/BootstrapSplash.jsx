/**
 * First-run bootstrap splash — the "installing" act of the first-run journey.
 *
 * Two data sources drive this UI:
 *   1. `bootstrap_status` Tauri command (polled every 1 s) — coarse stage.
 *   2. `bootstrap-log` + `bootstrap-progress` Tauri events — live stdout
 *      from `uv sync`, ffmpeg byte counts, etc. The log panel shows the
 *      last N lines so users can see *something* happening during the 5–10
 *      min dependency install.
 *
 * Visual language: the same "studio console" system as FirstRunSetup
 * (frs-* classes from FirstRunSetup.css) — whisper waveform masthead,
 * engraved mono section titles, LED step rail, segmented progress meter —
 * so setup → install → model wizard reads as one continuous experience.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Brush, Check, Clipboard, Globe, Lightbulb } from 'lucide-react';
import { copyText } from '../utils/copyText';
import './FirstRunSetup.css';
import './BootstrapSplash.css';
import { useTranslation } from 'react-i18next';
import i18n, { LANGUAGES } from '../i18n';
import { useAppStore } from '../store';

// First-run only: keep the setup screen out of the main bundle so every
// regular launch pays nothing for it.
const FirstRunSetup = lazy(() => import('./FirstRunSetup'));

const getSystemLanguage = () => {
  if (typeof navigator === 'undefined') return 'en';
  const navLang = navigator.language || (navigator.languages && navigator.languages[0]) || 'en';
  if (navLang.toLowerCase().includes('tw') || navLang.toLowerCase().includes('hk')) return 'zh-TW';
  const match = [
    'zh-CN',
    'es',
    'fr',
    'de',
    'ja',
    'pt',
    'it',
    'ru',
    'ko',
    'hi',
    'tr',
    'pl',
    'nl',
    'sv',
    'th',
    'vi',
    'id',
    'uk',
    'ar',
  ].find((code) => navLang.startsWith(code.split('-')[0]));
  return match || 'en';
};

// Vite injects package.json version at build time.
const APP_VERSION = __APP_VERSION__ || '0.0.0';

const STAGE_LABEL = {
  checking: 'Checking environment…',
  downloading_uv: 'Downloading uv (Python package manager)…',
  creating_venv: 'Creating Python virtual environment…',
  installing_deps: 'Installing dependencies — first run, 5–10 min.',
  starting_backend: 'Starting backend…',
  ready: 'Ready',
  failed: 'Setup failed',
};

const STEPS = [
  'checking',
  'downloading_uv',
  'creating_venv',
  'installing_deps',
  'starting_backend',
];

const MAX_LOG_LINES = 200;

/** Scan logs + error message for known failure patterns and return i18n keys
 *  for actionable hints (resolved with `t(...)` at render — English defaults
 *  live in locales/en.json under `bootstrap.hint_*`). */
function detectHints(message, logs) {
  const hints = [];
  const all = (message || '') + '\n' + logs.map((l) => l.line).join('\n');
  if (/README\.md/i.test(all)) hints.push('bootstrap.hint_readme');
  // python-build-standalone download failure (issue #57, #60): user's network
  // can't reach the github.com release. We auto-retry with a system-Python
  // fallback in bootstrap.rs, but if that also fails the user needs an actionable next step.
  if (/python-build-standalone|managed-python download failed/i.test(all)) {
    hints.push('bootstrap.hint_python_mirror');
  }
  if (/uv.*download|uv.*install/i.test(all) && /timeout|connection/i.test(all))
    hints.push('bootstrap.hint_uv_timeout');
  if (/uv sync failed/i.test(all)) hints.push('bootstrap.hint_uv_sync');
  if (/hatchling|build_editable/i.test(all)) hints.push('bootstrap.hint_build_backend');
  if (/ffmpeg/i.test(all) && /download|timeout/i.test(all)) hints.push('bootstrap.hint_ffmpeg');
  if (/port.*in use|address.*in use/i.test(all)) hints.push('bootstrap.hint_port');
  if (/no error output/i.test(all)) hints.push('bootstrap.hint_silent_crash');
  if (/seems stuck at|never reported ready/i.test(all)) hints.push('bootstrap.hint_stuck');
  if (/blocking GitHub|couldn't download Python|python-build-standalone|dns error/i.test(all))
    hints.push('bootstrap.hint_github_blocked');
  if (hints.length === 0) hints.push('bootstrap.hint_default');
  return hints;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return '<1m';
  return `${Math.round(seconds / 60)}m`;
}

function formatBytes(n) {
  if (!n || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Whisper waveform — same speech-cadence silhouette as the setup screen.
 *  Memoized like its FirstRunSetup/SetupWizard twins: the splash re-renders
 *  every poll tick and the silhouette never changes. */
function Waveform({ bars = 96 }) {
  const heights = useMemo(
    () =>
      Array.from({ length: bars }, (_, i) => {
        const t = i / bars;
        const v = Math.abs(
          Math.sin(t * Math.PI * 7.3) * 0.55 +
            Math.sin(t * Math.PI * 2.1 + 1.2) * 0.3 +
            Math.sin(t * Math.PI * 17.0 + 0.4) * 0.15,
        );
        return 0.18 + v * 0.82;
      }),
    [bars],
  );
  return (
    <div className="frs-wave" aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className="frs-wave__bar"
          style={{ '--h': h, '--d': `${(i * 73) % 1400}ms` }}
        />
      ))}
    </div>
  );
}

export function BootstrapSplash({ stage, message }) {
  const { t } = useTranslation();
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);

  const handleLocaleChange = (id) => {
    setLocale(id);
    i18n.changeLanguage(id);
  };

  const systemLang = getSystemLanguage();
  const [showSuggestion, setShowSuggestion] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem('dismissed_lang_suggestion');
    if (systemLang !== locale && systemLang !== 'en' && !dismissed) {
      setShowSuggestion(true);
    }
  }, [locale, systemLang]);

  const acceptSuggestion = () => {
    handleLocaleChange(systemLang);
    setShowSuggestion(false);
  };

  const dismissSuggestion = () => {
    localStorage.setItem('dismissed_lang_suggestion', 'true');
    setShowSuggestion(false);
  };

  const label = t(`bootstrap.${stage}`, STAGE_LABEL[stage]);
  const stepIndex = Math.max(0, STEPS.indexOf(stage));
  const isFailed = stage === 'failed';
  const [logs, setLogs] = useState([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState(null);
  const [region, setRegionState] = useState('auto');
  const [retrying, setRetrying] = useState(false);
  const logRef = useRef(null);
  const prevProgRef = useRef(null); // {bytes, t} — last progress event
  const rateRef = useRef(0); // EMA bytes/sec across events

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setLogs([]);
      await invoke('retry_bootstrap');
    } catch (e) {
      console.error('retry failed', e);
    } finally {
      setRetrying(false);
    }
  };

  const handleCleanRetry = async () => {
    if (retrying) return;
    if (!confirm(t('bootstrap.clean_retry_confirm'))) return;
    setRetrying(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setLogs([]);
      await invoke('clean_and_retry_bootstrap');
    } catch (e) {
      console.error('clean retry failed', e);
    } finally {
      setRetrying(false);
    }
  };

  // Load persisted region on mount.
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const r = await invoke('get_region');
        if (r) setRegionState(r);
      } catch {
        /* older build without region support */
      }
    })();
  }, []);

  const handleRegionChange = async (newRegion) => {
    setRegionState(newRegion);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_region', { region: newRegion });
    } catch {
      /* silent */
    }
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
            setLogs(
              buffered.map(({ stage: s, line }) => ({
                stage: s,
                line,
                t: Date.now(),
              })),
            );
          }
        } catch {
          /* command may not exist in older builds */
        }

        // Subscribe to live events for anything new from here on.
        unlistenLog = await listen('bootstrap-log', (e) => {
          const { stage: s, line } = e.payload || {};
          if (!line) return;
          setLogs((prev) => {
            // Deduplicate against backfill by checking the last few lines.
            const lastFew = prev.slice(-5);
            if (lastFew.some((l) => l.stage === s && l.line === line)) return prev;
            const next = prev.concat([{ stage: s, line, t: Date.now() }]);
            return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
          });
        });
        unlistenProgress = await listen('bootstrap-progress', (e) => {
          const payload = e.payload || null;
          // EMA byte-rate from successive events → ETA for the long stretch.
          if (payload?.bytes_done != null) {
            const now = Date.now();
            const prev = prevProgRef.current;
            if (prev && payload.bytes_done > prev.bytes && now > prev.t) {
              const inst = (payload.bytes_done - prev.bytes) / ((now - prev.t) / 1000);
              rateRef.current = rateRef.current ? rateRef.current * 0.7 + inst * 0.3 : inst;
            }
            prevProgRef.current = { bytes: payload.bytes_done, t: now };
          }
          setProgress(payload);
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
  useEffect(() => {
    if (isFailed) setLogsOpen(true);
  }, [isFailed]);

  const handleCopyLogs = () => {
    const logText =
      logs.length === 0
        ? 'No log output captured.'
        : logs.map((l) => `[${l.stage}] ${l.line}`).join('\n');
    const full =
      isFailed && message ? `ERROR: ${message}\n\n--- Bootstrap Logs ---\n${logText}` : logText;
    copyText(full)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  const stageProgress = progress && progress.stage === stage ? progress : null;
  const pctFromBytes = stageProgress?.percent != null ? stageProgress.percent : null;
  // Overall journey progress: completed steps + byte-progress within the
  // current step when the backend reports it.
  const overallPct = Math.min(
    100,
    ((stepIndex + (pctFromBytes != null ? pctFromBytes / 100 : 0.4)) / STEPS.length) * 100,
  );

  // First run with nothing installed: Rust parks in `awaiting_setup` and the
  // install-plan screen takes over. complete_setup advances the stage, and
  // the regular progress UI below resumes automatically on the next poll.
  // (Checked after every hook above so the setup → install transition keeps
  // the hook order stable.)
  if (stage === 'awaiting_setup') {
    return (
      <Suspense
        fallback={
          <div className="frs">
            <div className="frs__atmo" />
          </div>
        }
      >
        <FirstRunSetup />
      </Suspense>
    );
  }

  return (
    <div className="frs">
      <div className="frs__atmo" aria-hidden="true" />
      <div className="frs__deck frs__deck--focus">
        {/* ── Masthead: same identity as the setup screen ───────────────── */}
        <header className="frs__mast frs-rise" style={{ '--rise': 0 }} data-tauri-drag-region>
          <Waveform />
          {/* Journey rail: act 2 of the install flow (setup already done). */}
          <nav
            className="frs-wsteps frs-wsteps--journey"
            aria-label={t('bootstrap.title', 'OmniVoice Studio')}
          >
            <span className="frs-wstep is-done">
              <span className="frs-wstep__led" aria-hidden="true" />
              {t('firstrun.stage_setup', 'Setup')}
            </span>
            <span className="frs-wstep is-active">
              <span className="frs-wstep__led" aria-hidden="true" />
              {t('firstrun.installing_title', 'Installing')}
            </span>
            <span className="frs-wstep">
              <span className="frs-wstep__led" aria-hidden="true" />
              {t('firstrun.stage_models', 'Models & engines')}
            </span>
          </nav>
          <div className="frs__mast-row">
            <div className="frs__mast-text">
              <h1 className="frs__title">{t('bootstrap.title', 'OmniVoice Studio')}</h1>
              <p className="frs__subtitle" aria-live="polite">
                {label}
              </p>
            </div>
            <div className="frs__mast-meta">
              <div className="frs__mast-selects">
                <select
                  className="frs-select frs-select--lang"
                  value={locale}
                  onChange={(e) => handleLocaleChange(e.target.value)}
                  aria-label={t('firstrun.language', 'Language')}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <select
                  className="frs-select frs-select--lang"
                  value={region}
                  onChange={(e) => handleRegionChange(e.target.value)}
                  aria-label={t('firstrun.region_label', 'Download region')}
                >
                  <option value="auto">🌐 {t('bootstrap.auto_detect', 'Auto-detect')}</option>
                  <option value="global">🌐 {t('bootstrap.region_global')}</option>
                  <option value="china">🇨🇳 {t('bootstrap.region_china')}</option>
                  <option value="russia">🇷🇺 {t('bootstrap.region_russia')}</option>
                  <option value="restricted">🌍 {t('bootstrap.region_restricted')}</option>
                </select>
              </div>
            </div>
          </div>
        </header>

        {showSuggestion && (
          <div className="frs-banner frs-rise" style={{ '--rise': 1 }}>
            <span>
              <Globe size={12} />{' '}
              {t('bootstrap.suggest_lang', {
                lang: LANGUAGES.find((l) => l.code === systemLang)?.label || systemLang,
              })}
            </span>
            <div className="frs-banner__actions">
              <button type="button" className="frs-btn frs-btn--quiet" onClick={acceptSuggestion}>
                {t('common.yes', 'Yes')}
              </button>
              <button type="button" className="frs-btn frs-btn--quiet" onClick={dismissSuggestion}>
                {t('common.no', 'No')}
              </button>
            </div>
          </div>
        )}

        {isFailed ? (
          <section className="frs-panel frs-rise" style={{ '--rise': 1 }}>
            <h2 className="frs-panel__title">{t('bootstrap.failed', 'Setup failed')}</h2>
            <pre className="frs__error">{message || t('bootstrap.unknown_error')}</pre>
            <div className="frs-hints">
              <span className="frs-hints__label">
                <Lightbulb size={12} /> {t('bootstrap.what_to_try', 'What to try:')}
              </span>
              <ul>
                {detectHints(message, logs).map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </div>
            <div className="frs-banner__actions frs-banner__actions--end">
              <button
                type="button"
                className="frs-btn frs-btn--quiet"
                onClick={handleCleanRetry}
                disabled={retrying}
              >
                <Brush size={12} /> {t('bootstrap.clean_retry', 'Clean & Retry')}
              </button>
              <button
                type="button"
                className={`frs-btn frs-btn--primary ${retrying ? '' : 'is-armed'}`}
                onClick={handleRetry}
                disabled={retrying}
              >
                <span className="frs-btn__led" aria-hidden="true" />
                {retrying ? t('bootstrap.retrying', 'Retrying…') : t('bootstrap.retry', 'Retry')}
              </button>
            </div>
          </section>
        ) : (
          <section className="frs-panel frs-rise" style={{ '--rise': 1 }}>
            <h2 className="frs-panel__title">{t('firstrun.installing_title', 'Installing')}</h2>
            {/* Overall journey meter — the same LED segments as the setup
                screen's disk gate, now measuring progress instead of space. */}
            <div
              className="frs-meter frs-meter--progress"
              role="progressbar"
              aria-valuenow={Math.round(overallPct)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span className="frs-meter__fill" style={{ width: `${overallPct}%` }} />
            </div>
            <ol className="frs-steps">
              {STEPS.map((s, i) => (
                <li
                  key={s}
                  className={[
                    'frs-step',
                    i < stepIndex ? 'is-done' : i === stepIndex ? 'is-active' : 'is-pending',
                  ].join(' ')}
                >
                  <span className="frs-step__led" aria-hidden="true" />
                  <span className="frs-step__label">{t(`bootstrap.${s}`, STAGE_LABEL[s])}</span>
                  {i === stepIndex && stageProgress && (
                    <span className="frs-step__bytes">
                      {formatBytes(stageProgress.bytes_done)}
                      {stageProgress.bytes_total > 0
                        ? ` / ${formatBytes(stageProgress.bytes_total)}`
                        : ''}
                      {pctFromBytes != null ? ` (${pctFromBytes}%)` : ''}
                      {stageProgress.bytes_total > 0 &&
                        rateRef.current > 0 &&
                        stageProgress.bytes_done < stageProgress.bytes_total &&
                        ` · ${t('firstrun.eta_left', {
                          eta: formatEta(
                            (stageProgress.bytes_total - stageProgress.bytes_done) /
                              rateRef.current,
                          ),
                          defaultValue: '~{{eta}} left',
                        })}`}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            <p className="frs__trust">
              {t(
                'firstrun.resume_note',
                'Interrupted downloads resume automatically — closing the app is safe.',
              )}
            </p>
          </section>
        )}

        {/* ── Live log — always reachable, quiet by design ───────────────── */}
        <section className="frs-panel frs-rise" style={{ '--rise': 2 }}>
          <h2 className="frs-panel__title">
            {t('firstrun.activity_title', 'Activity')}
            <span className="frs-log__meta">
              {logs.length > 0 && t('bootstrap.lines', { count: logs.length })}
            </span>
          </h2>
          <div className="frs-log__bar">
            <button
              type="button"
              className="frs-btn frs-btn--quiet"
              onClick={() => setLogsOpen((v) => !v)}
            >
              {logsOpen
                ? '▾ ' + t('bootstrap.hide_logs', 'Hide logs')
                : '▸ ' + t('bootstrap.show_logs', 'Show logs')}
            </button>
            <button type="button" className="frs-btn frs-btn--quiet" onClick={handleCopyLogs}>
              {copied ? (
                <>
                  <Check size={12} /> {t('bootstrap.copied', 'Copied!')}
                </>
              ) : (
                <>
                  <Clipboard size={12} /> {t('bootstrap.copy', 'Copy')}
                </>
              )}
            </button>
          </div>
          {logsOpen && (
            <pre className="frs-log" ref={logRef}>
              {logs.length === 0
                ? t('bootstrap.waiting_output', 'Waiting for output…')
                : logs.map((l) => `[${l.stage}] ${l.line}`).join('\n')}
            </pre>
          )}
        </section>

        <footer className="frs__foot frs-rise" style={{ '--rise': 3 }}>
          <div className="frs__foot-row">
            <span className="frs__totals">
              <span className="frs__plate">OVS&thinsp;·&thinsp;v{APP_VERSION}</span>
            </span>
          </div>
        </footer>
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
    if (typeof window === 'undefined') {
      setState({ stage: 'ready', message: null });
      return;
    }
    if (!('__TAURI_INTERNALS__' in window)) {
      setState({ stage: 'ready', message: null });
      return;
    }
    if (import.meta.env.DEV) {
      setState({ stage: 'ready', message: null });
      return;
    }

    let cancelled = false;
    let timer = null;
    let misses = 0;
    // Stall watchdog (#474): if the backend hangs in a non-terminal stage and
    // never reports `ready` (e.g. a failed Python-backend spawn on a from-source
    // build), the poll loop would otherwise spin forever and trap the user on a
    // buttonless splash. Track when the (stage,message) last changed; if it
    // stays put past the stage's budget, flip to `failed` so the existing
    // hints + Retry + logs surface instead of an info-less infinite spinner.
    // installing_deps legitimately runs 5–10 min, so it gets a long leash; any
    // (stage,message) change resets the clock so a live install never trips it.
    let lastChangeTs = Date.now();
    let lastKey = '';
    const stallBudgetMs = (stage) => (stage === 'installing_deps' ? 20 * 60 * 1000 : 120 * 1000);
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
      if (!tauriInvoke) {
        setState({ stage: 'ready', message: null });
        return;
      }
      const tick = async () => {
        if (cancelled) return;
        try {
          const res = await tauriInvoke('bootstrap_status');
          if (cancelled) return;
          misses = 0;
          const stage = res.stage || 'ready';
          const message = res.message || null;
          // Reset the stall clock whenever something actually changes.
          const key = `${stage}|${message || ''}`;
          if (key !== lastKey) {
            lastKey = key;
            lastChangeTs = Date.now();
          }
          // Rust returns { stage: 'ready' } or { stage: 'failed', message: '…' } etc.
          if (stage !== 'ready' && stage !== 'failed') {
            if (Date.now() - lastChangeTs > stallBudgetMs(stage)) {
              // Stuck — surface it as a failure so Retry/logs/hints appear.
              setState({
                stage: 'failed',
                message:
                  (message ? message + '\n\n' : '') +
                  `Setup seems stuck at "${stage}" — the backend never reported ready. ` +
                  `Check the log below, then Retry. If you're running from source, make sure ` +
                  `\`uv sync\` completed and uv/Python are on your PATH.`,
              });
              return; // stop polling — failed is terminal
            }
            setState({ stage, message });
            timer = setTimeout(tick, pollMs);
          } else {
            setState({ stage, message });
          }
        } catch {
          // A transient IPC hiccup (e.g. the very first poll racing webview
          // init) must NOT permanently declare 'ready' — that kills the poll
          // loop and silently skips the awaiting_setup / progress screens.
          // Retry a few times before conceding.
          misses += 1;
          if (cancelled) return;
          if (misses < 5) {
            timer = setTimeout(tick, pollMs);
          } else {
            setState({ stage: 'ready', message: null });
          }
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
