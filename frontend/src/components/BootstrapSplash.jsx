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
 * Built on standard shadcn primitives + Tailwind utilities (themed by the
 * palette tokens), sharing the breathing-waveform / rise keyframes in
 * firstrun.css so setup → install → model wizard reads as one experience.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Brush, Check, ChevronDown, ChevronRight, Clipboard, Globe, Lightbulb } from 'lucide-react';
import { cn } from '@/lib/utils';
import { copyText } from '../utils/copyText';
import { useTranslation } from 'react-i18next';
import i18n, { LANGUAGES } from '../i18n';
import { useAppStore } from '../store';
import { Button, Progress, Select } from '../ui';

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
  // Intel-Mac backend unsupported (#889): PyTorch ships no macOS x86_64
  // wheels, so bootstrap.rs pre-fails with this message before any sync.
  if (/Intel Macs can't run the local AI backend/i.test(all)) {
    return ['bootstrap.hint_intel_mac']; // retrying can never help — show only this
  }
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
    <div className="fr-wave" aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className="fr-wave__bar"
          style={{ '--h': h, '--d': `${(i * 73) % 1400}ms` }}
        />
      ))}
    </div>
  );
}

/** Three-stage breadcrumb — setup done, installing active. */
function JourneyRail({ t }) {
  const stages = [
    [t('firstrun.stage_setup', 'Setup'), 'done'],
    [t('firstrun.installing_title', 'Installing'), 'active'],
    [t('firstrun.stage_models', 'Models & engines'), 'pending'],
  ];
  return (
    <nav
      className="flex flex-wrap items-center gap-x-5 gap-y-2"
      aria-label={t('bootstrap.title', 'OmniVoice Studio')}
    >
      {stages.map(([label, state]) => (
        <span
          key={label}
          className={cn(
            'inline-flex items-center gap-1.5 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.14em]',
            state === 'active'
              ? 'text-fg'
              : state === 'done'
                ? 'text-fg-muted'
                : 'text-fg-subtle/60',
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              state === 'active'
                ? 'bg-primary shadow-[0_0_6px_1px_var(--color-brand-glow)]'
                : state === 'done'
                  ? 'bg-success'
                  : 'bg-fg-subtle/40',
            )}
            aria-hidden="true"
          />
          {label}
        </span>
      ))}
    </nav>
  );
}

