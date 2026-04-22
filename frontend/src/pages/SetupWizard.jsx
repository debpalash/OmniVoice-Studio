import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Loader, Sparkles, ArrowRight, AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
import { Button } from '../ui';
import { setupStatus, preflight } from '../api/setup';
import { ModelStoreTab, EnginesTab } from './Settings';
import './SetupWizard.css';

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
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', padding: 20, color: 'var(--color-fg-muted)' }}>
        <Loader className="spinner" size={14} /> Probing system…
      </div>
    );
  }
  if (!report) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {report.checks.map((c) => (
        <div key={c.id} className="setup-wizard__row" style={{ alignItems: 'flex-start', padding: '6px 2px' }}>
          <span style={{ flexShrink: 0, paddingTop: 2 }}>{CHECK_ICON[c.status] || null}</span>
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
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
  const [status, setStatus] = useState(null);
  const [pre, setPre] = useState(null);
  const [preLoading, setPreLoading] = useState(false);

  const reload = useCallback(async () => {
    try { setStatus(await setupStatus()); }
    catch { /* backend warming up — retry on interval */ }
  }, []);

  const recheckPreflight = useCallback(async () => {
    setPreLoading(true);
    try { setPre(await preflight()); }
    catch { /* backend not ready */ }
    finally { setPreLoading(false); }
  }, []);

  useEffect(() => { reload(); recheckPreflight(); }, [reload, recheckPreflight]);

  // Poll while on the Models step so the Finish button unlocks as soon as
  // downloads complete, without the user having to click "Recheck".
  useEffect(() => {
    if (step !== 2) return;
    const iv = setInterval(reload, 4000);
    return () => clearInterval(iv);
  }, [step, reload]);

  const modelsReady = !!status?.models_ready;
  const preflightOk = !!pre?.ok;

  return (
    <div className="setup-wizard">
      <div
        data-tauri-drag-region
        onDoubleClick={doubleClickMaximize}
        className="setup-wizard__hero"
      >
        <Sparkles size={36} color="#d3869b" />
        <h1 data-tauri-drag-region>Welcome to OmniVoice Studio</h1>
        <p className="setup-wizard__sub" data-tauri-drag-region>
          Dubbing, voice cloning, and voice design — all running locally on
          your machine. Four quick steps and you're in.
        </p>
      </div>

      <div className="setup-wizard__steps">
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
          >
            {step > i ? '✓ ' : `${i + 1}. `}{label}
          </button>
        ))}
      </div>

      {/* 0. Welcome */}
      {step === 0 && (
        <div className="setup-wizard__embed" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <strong>What happens next</strong>
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7, color: 'var(--color-fg-muted)', fontSize: '0.9rem' }}>
            <li>
              <strong>System check</strong> — we'll probe RAM, disk, GPU driver
              compatibility, ffmpeg, and network. Any blockers flagged upfront so
              nothing fails silently later.
            </li>
            <li>
              <strong>Install models</strong> — we'll download ~5 GB of weights
              (OmniVoice TTS + Whisper). Required ones first; optional engines
              you can enable now or later.
            </li>
            <li>
              <strong>Pick engines</strong> — choose which TTS / ASR / LLM
              backends to use. Defaults work; power users can pin specific
              engines per family.
            </li>
            <li>
              <strong>You're in.</strong> First launch takes ~5-10 minutes to
              download. After that, every launch is instant and fully offline.
            </li>
          </ol>
          <div>
            <Button
              variant="primary" size="lg"
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
          {!modelsReady && status?.missing?.length > 0 && (
            <p className="setup-wizard__muted" style={{ textAlign: 'center', fontSize: '0.78rem', margin: 0 }}>
              Still needed:{' '}
              {status.missing.map(m => m.label).join(', ')}
            </p>
          )}
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: 'var(--color-fg-muted)' }}>
          <Loader className="spinner" size={14} /> Checking setup…
        </div>
      )}

      <p className="setup-wizard__footnote">
        Downloads come from <code>huggingface.co</code>. Cache: {' '}
        <code>{status?.hf_cache_dir || '~/.cache/huggingface'}</code>
      </p>
    </div>
  );
}
