/**
 * First-run bootstrap splash.
 *
 * The Rust side spawns the venv setup (uv install + `uv sync --frozen`) in a
 * background thread and publishes progress via the `bootstrap_status` Tauri
 * command. This component polls that command every 1 s and renders the
 * current stage until the backend is healthy (stage === 'ready'), then
 * unmounts and lets the main UI take over.
 */
import { useEffect, useState } from 'react';
import './BootstrapSplash.css';

const STAGE_LABEL = {
  checking:          'Checking environment…',
  downloading_uv:    'Downloading uv (Python package manager)…',
  creating_venv:     'Creating Python virtual environment…',
  installing_deps:   'Installing dependencies — this is a one-time setup (5-10 min on first run).',
  starting_backend:  'Starting backend…',
  ready:             'Ready',
  failed:            'Setup failed',
};

const STEPS = ['checking', 'downloading_uv', 'creating_venv', 'installing_deps', 'starting_backend'];

export function BootstrapSplash({ stage, message }) {
  const label = STAGE_LABEL[stage] || stage;
  const stepIndex = Math.max(0, STEPS.indexOf(stage));
  const isFailed = stage === 'failed';

  return (
    <div className="bootstrap-splash">
      <div className="bootstrap-splash__card">
        <h1>OmniVoice Studio</h1>
        <p className="bootstrap-splash__status">{label}</p>
        {isFailed ? (
          <pre className="bootstrap-splash__error">{message || 'Unknown error'}</pre>
        ) : (
          <>
            <div className="bootstrap-splash__bar">
              <div
                className="bootstrap-splash__bar-fill"
                style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
              />
            </div>
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