/** Mono error block. */
function ErrorBox({ children }) {
  return (
    <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-danger/10 px-3 py-2 font-mono text-[0.66rem] leading-relaxed text-danger shadow-[inset_2px_0_0_var(--color-danger)]">
      {children}
    </pre>
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
      <Suspense fallback={<div className="fixed inset-0 z-[9999] bg-bg" />}>
        <FirstRunSetup />
      </Suspense>
    );
  }

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center overflow-hidden bg-bg px-6 pt-12 font-sans text-fg">
      <div className="flex w-full max-w-[760px] flex-1 flex-col gap-4 overflow-y-auto pb-6">
        {/* ── Masthead: same identity as the setup screen ─────────────────── */}
        <header
          className="fr-rise flex flex-col gap-3 pb-1"
          style={{ '--rise': 0 }}
          data-tauri-drag-region
        >
          <Waveform />
          <JourneyRail t={t} />
          <div className="mt-2 flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              <h1 className="m-0 font-serif text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight tracking-tight">
                {t('bootstrap.title', 'OmniVoice Studio')}
              </h1>
              <p className="mt-1.5 text-sm leading-snug text-fg-muted" aria-live="polite">
                {label}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Select
                size="sm"
                value={locale}
                onChange={(e) => handleLocaleChange(e.target.value)}
                aria-label={t('firstrun.language', 'Language')}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
              <Select
                size="sm"
                value={region}
                onChange={(e) => handleRegionChange(e.target.value)}
                aria-label={t('firstrun.region_label', 'Download region')}
              >
                <option value="auto">🌐 {t('bootstrap.auto_detect', 'Auto-detect')}</option>
                <option value="global">🌐 {t('bootstrap.region_global')}</option>
                <option value="china">🇨🇳 {t('bootstrap.region_china')}</option>
                <option value="russia">🇷🇺 {t('bootstrap.region_russia')}</option>
                <option value="restricted">🌍 {t('bootstrap.region_restricted')}</option>
              </Select>
            </div>
          </div>
        </header>

        {showSuggestion && (
          <div
            className="fr-rise flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-primary/[0.08] px-3 py-2 text-sm"
            style={{ '--rise': 1 }}
          >
            <span className="inline-flex items-center gap-1.5">
              <Globe size={12} />{' '}
              {t('bootstrap.suggest_lang', {
                lang: LANGUAGES.find((l) => l.code === systemLang)?.label || systemLang,
              })}
            </span>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={acceptSuggestion}>
                {t('common.yes', 'Yes')}
              </Button>
              <Button variant="ghost" size="sm" onClick={dismissSuggestion}>
                {t('common.no', 'No')}
              </Button>
            </div>
          </div>
        )}

        {isFailed ? (
          <section className="fr-rise flex flex-col gap-2.5" style={{ '--rise': 1 }}>
            <h2 className="m-0 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-fg-muted">
              {t('bootstrap.failed', 'Setup failed')}
            </h2>
            <ErrorBox>{message || t('bootstrap.unknown_error')}</ErrorBox>
            <div className="text-sm leading-relaxed">
              <span className="inline-flex items-center gap-1.5 font-semibold">
                <Lightbulb size={12} /> {t('bootstrap.what_to_try', 'What to try:')}
              </span>
              <ul className="mt-1.5 flex list-disc flex-col gap-1.5 pl-5 text-fg-muted">
                {detectHints(message, logs).map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCleanRetry}
                disabled={retrying}
                leading={<Brush size={12} />}
              >
                {t('bootstrap.clean_retry', 'Clean & Retry')}
              </Button>
              <Button variant="primary" onClick={handleRetry} disabled={retrying}>
                {retrying ? t('bootstrap.retrying', 'Retrying…') : t('bootstrap.retry', 'Retry')}
              </Button>
            </div>
          </section>
        ) : (
          <section className="fr-rise flex flex-col gap-2.5" style={{ '--rise': 1 }}>
            <h2 className="m-0 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-fg-muted">
              {t('firstrun.installing_title', 'Installing')}
            </h2>
            {/* Overall journey meter. */}
            <Progress
              value={overallPct}
              tone="brand"
              size="md"
              aria-valuenow={Math.round(overallPct)}
            />
            <ol className="m-0 mt-1 flex list-none flex-col gap-2 p-0">
              {STEPS.map((s, i) => {
                const done = i < stepIndex;
                const activeStep = i === stepIndex;
                return (
                  <li
                    key={s}
                    className={cn(
                      'flex min-w-0 items-center gap-2 text-sm',
                      !done && !activeStep && 'opacity-45',
                    )}
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        done
                          ? 'bg-success shadow-[0_0_5px_1px_color-mix(in_srgb,var(--color-success)_50%,transparent)]'
                          : activeStep
                            ? 'bg-primary shadow-[0_0_6px_1px_var(--color-brand-glow)] fr-pulse'
                            : 'bg-fg-subtle/40',
                      )}
                      aria-hidden="true"
                    />
                    <span className={cn(activeStep && 'font-semibold', done && 'text-fg-muted')}>
                      {t(`bootstrap.${s}`, STAGE_LABEL[s])}
                    </span>
                    {activeStep && stageProgress && (
                      <span className="ml-auto whitespace-nowrap font-mono text-[0.64rem] tabular-nums text-fg-muted">
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
                );
              })}
            </ol>
            <p className="m-0 text-xs text-fg-subtle">
              {t(
                'firstrun.resume_note',
                'Interrupted downloads resume automatically — closing the app is safe.',
              )}
            </p>
          </section>
        )}

        {/* ── Live log — always reachable, quiet by design ────────────────── */}
        <section className="fr-rise flex flex-col gap-2.5" style={{ '--rise': 2 }}>
          <h2 className="m-0 flex items-center font-mono text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-fg-muted">
            {t('firstrun.activity_title', 'Activity')}
            <span className="ml-auto tracking-[0.08em] text-fg-subtle">
              {logs.length > 0 && t('bootstrap.lines', { count: logs.length })}
            </span>
          </h2>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLogsOpen((v) => !v)}
              leading={logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            >
              {logsOpen
                ? t('bootstrap.hide_logs', 'Hide logs')
                : t('bootstrap.show_logs', 'Show logs')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyLogs}
              leading={copied ? <Check size={12} /> : <Clipboard size={12} />}
            >
              {copied ? t('bootstrap.copied', 'Copied!') : t('bootstrap.copy', 'Copy')}
            </Button>
          </div>
          {logsOpen && (
            <pre
              className="m-0 max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-black/30 px-3 py-2 font-mono text-[0.64rem] leading-relaxed text-fg-muted"
              ref={logRef}
            >
              {logs.length === 0
                ? t('bootstrap.waiting_output', 'Waiting for output…')
                : logs.map((l) => `[${l.stage}] ${l.line}`).join('\n')}
            </pre>
          )}
        </section>

        <footer className="mt-auto pt-2">
          <span className="font-mono text-[0.62rem] tracking-[0.14em] text-fg-subtle">
            OVS&thinsp;·&thinsp;v{APP_VERSION}
          </span>
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
