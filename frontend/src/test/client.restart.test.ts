import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiFetch } from '../api/client';
import { backendLifecycleStage, classifyBootstrapStage } from '../utils/backendLifecycle';

// The recurring "Can't reach the local OmniVoice backend" class: a REAL
// backend start/restart takes 10–20+ s (venv spawn + torch import), but the
// transport cascade used to give up after ~2.9 s — every request landing in a
// restart window dead-ended with the scary toast. apiFetch must now keep
// retrying exactly as long as the desktop shell says the backend is starting,
// and still fail promptly when the shell says failed / is absent.
vi.mock('../utils/backendLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/backendLifecycle')>();
  return {
    ...actual,
    backendLifecycleStage: vi.fn().mockResolvedValue('unknown'),
  };
});

const stageMock = vi.mocked(backendLifecycleStage);
const CASCADE_MS = 400 + 900 + 1600;

describe('apiFetch — lifecycle-aware restart wait', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stageMock.mockReset();
    stageMock.mockResolvedValue('unknown');
  });

  it('keeps retrying while the shell says the backend is starting, then succeeds', async () => {
    vi.useFakeTimers();
    // 5 transport failures (cascade of 3 + 2 lifecycle-waited attempts), then OK.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    stageMock.mockResolvedValue('starting');

    const p = apiFetch('/model/status');
    const assertion = expect(p).resolves.toMatchObject({ status: 200 });
    await vi.advanceTimersByTimeAsync(CASCADE_MS + 1500 * 2 + 100);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(stageMock).toHaveBeenCalled();
  });

  it('fails promptly when the shell says the backend start failed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    stageMock.mockResolvedValue('failed');

    const p = apiFetch('/model/status');
    const assertion = expect(p).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("Can't reach the local OmniVoice backend"),
    });
    await vi.advanceTimersByTimeAsync(CASCADE_MS + 100);
    await assertion;
  });

  // #1101 — the hole in the original fix, reported against 0.3.19. The shell's
  // stage is a 2 s POLL: when the backend dies mid-generate the supervisor needs
  // a moment to notice, flip to "starting" and write the crash marker. Asking
  // once at the end of the cascade still saw `ready`, so the request dead-ended
  // on the generic toast anyway. A transport failure contradicts `ready`, so we
  // must keep retrying long enough for the shell to catch up.
  it('does NOT believe a stale "ready" — it waits for the shell to notice the death', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    // The supervisor hasn't ticked yet: still 'ready' for the first few polls,
    // then it notices the death and flips to 'starting'.
    stageMock
      .mockResolvedValueOnce('ready')
      .mockResolvedValueOnce('ready')
      .mockResolvedValue('starting');

    const p = apiFetch('/generate');
    // Never settles into the generic error — it keeps waiting.
    const settled = vi.fn();
    p.then(settled, settled);
    await vi.advanceTimersByTimeAsync(CASCADE_MS + 1000 + 1000 + 1500);
    expect(settled).not.toHaveBeenCalled();

    // Once the backend comes back, the request succeeds — the toast never fired.
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    await vi.advanceTimersByTimeAsync(1500 * 2);
    await expect(p).resolves.toMatchObject({ status: 200 });
  });

  it('still gives up when a "ready" backend stays unreachable past the reconcile window', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    stageMock.mockResolvedValue('ready'); // shell insists it's fine; it never recovers

    const p = apiFetch('/model/status');
    const assertion = expect(p).rejects.toMatchObject({ status: 0 });
    await vi.advanceTimersByTimeAsync(CASCADE_MS + 12_000 + 2000);
    await assertion;
  });

  it('keeps the old prompt failure outside the Tauri shell (stage unknown)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    stageMock.mockResolvedValue('unknown');

    const p = apiFetch('/model/status');
    const assertion = expect(p).rejects.toMatchObject({ status: 0 });
    await vi.advanceTimersByTimeAsync(CASCADE_MS + 100);
    await assertion;
    // Exactly the short cascade — no lifecycle-extended retries.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('classifyBootstrapStage', () => {
  it('maps shell stages to the coarse lifecycle answer', () => {
    expect(classifyBootstrapStage('ready')).toBe('ready');
    expect(classifyBootstrapStage('failed')).toBe('failed');
    for (const s of [
      'checking',
      'awaiting_setup',
      'downloading_uv',
      'creating_venv',
      'installing_deps',
      'starting_backend',
    ]) {
      expect(classifyBootstrapStage(s)).toBe('starting');
    }
    expect(classifyBootstrapStage('')).toBe('unknown');
    expect(classifyBootstrapStage(null)).toBe('unknown');
    expect(classifyBootstrapStage(undefined)).toBe('unknown');
  });
});
