import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  CheckCircle, Loader, ArrowRight, AlertTriangle, XCircle,
  RefreshCw, Monitor, Download, Cog, FolderOpen,
} from 'lucide-react';
import { Button } from '../ui';
import { useSetupStatus, usePreflight } from '../api/hooks';
import { ModelStoreTab, EnginesTab } from './Settings';
import './SetupWizard.css';
import '../components/Misc.css';

// macOS convention: double-click the title-bar drag region to toggle zoom.
const doubleClickMaximize = async () => {
  try {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().toggleMaximize();
  } catch { /* non-tauri preview — ignore */ }
};

/** Shorten an absolute path for display: /Users/foo/.cache/x → ~/.cache/x */
function shortenPath(p) {
  if (!p) return '~/.cache/huggingface';
  try {
    const home = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)/)?.[0];
    if (home) return p.replace(home, '~');
  } catch { /* fallthrough */ }
  return p;
}

/** Open a path in the OS file manager (Tauri only, no-op on web). */
async function revealPath(path) {
  try {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
  } catch { /* ignore — probably web preview */ }
}

const CHECK_ICON = {
  pass: <CheckCircle size={13} />,
  warn: <AlertTriangle size={13} />,
  fail: <XCircle size={13} />,
};

/* ── Welcome step cards ────────────────────────────────────────────────── */

const WELCOME_CARDS = [
  {
    icon: <Monitor size={16} />,
    title: 'System check',
    desc: 'Probe RAM, disk, GPU, ffmpeg, and network. Blockers are flagged upfront so you know before downloading.',
  },
  {
    icon: <Download size={16} />,
    title: 'Install models',
    desc: 'Download ~5 GB of weights — TTS + Whisper. Required models first, optional ones later.',
  },
  {
    icon: <Cog size={16} />,
    title: 'Pick engines',
    desc: 'Choose TTS / ASR / LLM backends. Defaults work out of the box — customize anytime in Settings.',
  },
];

/* ── Preflight panel ───────────────────────────────────────────────────── */

