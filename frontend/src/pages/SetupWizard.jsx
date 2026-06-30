import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader } from 'lucide-react';
import { useSetupStatus, usePreflight } from '../api/hooks';
import WizardLibrary from '../components/WizardLibrary';
import HfTokenCard from '../components/HfTokenCard';
import DictationDemo from '../components/DictationDemo';
import '../components/FirstRunSetup.css';
import './SetupWizard.css';
import '../components/Misc.css';

// macOS convention: double-click the title-bar drag region to toggle zoom.
const doubleClickMaximize = async () => {
  try {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().toggleMaximize();
  } catch {
    /* non-tauri preview — ignore */
  }
};

/** Shorten an absolute path for display: /Users/foo/.cache/x → ~/.cache/x */
function shortenPath(p) {
  if (!p) return '~/.cache/huggingface';
  try {
    const home = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)/)?.[0];
    if (home) return p.replace(home, '~');
  } catch {
    /* fallthrough */
  }
  return p;
}

/** Open a path in the OS file manager (Tauri only, no-op on web). */
async function revealPath(path) {
  try {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
  } catch {
    /* ignore — probably web preview */
  }
}

/** Whisper waveform — the journey's signature, same as setup + install. */
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

/* ── Preflight panel — LED check rows ──────────────────────────────────── */

