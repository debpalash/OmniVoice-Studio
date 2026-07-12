import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamDropError } from '../utils/backendCrash';

// #1062: a dub transcribe stream that closed with NO terminal event surfaced
// "Likely ASR backend failed to load" — a GUESS. The backend is contract-bound
// to emit a terminal event on every stream (test_transcribe_stream_never_closes
// _without_terminal_event), so a silent drop means the backend PROCESS died —
// on small-VRAM GPUs, a native OOM abort while loading ASR. When the shell
// recorded a crash marker (#941), the error must tell that story instead.

const FALLBACK = 'Transcribe stream dropped before emitting any segments.';

function marker(overrides = {}) {
  return {
    ts: Math.floor(Date.now() / 1000) - 12,
    exit_code: null,
    signal: 6,
    exit_desc: 'signal: 6',
    backend_version: '0.3.19',
    uptime_s: 90,
    last_stderr: 'RuntimeError: CUDA out of memory',
    acknowledged: false,
    ...overrides,
  };
}

describe('streamDropError (#1062)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tells the honest crash story (not a guess) when a crash marker exists', async () => {
    const events: unknown[] = [];
    const onCrash = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('ov:backend-crashed', onCrash);

    const err = await streamDropError(FALLBACK, async () => marker() as never);

    expect(err.message).toContain('backend crashed');
    expect(err.message).toContain('signal 6');
    // Names the real next step for the common cause, instead of "check the log".
    expect(err.message).toMatch(/VRAM/i);
    expect(err.message).not.toContain(FALLBACK);
    // Raises the crash notice so "View crash details" is one click away.
    expect(events).toHaveLength(1);
    window.removeEventListener('ov:backend-crashed', onCrash);
  });

  it('keeps the caller message when there is no crash marker', async () => {
    const err = await streamDropError(FALLBACK, async () => null);
    expect(err.message).toBe(FALLBACK);
  });

  it('never masks the caller message when the forensics lookup itself fails', async () => {
    const err = await streamDropError(FALLBACK, async () => {
      throw new Error('no shell');
    });
    expect(err.message).toBe(FALLBACK);
  });
});

// #1119 — reported on v0.3.21, which already HAD the #1098 fix. The user still
// got the guess ("Likely ASR backend failed to load") because streamDropError
// asked for the crash marker ONCE, instantly, at the moment the stream dropped —
// racing the shell's ~2 s detect-and-write and losing. Same race #1102 fixed for
// apiFetch; this path never got it.
describe('streamDropError — waits for the shell to notice the death (#1119)', () => {
  it('finds a marker that arrives LATE instead of falling back to the guess', async () => {
    let calls = 0;
    const getCrash = async () => {
      calls += 1;
      // The supervisor hasn't noticed yet on the first two polls.
      return calls < 3 ? null : (marker() as never);
    };
    // Force the Tauri path so the wait loop engages, and make sleep instant.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const err = await streamDropError(FALLBACK, getCrash, {
        waitMs: 8000,
        intervalMs: 1,
        sleep: async () => {},
      });
      expect(err.message).toContain('backend crashed');
      expect(err.message).not.toContain(FALLBACK);
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it('still gives up and uses the caller message when no crash ever appears', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const err = await streamDropError(FALLBACK, async () => null, {
        waitMs: 5,
        intervalMs: 1,
        sleep: async () => {},
      });
      expect(err.message).toBe(FALLBACK);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it('does not stall a browser/Docker user — no shell means no marker, ever', async () => {
    let calls = 0;
    const err = await streamDropError(FALLBACK, async () => {
      calls += 1;
      return null;
    });
    expect(err.message).toBe(FALLBACK);
    expect(calls).toBe(1); // asked once, then stopped — no 8 s wait
  });
});
