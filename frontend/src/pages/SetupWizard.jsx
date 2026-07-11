import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSetupStatus, usePreflight } from '../api/hooks';
import { apiJson, apiFetch } from '../api/client';
import WizardLibrary from '../components/WizardLibrary';
import MediaEngineCard from '../components/MediaEngineCard';
import HfTokenCard from '../components/HfTokenCard';
import DictationDemo from '../components/DictationDemo';
import { Button } from '../ui';

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

const CHECK_LED = {
  pass: 'bg-success shadow-[0_0_5px_1px_color-mix(in_srgb,var(--color-success)_50%,transparent)]',
  warn: 'bg-warn shadow-[0_0_5px_1px_color-mix(in_srgb,var(--color-warn)_50%,transparent)]',
  fail: 'bg-danger shadow-[0_0_5px_1px_color-mix(in_srgb,var(--color-danger)_50%,transparent)]',
};

/* ── Preflight panel — LED check rows ──────────────────────────────────── */

function PreflightPanel({ report, loading, onRecheck }) {
  const { t } = useTranslation();
  if (loading && !report) {
    return (
      <div className="flex items-center gap-2 py-1 text-sm text-fg-muted">
        <Loader className="animate-spin" size={14} /> {t('setup.probing')}
      </div>
    );
  }
  if (!report) return null;
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="m-0 flex items-center gap-2 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-fg-muted">
        <span>{t('setup.system_preflight')}</span>
        <span
          className="h-px flex-1 bg-gradient-to-r from-border-strong to-transparent"
          aria-hidden="true"
        />
        <Button variant="ghost" size="sm" onClick={onRecheck} leading={<RotateCw size={12} />}>
          {t('setup.recheck')}
        </Button>
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-x-6 gap-y-2">
        {report.checks.map((c) => (
          <div key={c.id} className="flex items-start gap-2 rounded-md px-2.5 py-2">
            <span
              className={cn(
                'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                CHECK_LED[c.status] || 'bg-fg-subtle/40',
              )}
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-semibold">{c.label}</span>
              <span className="truncate text-xs text-fg-muted" dir="rtl" title={c.detail}>
                {c.detail}
              </span>
              {c.fix && c.status !== 'pass' && (
                <span
                  className={cn(
                    'text-xs leading-snug',
                    c.status === 'fail' ? 'text-danger' : 'text-warn',
                  )}
                >
                  → {c.fix}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Mirror rescue — restricted-network escape hatch on step 0 ─────────── */

/**
 * Shown when the network preflight check can't reach the Hugging Face
 * endpoint. Users behind restricted networks (e.g. China, where
 * huggingface.co is blocked) can't reach Settings yet — the wizard gates the
 * studio — so the mirror quick-pick has to live right here. PUT /hf-mirror
 * takes effect immediately for downloads (no restart during setup).
 */
function MirrorRescue({ onApplied }) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState([]);
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    apiJson('/api/settings/hf-mirror')
      .then((d) => {
        if (!alive) return;
        setPresets((d?.presets || []).filter((p) => p.url));
        setUrl(d?.configured || '');
      })
      .catch(() => {
        /* endpoint unavailable — keep the free-text input usable */
      });
    return () => {
      alive = false;
    };
  }, []);

  const apply = async (value) => {
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/settings/hf-mirror', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value }),
      });
      setUrl(value);
      onApplied();
    } catch (e) {
      setError(e?.message || t('setup.mirror_apply_error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5">
      <span className="text-sm font-semibold">{t('setup.mirror_rescue_title')}</span>
      <span className="text-xs leading-snug text-fg-muted">{t('setup.mirror_rescue_hint')}</span>
      {error && (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <Button
            key={p.url}
            variant="preset"
            size="sm"
            disabled={saving}
            onClick={() => apply(p.url)}
            data-testid={`wizard-mirror-${p.url}`}
          >
            {p.label}
          </Button>
        ))}
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hf-mirror.com"
          className="min-w-[220px] flex-1 rounded border border-border bg-transparent px-2 py-1 font-mono text-xs text-fg"
          data-testid="wizard-mirror-url"
        />
        <Button
          variant="subtle"
          size="sm"
          loading={saving}
          disabled={saving || !url.trim()}
          onClick={() => apply(url.trim())}
          data-testid="wizard-mirror-apply"
        >
          {t('setup.mirror_apply')}
        </Button>
      </div>
    </div>
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
    <nav className="flex flex-wrap items-center gap-x-4 gap-y-2" data-tauri-drag-region>
      {stepLabels.map((label, i) => {
        const isActive = step === i;
        const isDone = step > i;
        const locked = i > maxUnlockedStep;
        return (
          <button
            key={label}
            type="button"
            // The rail mirrors the continue buttons' gates: jumping past an
            // unmet gate (preflight, required models) would let "Enter studio"
            // clear setupNeeded without the checks ever passing.
            disabled={locked}
            onClick={() => !locked && onStep(i)}
            aria-current={isActive ? 'step' : undefined}
            aria-label={
              t('setup.step_aria', { num: i + 1, label, defaultValue: 'Step {{num}}: {{label}}' }) +
              (isDone ? ` (${t('setup.step_completed', 'completed')})` : '')
            }
            className={cn(
              'inline-flex appearance-none items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.14em] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              locked && 'cursor-not-allowed',
              isActive ? 'text-fg' : isDone ? 'text-fg-muted hover:text-fg' : 'text-fg-subtle/60',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                isActive
                  ? 'bg-primary shadow-[0_0_6px_1px_var(--color-brand-glow)]'
                  : isDone
                    ? 'bg-success'
                    : 'bg-fg-subtle/40',
              )}
              aria-hidden="true"
            />
            {label}
          </button>
        );
      })}
    </nav>
  );
}

/** Section heading with engraved label + rule. */
function SectionHead({ children }) {
  return (
    <h2 className="m-0 flex items-center gap-2 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-fg-muted">
      <span>{children}</span>
      <span
        className="h-px flex-1 bg-gradient-to-r from-border-strong to-transparent"
        aria-hidden="true"
      />
    </h2>
  );
}

/* ── Main wizard component ─────────────────────────────────────────────── */

/**
 * First-run / "no models installed" gate — the final act of the first-run
 * journey (setup → install → models/engines). Rendered in the same shadcn
 * design system as the install splash so the handoff is seamless.
 *
 * Flow:
 *   0. System            — /setup/preflight results
 *   1. Models & engines  — required models (gates continue) + engines +
 *                          the optional tail in one act
 *   2. Dictation         — guided demo, then "Enter studio"
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
  // Offer the mirror quick-pick whenever the HF endpoint probe didn't pass —
  // the wizard is the only surface these users can reach (Settings is gated
  // behind setup), so the escape hatch must live here.
  const networkDown = (pre?.checks || []).some((c) => c.id === 'network' && c.status !== 'pass');

  const cachePath = status?.hf_cache_dir || '~/.cache/huggingface';

  const STEP_SUBTITLES = [
    t('setup.system_check_desc'),
    t('setup.install_models_desc'),
    t('setup.try_dictation'),
  ];

  return (
    <div className="fixed inset-0 flex flex-col items-center overflow-hidden bg-bg px-6 pt-12 font-sans text-fg">
      <div className="flex w-full max-w-[1100px] flex-1 flex-col">
        {/* ── Masthead: identical identity to setup + install acts ────────── */}
        <header
          className="fr-rise flex flex-col gap-3 pb-1"
          style={{ '--rise': 0 }}
          data-tauri-drag-region
          onDoubleClick={doubleClickMaximize}
        >
          <Waveform />
          <div className="mt-2 flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              <h1
                className="m-0 font-serif text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight tracking-tight"
                data-tauri-drag-region
              >
                OmniVoice Studio
              </h1>
              <p className="mt-1.5 text-sm leading-snug text-fg-muted" data-tauri-drag-region>
                {STEP_SUBTITLES[step]}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <StepperNav
                step={step}
                maxUnlockedStep={preflightOk ? (modelsReady ? 2 : 1) : 0}
                onStep={setStep}
              />
            </div>
          </div>
        </header>

        {/* 0. System check — first thing a user sees: the probe auto-runs. */}
        {step === 0 && (
          <div className="flex min-h-0 flex-auto flex-col gap-3" key="step-0">
            <div className="fr-rise min-h-0 flex-1 overflow-y-auto" style={{ '--rise': 1 }}>
              <PreflightPanel report={pre} loading={preLoading} onRecheck={recheckPreflight} />
              {/* Invisible when the media engine is ready; a quiet progress
                  line while the backend fetches its own bundled build; an
                  actionable card only on failure. */}
              <MediaEngineCard />
              {networkDown && <MirrorRescue onApplied={recheckPreflight} />}
            </div>
            <div
              className="fr-rise flex shrink-0 items-center justify-between gap-4 border-t border-border pt-3"
              style={{ '--rise': 2 }}
            >
              <span />
              <Button
                variant="primary"
                onClick={() => setStep(1)}
                disabled={!preflightOk}
                title={preflightOk ? '' : t('setup.resolve_blockers')}
              >
                {preflightOk
                  ? pre?.has_warnings
                    ? t('setup.continue_warn')
                    : t('setup.continue_ok')
                  : t('setup.continue_blocked')}
              </Button>
            </div>
          </div>
        )}

        {/* 1. Models & engines — ONE unified list: every installable is a
            row of the same grammar (LED · name · chip · size · action). */}
        {step === 1 && (
          <div className="flex min-h-0 flex-auto flex-col gap-3" key="step-1">
            <section
              className="fr-rise flex min-h-0 flex-1 flex-col gap-2.5"
              style={{ '--rise': 1 }}
            >
              <SectionHead>{t('firstrun.stage_models', 'Models & engines')}</SectionHead>
              <WizardLibrary />
              {!modelsReady && status?.missing?.length > 0 && (
                <p className="m-0 text-xs leading-snug text-warn">
                  {t('setup.still_needed')} {status.missing.map((m) => m.label).join(', ')}
                </p>
              )}
            </section>
            {/* Pinned next to Continue (not buried in the scrolling model list)
                so it's visible without scrolling — drop a token right by the
                action. */}
            <HfTokenCard className="shrink-0" />
            <div
              className="fr-rise flex shrink-0 items-center justify-between gap-4 border-t border-border pt-3"
              style={{ '--rise': 2 }}
            >
              <Button variant="ghost" size="sm" onClick={() => setStep(0)}>
                ← {t('setup.back')}
              </Button>
              <Button
                variant="primary"
                onClick={() => setStep(2)}
                disabled={!modelsReady}
                title={modelsReady ? '' : t('setup.install_required_models')}
              >
                {modelsReady ? t('setup.models_ready') : t('setup.waiting_models')}
              </Button>
            </div>
          </div>
        )}

        {/* 2. Dictation — guided walkthrough. Skippable. */}
        {step === 2 && (
          <div className="flex min-h-0 flex-auto flex-col gap-3" key="step-2">
            <section
              className="fr-rise flex min-h-0 flex-1 flex-col gap-2.5"
              style={{ '--rise': 1 }}
            >
              <SectionHead>{t('setup.try_dictation')}</SectionHead>
              <div className="max-h-[min(58vh,640px)] min-w-0 overflow-y-auto rounded-lg">
                <DictationDemo />
              </div>
            </section>
            <div
              className="fr-rise flex shrink-0 items-center justify-between gap-4 border-t border-border pt-3"
              style={{ '--rise': 2 }}
            >
              <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
                ← {t('setup.back')}
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onReady}>
                  {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={onReady}>
                  {t('setup.enter_studio')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {!status && step > 0 && (
          <div className="flex items-center gap-2 py-1 text-sm text-fg-muted">
            <Loader className="animate-spin" size={14} /> {t('setup.checking')}
          </div>
        )}

        <footer className="shrink-0 py-3">
          <span className="inline-flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            {t('setup.footer_downloads')}
            <span aria-hidden="true">·</span>
            {t('setup.cache_label', 'Model cache')}{' '}
            <code className="font-mono text-fg-subtle">{shortenPath(cachePath)}</code>
            {'__TAURI_INTERNALS__' in window && cachePath && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => revealPath(cachePath)}
                title={t('setup.open_finder')}
              >
                {t('setup.open')}
              </Button>
            )}
          </span>
        </footer>
      </div>
    </div>
  );
}
