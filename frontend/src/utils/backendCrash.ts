/**
 * backendCrash — frontend bridge to the desktop shell's crash forensics
 * (#941, src-tauri/src/crash.rs).
 *
 * When the backend PROCESS dies (native CUDA abort, OOM kill, DLL crash) the
 * Rust death watcher persists a crash marker (exit code/signal + stderr tail).
 * This module reads it so:
 *   - api/client.ts can replace the vague "Can't reach the local backend"
 *     with the honest story,
 *   - components/BackendCrashNotice.jsx can offer "View crash details",
 *   - utils/bugReport.js can attach the evidence to the GitHub-issue prefill.
 *
 * Outside the Tauri shell (browser dev, Docker, LAN share) every getter
 * resolves to null — there is no local process to forensicate.
 */

export interface BackendCrashMarker {
  /** Unix seconds when the death was detected. */
  ts: number;
  exit_code: number | null;
  signal: number | null;
  /** Human-readable ExitStatus display ("exit status: 134", …). */
  exit_desc: string;
  backend_version: string;
  /** Seconds the backend had been running when it died. */
  uptime_s: number;
  /** Tail of backend_err.log captured at death time (~40 lines). */
  last_stderr: string;
  /** Whether the user already viewed/dismissed this crash. */
  acknowledged: boolean;
}

function inTauri(): boolean {
  const w = window as unknown as Record<string, unknown> | undefined;
  return typeof window !== 'undefined' && !!(w?.__TAURI__ || w?.__TAURI_INTERNALS__);
}

/** Newest crash marker the shell knows about, or null (also null outside Tauri). */
export async function getLastBackendCrash(): Promise<BackendCrashMarker | null> {
  if (!inTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return ((await invoke('get_last_backend_crash')) as BackendCrashMarker | null) ?? null;
  } catch {
    return null;
  }
}

/** Newest crash marker only if the user hasn't acknowledged it yet. */
export async function getUnacknowledgedBackendCrash(): Promise<BackendCrashMarker | null> {
  const marker = await getLastBackendCrash();
  return marker && !marker.acknowledged ? marker : null;
}

/** Mark the newest crash as seen (the marker itself is retained for reports). */
export async function acknowledgeBackendCrash(): Promise<void> {
  if (!inTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('acknowledge_backend_crash');
  } catch {
    /* shell unavailable — nothing to acknowledge */
  }
}

/** "exit code 3221226505" / "signal 6" / the raw ExitStatus display. */
export function describeCrashExit(
  marker: Pick<BackendCrashMarker, 'exit_code' | 'signal' | 'exit_desc'>,
): string {
  if (marker.exit_code != null) return `exit code ${marker.exit_code}`;
  if (marker.signal != null) return `signal ${marker.signal}`;
  return marker.exit_desc || 'unknown exit';
}

/** Coarse "12 s" / "3 min" / "2 h" age of a marker, for the honest message. */
export function crashAge(marker: Pick<BackendCrashMarker, 'ts'>, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - marker.ts));
  if (s < 90) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}
