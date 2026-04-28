import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Loader, ArrowRight, AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
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

const CHECK_ICON = {
  pass: <CheckCircle size={14} color="#8ec07c" />,
  warn: <AlertTriangle size={14} color="#fabd2f" />,
  fail: <XCircle size={14} color="#fb4934" />,
};

/**
 * Pre-flight panel — renders the /setup/preflight result as a pass/warn/fail
 * list. Wizard blocks forward-nav on any fail; warns pass through.
 */
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
      {report.checks.map((c) => (
        <div key={c.id} className="setup-wizard__row" style={{ alignItems: 'flex-start', padding: '6px 2px' }}>
          <span className="swiz-check-icon">{CHECK_ICON[c.status] || null}</span>
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
      <div className="swiz-check-footer">
        <Button variant="ghost" size="sm" onClick={onRecheck} leading={<RefreshCw size={12} />}>
          Re-check
        </Button>
      </div>
    </div>
  );
}

/**
 * First-run / "no models installed" gate.
 *
 * Flow:
 *   0. Welcome    — hero + explainer + "continue"
 *   1. System     — /setup/preflight results (OS, RAM, disk, GPU driver,
 *                   ffmpeg, network). Blocks on any fail.
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

  // Poll setup status every 4s while on Models step so "Finish" unlocks
  // as soon as downloads complete.
  useEffect(() => {
    if (step !== 2) return;
    const iv = setInterval(() => setupQuery.refetch(), 4000);
    return () => clearInterval(iv);
  }, [step, setupQuery]);

  const recheckPreflight = useCallback(() => { preQuery.refetch(); }, [preQuery]);

  const modelsReady = !!status?.models_ready;
  const preflightOk = !!pre?.ok;

  return (
    <div className="setup-wizard">
      <div className="setup-wizard__steps" data-tauri-drag-region>
        {['Welcome', 'System check', 'Install models', 'Pick engines'].map((label, i) => (
          <button
            key={label}
            className={[
              'setup-wizard__step',
              step === i ? 'setup-wizard__step--active' : '',
              step > i ? 'setup-wizard__step--done' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => setStep(i)}
            type="button"
            aria-current={step === i ? 'step' : undefined}
            aria-label={`Step ${i + 1}: ${label}${step > i ? ' (completed)' : ''}`}
          >
            {step > i ? '✓ ' : `${i + 1}. `}{label}
          </button>
        ))}
      </div>

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
        <>
          <div className="setup-wizard__embed">
            <div className="setup-wizard__welcome">
              <div className="setup-wizard__welcome-grid">
                <div className="flex items-start gap-3 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.025)] px-3.5 py-2.5">
                  <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[rgba(211,134,155,0.12)] text-[0.72rem] font-bold text-[var(--color-brand)]">1</span>
                  <div>
                    <strong className="mb-0.5 block text-[0.84rem] leading-[1.3]">System check</strong>
                    <p className="m-0 text-[0.78rem] leading-[1.5] text-[var(--color-fg-muted)]">Probe RAM, disk, GPU, ffmpeg, network. Blockers are flagged upfront.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.025)] px-3.5 py-2.5">
                  <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[rgba(211,134,155,0.12)] text-[0.72rem] font-bold text-[var(--color-brand)]">2</span>
                  <div>
                    <strong className="mb-0.5 block text-[0.84rem] leading-[1.3]">Install models</strong>
                    <p className="m-0 text-[0.78rem] leading-[1.5] text-[var(--color-fg-muted)]">Download ~5 GB of weights — TTS + Whisper. Required models first, optional ones later.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.025)] px-3.5 py-2.5">
                  <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[rgba(211,134,155,0.12)] text-[0.72rem] font-bold text-[var(--color-brand)]">3</span>
                  <div>
                    <strong className="mb-0.5 block text-[0.84rem] leading-[1.3]">Pick engines</strong>
                    <p className="m-0 text-[0.78rem] leading-[1.5] text-[var(--color-fg-muted)]">Choose TTS / ASR / LLM backends. Defaults work out of the box.</p>
                  </div>
                </div>
              </div>
              <p className="m-0 text-center text-[0.74rem] leading-[1.5] text-[var(--color-fg-subtle)]">
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
        </>
      )}

      {/* 1. System check */}
      {step === 1 && (
        <>
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
        </>
      )}

      {/* 2. Models */}
      {step === 2 && (
        <>
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
        </>
      )}

      {/* 3. Engines */}
      {step === 3 && (
        <>
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
        </>
      )}

      {!status && step > 1 && (
        <div className="swiz-status-loading">
          <Loader className="spinner" size={14} /> Checking setup…
        </div>
      )}

      <p className="setup-wizard__footnote">
        Downloads come from <code>huggingface.co</code>. Cache:{' '}
        <code>{status?.hf_cache_dir || '~/.cache/huggingface'}</code>
      </p>
    </div>
  );
}