function PreflightPanel({ report, loading, onRecheck }) {
  if (loading && !report) {
    return (
      <div className="swiz-loading">
        <Loader className="spinner" size={14} /> Probing system…
      </div>
    );
  }
  if (!report) return null;
  return (
    <div className="swiz-checklist">
      <div className="swiz-check-header">
        <span className="swiz-check-header__label">System preflight</span>
        <Button variant="ghost" size="sm" onClick={onRecheck} leading={<RefreshCw size={12} />}>
          Re-check
        </Button>
      </div>
      {report.checks.map((c) => (
        <div key={c.id} className="setup-wizard__row swiz-check-row" style={{ alignItems: 'flex-start', padding: '8px 4px' }}>
          <span className={`swiz-check-icon swiz-check-icon--${c.status}`}>
            {CHECK_ICON[c.status] || null}
          </span>
          <div className="setup-wizard__row-body">
            <span className="setup-wizard__row-title">{c.label}</span>
            <span className="setup-wizard__muted" style={{ whiteSpace: 'normal' }}>{c.detail}</span>
            {c.fix && c.status !== 'pass' && (
              <span className="setup-wizard__muted" style={{
                color: c.status === 'fail' ? 'var(--color-danger)' : 'var(--color-warn, #fabd2f)',
                marginTop: 2,
                whiteSpace: 'normal',
              }}>
                → {c.fix}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Stepper nav with connectors ───────────────────────────────────────── */

const STEP_LABELS = ['Welcome', 'System check', 'Install models', 'Pick engines'];

function StepperNav({ step, onStep }) {
  return (
    <div className="setup-wizard__steps" data-tauri-drag-region>
      {STEP_LABELS.map((label, i) => (
        <React.Fragment key={label}>
          {i > 0 && (
            <span className={`setup-wizard__step-connector${step > i - 1 ? ' setup-wizard__step-connector--done' : ''}`} />
          )}
          <button
            className={[
              'setup-wizard__step',
              step === i ? 'setup-wizard__step--active' : '',
              step > i ? 'setup-wizard__step--done' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => onStep(i)}
            type="button"
            aria-current={step === i ? 'step' : undefined}
            aria-label={`Step ${i + 1}: ${label}${step > i ? ' (completed)' : ''}`}
          >
            {step > i ? '✓ ' : `${i + 1}. `}{label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

/* ── Main wizard component ─────────────────────────────────────────────── */

/**
 * First-run / "no models installed" gate.
 *
 * Flow:
 *   0. Welcome    — hero + explainer + "continue"
 *   1. System     — /setup/preflight results
 *   2. Models     — ModelStoreTab, unlocks on models_ready
 *   3. Engines    — EnginesTab + "Enter studio"
 */
export default function SetupWizard({ onReady }) {
  const [step, setStep] = useState(0);

  // TanStack Query — shared cache, auto-refetch on step 2 (models)
  const setupQuery = useSetupStatus();
  const preQuery   = usePreflight();
  const status     = setupQuery.data ?? null;
  const pre        = preQuery.data ?? null;
  const preLoading = preQuery.isLoading;

  // Poll setup status every 4s while on Models step
  useEffect(() => {
    if (step !== 2) return;
    const iv = setInterval(() => setupQuery.refetch(), 4000);
    return () => clearInterval(iv);
  }, [step, setupQuery]);

  const recheckPreflight = useCallback(() => { preQuery.refetch(); }, [preQuery]);

  const modelsReady = !!status?.models_ready;
  const preflightOk = !!pre?.ok;

  const cachePath = status?.hf_cache_dir || '~/.cache/huggingface';

  return (
    <div className="setup-wizard">
      <StepperNav step={step} onStep={setStep} />

      <div
        data-tauri-drag-region
        onDoubleClick={doubleClickMaximize}
        className="setup-wizard__hero"
      >
        <img src="/favicon.svg" alt="" className="setup-wizard__logo" />
        <div className="setup-wizard__hero-text">
          <h1 data-tauri-drag-region>OmniVoice Studio</h1>
          <span className="setup-wizard__sub" data-tauri-drag-region>
            Dubbing, voice cloning, and voice design — all running locally on your machine.
          </span>
        </div>
      </div>

      {/* 0. Welcome */}
      {step === 0 && (
        <div className="swiz-slide" key="step-0">
          <div className="setup-wizard__embed">
            <div className="setup-wizard__welcome">
              <div className="setup-wizard__welcome-grid">
                {WELCOME_CARDS.map((card, i) => (
                  <div className="swiz-welcome-card" key={i}>
                    <div className="swiz-welcome-card__icon">{card.icon}</div>
                    <div className="swiz-welcome-card__body">
                      <span className="swiz-welcome-card__title">{card.title}</span>
                      <p className="swiz-welcome-card__desc">{card.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="swiz-welcome-note">
                First run takes 5–10 minutes to download. After that, every launch is instant and fully offline.
              </p>
            </div>
          </div>
          <div className="setup-wizard__nav">
            <span />
            <Button
              variant="primary" size="sm"
              onClick={() => setStep(1)}
              trailing={<ArrowRight size={14} />}
            >
              Get started
            </Button>
          </div>
        </div>
      )}

      {/* 1. System check */}
      {step === 1 && (
        <div className="swiz-slide" key="step-1">
          <div className="setup-wizard__embed">
            <PreflightPanel report={pre} loading={preLoading} onRecheck={recheckPreflight} />
          </div>
          <div className="setup-wizard__nav">
            <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
            <Button
              variant={preflightOk ? 'primary' : 'ghost'}
              onClick={() => setStep(2)}
              trailing={<ArrowRight size={14} />}
              disabled={!preflightOk}
              title={preflightOk ? '' : 'Resolve the failing checks above to continue.'}
            >
              {preflightOk
                ? (pre?.has_warnings ? 'Continue (with warnings)' : 'All good — continue')
                : 'Resolve blockers to continue'}
            </Button>
          </div>
        </div>
      )}

      {/* 2. Models */}
      {step === 2 && (
        <div className="swiz-slide" key="step-2">
          <div className="setup-wizard__embed">
            <ModelStoreTab info={null} modelBadge={null} />
            {!modelsReady && status?.missing?.length > 0 && (
              <p className="setup-wizard__muted swiz-missing" style={{ marginTop: 8 }}>
                Still needed:{' '}
                {status.missing.map(m => m.label).join(', ')}
              </p>
            )}
          </div>
          <div className="setup-wizard__nav">
            <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
            <Button
              variant={modelsReady ? 'primary' : 'ghost'}
              onClick={() => setStep(3)}
              trailing={<ArrowRight size={14} />}
              disabled={!modelsReady}
              title={modelsReady ? '' : 'Install the required models above to continue.'}
            >
              {modelsReady
                ? 'Required models ready — continue'
                : 'Waiting for required models…'}
            </Button>
          </div>
        </div>
      )}

      {/* 3. Engines */}
      {step === 3 && (
        <div className="swiz-slide" key="step-3">
          <div className="setup-wizard__embed">
            <EnginesTab />
          </div>
          <div className="setup-wizard__nav">
            <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
            <Button
              variant="primary"
              onClick={onReady}
              leading={<CheckCircle size={14} />}
            >
              Enter studio
            </Button>
          </div>
        </div>
      )}

      {!status && step > 1 && (
        <div className="swiz-status-loading">
          <Loader className="spinner" size={14} /> Checking setup…
        </div>
      )}

      <p className="setup-wizard__footnote">
        Downloads from <code>huggingface.co</code>
        <span style={{ margin: '0 2px' }}>·</span>
        Cache: <code>{shortenPath(cachePath)}</code>
        {'__TAURI_INTERNALS__' in window && cachePath && (
          <button
            className="setup-wizard__footnote-link"
            onClick={() => revealPath(cachePath)}
            title="Open in Finder"
          >
            <FolderOpen size={10} style={{ verticalAlign: '-1px', marginRight: 2 }} />
            Open
          </button>
        )}
      </p>
    </div>
  );
}
