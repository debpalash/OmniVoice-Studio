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

/**
 * The honest error for an SSE/stream that died with NO terminal event (#1062).
 *
 * Every long-running stream the backend serves is contract-bound to emit a
 * terminal event before it closes — even on failure (tests/test_dub_transcribe.py
 * ::test_transcribe_stream_never_closes_without_terminal_event). So a stream that
 * simply goes silent did NOT "probably fail to load a model": the backend
 * PROCESS went away underneath it. On smaller GPUs the usual trigger is running
 * out of VRAM while loading the ASR model on top of a resident TTS model, which
 * aborts the process natively rather than raising a catchable Python error.
 *
 * When the desktop shell recorded a crash marker (#941), say what actually
 * happened — exit code, how long ago, and the VRAM next step — and raise the
 * crash notice so "View crash details" is one click away. With no marker (or
 * outside the Tauri shell) the caller's own message stands.
 *
 * `getCrash` is an injectable seam (same idea as services/endpoint_race's
 * injectable probers) so the branch logic is unit-testable without a shell.
 */
export async function streamDropError(
  fallbackMessage: string,
  getCrash: () => Promise<BackendCrashMarker | null> = getUnacknowledgedBackendCrash,
  opts: { waitMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Error> {
  // #1119: the shell learns the backend died from a ~2 s POLL — it must notice
  // the child exit and write the crash marker. Asking for that marker ONCE, at
  // the instant the stream drops, races that poll and loses: we found nothing
  // and fell back to the guess ("Likely ASR backend failed to load") even when
  // the backend had in fact just died. That's the same race #1102 fixed for
  // apiFetch, which this path never got. Give the shell time to catch up before
  // believing there was no crash.
  const waitMs = opts.waitMs ?? 8_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let crash: BackendCrashMarker | null = null;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      crash = await getCrash();
    } catch {
      return new Error(fallbackMessage); // forensics unavailable — don't mask the caller
    }
    if (crash) break;
    // Outside the Tauri shell there is no marker to wait for, ever — don't
    // stall a browser/Docker user for 8 s to learn nothing.
    if (!inTauri()) break;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  if (!crash) return new Error(fallbackMessage);
  try {
    window.dispatchEvent(new CustomEvent('ov:backend-crashed', { detail: crash }));
  } catch {
    /* no window (tests) — the Error below still tells the story */
  }
  return new Error(
    `The local OmniVoice backend crashed (${describeCrashExit(crash)}) ${crashAge(crash)} ago, ` +
      'which dropped this stream — it is being restarted automatically. Open the crash notice for ' +
      'the error output. On smaller GPUs the usual cause is running out of VRAM while loading the ' +
      'ASR model on top of the TTS model: flush the TTS model first, or pick a smaller ASR model ' +
      'in Settings → Models.',
  );
}