function PreflightPanel({ report, loading, onRecheck }) {
  const { t } = useTranslation();
  if (loading && !report) {
    return (
      <div className="swiz-loading">
        <Loader className="spinner" size={14} /> {t('setup.probing')}
      </div>
    );
  }
  if (!report) return null;
  return (
    <section className="frs-panel">
      <h2 className="frs-panel__title">
        {t('setup.system_preflight')}
        <button type="button" className="frs-btn frs-btn--quiet swiz-recheck" onClick={onRecheck}>
          ↻ {t('setup.recheck')}
        </button>
      </h2>
      <div className="swiz-checks">
        {report.checks.map((c) => (
          <div key={c.id} className={`frs-check frs-check--${c.status}`}>
            <span className="frs-check__led" aria-hidden="true" />
            <div className="frs-check__body">
              <span className="frs-check__title">{c.label}</span>
              <span className="frs-check__detail" title={c.detail}>
                {c.detail}
              </span>
              {c.fix && c.status !== 'pass' && <span className="frs-check__fix">→ {c.fix}</span>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── LED stepper rail ──────────────────────────────────────────────────── */

function StepperNav({ step, maxUnlockedStep, onStep }) {
  const { t } = useTranslation();
  // Three steps, no welcome ceremony: the journey rail + setup page already
  // oriented the user. Models + engines share one act (required gate +
  // optional extras).
  const stepLabels = [
    t('setup.system_check'),
    t('firstrun.stage_models', 'Models & engines'),
    t('setup.try_dictation'),
  ];
  return (
    <nav className="frs-wsteps" data-tauri-drag-region>
      {stepLabels.map((label, i) => (
        <button
          key={label}
          type="button"
          className={['frs-wstep', step === i ? 'is-active' : '', step > i ? 'is-done' : '']
            .filter(Boolean)
            .join(' ')}
          // The rail mirrors the continue buttons' gates: jumping past an
          // unmet gate (preflight, required models) would let "Enter studio"
          // clear setupNeeded without the checks ever passing.
          disabled={i > maxUnlockedStep}
          onClick={() => i <= maxUnlockedStep && onStep(i)}
          aria-current={step === i ? 'step' : undefined}
          aria-label={
            t('setup.step_aria', { num: i + 1, label, defaultValue: 'Step {{num}}: {{label}}' }) +
            (step > i ? ` (${t('setup.step_completed', 'completed')})` : '')
          }
        >
          <span className="frs-wstep__led" aria-hidden="true" />
          {label}
        </button>
      ))}
    </nav>
  );
}

/* ── Main wizard component ─────────────────────────────────────────────── */

/**
 * First-run / "no models installed" gate — the final act of the first-run
 * journey (setup → install → models/engines). Rendered in the same studio
 * console design system (frs-*) so the handoff from the install splash is
 * seamless.
 *
 * Flow:
 *   0. Welcome           — what's left to do
 *   1. System            — /setup/preflight results
 *   2. Models & engines  — ModelStoreTab (required, gates continue) +
 *                          EnginesTab (optional) in one act
 *   3. Dictation         — guided demo, then "Enter studio"
 */
export default function SetupWizard({ onReady }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);

  // TanStack Query — shared cache, auto-refetch on step 2 (models)
  const setupQuery = useSetupStatus();
  const preQuery = usePreflight();
  const status = setupQuery.data ?? null;
  const pre = preQuery.data ?? null;
  const preLoading = preQuery.isLoading;

  // Poll setup status every 4s while on Models step
  useEffect(() => {
    if (step !== 1) return;
    const iv = setInterval(() => setupQuery.refetch(), 4000);
    return () => clearInterval(iv);
  }, [step, setupQuery]);

  const recheckPreflight = useCallback(() => {
    preQuery.refetch();
  }, [preQuery]);

  const modelsReady = !!status?.models_ready;
  const preflightOk = !!pre?.ok;

  const cachePath = status?.hf_cache_dir || '~/.cache/huggingface';

  const STEP_SUBTITLES = [
    t('setup.system_check_desc'),
    t('setup.install_models_desc'),
    t('setup.try_dictation'),
  ];

  return (
    <div className="frs swiz">
      <div className="frs__atmo" aria-hidden="true" />
      <div className="frs__deck">
        {/* ── Masthead: identical identity to setup + install acts ──────── */}
        <header
          className="frs__mast frs-rise"
          style={{ '--rise': 0 }}
          data-tauri-drag-region
          onDoubleClick={doubleClickMaximize}
        >
          <Waveform />
          <div className="frs__mast-row">
            <div className="frs__mast-text">
              <h1 className="frs__title" data-tauri-drag-region>
                OmniVoice Studio
              </h1>
              <p className="frs__subtitle" data-tauri-drag-region>
                {STEP_SUBTITLES[step]}
              </p>
            </div>
            <div className="frs__mast-meta">
              <StepperNav
                step={step}
                maxUnlockedStep={preflightOk ? (modelsReady ? 2 : 1) : 0}
                onStep={setStep}
              />
            </div>
          </div>
        </header>

        {/* 0. System check — first thing a user sees: the probe auto-runs,
            no welcome ceremony (the journey rail + setup page already
            oriented them). */}
        {step === 0 && (
          <div className="swiz-slide" key="step-0">
            <div className="frs-rise" style={{ '--rise': 1 }}>
              <PreflightPanel report={pre} loading={preLoading} onRecheck={recheckPreflight} />
            </div>
            <div className="frs-wnav frs-rise" style={{ '--rise': 2 }}>
              <span />
              <button
                type="button"
                className={`frs-btn frs-btn--primary ${preflightOk ? 'is-armed' : ''}`}
                onClick={() => setStep(1)}
                disabled={!preflightOk}
                title={preflightOk ? '' : t('setup.resolve_blockers')}
              >
                <span className="frs-btn__led" aria-hidden="true" />
                {preflightOk
                  ? pre?.has_warnings
                    ? t('setup.continue_warn')
                    : t('setup.continue_ok')
                  : t('setup.continue_blocked')}
              </button>
            </div>
          </div>
        )}

        {/* 1. Models & engines — ONE unified list: every installable is a
            row of the same grammar (LED · name · chip · size · action).
            Required models gate continue; engines and the optional tail
            ride in the same inventory. */}
        {step === 1 && (
          <div className="swiz-slide" key="step-1">
            <section className="frs-panel frs-rise" style={{ '--rise': 1 }}>
              <h2 className="frs-panel__title">{t('firstrun.stage_models', 'Models & engines')}</h2>
              <WizardLibrary />
              {!modelsReady && status?.missing?.length > 0 && (
                <p className="swiz-note swiz-note--warn">
                  {t('setup.still_needed')} {status.missing.map((m) => m.label).join(', ')}
                </p>
              )}
            </section>
            {/* Pinned next to Continue (not buried at the bottom of the
                scrolling model list) so it's visible without scrolling — you
                can see it and drop in a token right by the action. */}
            <HfTokenCard className="swiz-hfpin" />
            <div className="frs-wnav frs-rise" style={{ '--rise': 2 }}>
              <button type="button" className="frs-btn frs-btn--quiet" onClick={() => setStep(0)}>
                ← {t('setup.back')}
              </button>
              <button
                type="button"
                className={`frs-btn frs-btn--primary ${modelsReady ? 'is-armed' : ''}`}
                onClick={() => setStep(2)}
                disabled={!modelsReady}
                title={modelsReady ? '' : t('setup.install_required_models')}
              >
                <span className="frs-btn__led" aria-hidden="true" />
                {modelsReady ? t('setup.models_ready') : t('setup.waiting_models')}
              </button>
            </div>
          </div>
        )}

        {/* 2. Dictation — guided walkthrough. Skippable (per cross-platform
            parity rule: some users genuinely don't want dictation). */}
        {step === 2 && (
          <div className="swiz-slide" key="step-2">
            <section className="frs-panel frs-rise" style={{ '--rise': 1 }}>
              <h2 className="frs-panel__title">{t('setup.try_dictation')}</h2>
              <div className="frs-embed">
                <DictationDemo />
              </div>
            </section>
            <div className="frs-wnav frs-rise" style={{ '--rise': 2 }}>
              <button type="button" className="frs-btn frs-btn--quiet" onClick={() => setStep(1)}>
                ← {t('setup.back')}
              </button>
              <div className="frs-wnav__group">
                <button type="button" className="frs-btn frs-btn--quiet" onClick={onReady}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="frs-btn frs-btn--primary is-armed"
                  onClick={onReady}
                >
                  <span className="frs-btn__led" aria-hidden="true" />
                  {t('setup.enter_studio')}
                </button>
              </div>
            </div>
          </div>
        )}

        {!status && step > 0 && (
          <div className="swiz-loading">
            <Loader className="spinner" size={14} /> {t('setup.checking')}
          </div>
        )}

        <footer className="frs__foot">
          <div className="frs__foot-row">
            <span className="frs__totals">
              {t('setup.footer_downloads')}
              <span className="frs__totals-sep" aria-hidden="true">
                ·
              </span>
              {t('setup.cache_label', 'Model cache')} <code>{shortenPath(cachePath)}</code>
              {'__TAURI_INTERNALS__' in window && cachePath && (
                <button
                  type="button"
                  className="frs-btn frs-btn--quiet"
                  onClick={() => revealPath(cachePath)}
                  title={t('setup.open_finder')}
                >
                  {t('setup.open')}
                </button>
              )}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
