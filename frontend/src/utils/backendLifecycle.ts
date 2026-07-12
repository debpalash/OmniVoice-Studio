/**
 * backendLifecycle — frontend bridge to the desktop shell's backend lifecycle
 * (src-tauri/src/bootstrap.rs).
 *
 * The shell always knows whether the backend process is starting, ready,
 * being auto-restarted by the supervisor (#567), or terminally failed — but
 * until this module, api/client.ts guessed: it retried a transport failure
 * for ~2.9 s and then threw "Can't reach the local OmniVoice backend", while
 * a real backend start/restart takes 10–20+ s (venv spawn + torch import).
 * Every request that landed in that window dead-ended with the scary toast,
 * which is why the error "kept coming up" on every restart/cold-start race.
 *
 * `backendLifecycleStage()` asks the shell (`bootstrap_status`) so the client
 * can keep waiting exactly as long as a start/restart is actually in
 * progress, and give up immediately when the shell says failed.
 *
 * Outside the Tauri shell (browser dev, Docker, LAN share) there is no shell
 * to ask — the stage is 'unknown' and callers keep today's short-retry
 * behavior.
 */

export type BackendLifecycleStage = 'ready' | 'starting' | 'failed' | 'unknown';

function inTauri(): boolean {
  const w = window as unknown as Record<string, unknown> | undefined;
  return typeof window !== 'undefined' && !!(w?.__TAURI__ || w?.__TAURI_INTERNALS__);
}

/** Map the shell's BootstrapStage tag to the coarse lifecycle answer the
 * transport layer needs. Pure + exported for unit tests. */
export function classifyBootstrapStage(stage: string | null | undefined): BackendLifecycleStage {
  if (!stage) return 'unknown';
  if (stage === 'ready') return 'ready';
  if (stage === 'failed') return 'failed';
  // checking / awaiting_setup / downloading_uv / creating_venv /
  // installing_deps / starting_backend — the backend is legitimately not
  // listening yet, and the shell is actively working on it.
  return 'starting';
}

/** The shell's current backend stage, or 'unknown' outside Tauri / on IPC
 * failure. Never throws. */
export async function backendLifecycleStage(): Promise<BackendLifecycleStage> {
  if (!inTauri()) return 'unknown';
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const res = (await invoke('bootstrap_status')) as { stage?: string } | null;
    return classifyBootstrapStage(res?.stage);
  } catch {
    return 'unknown';
  }
}
