import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Mock the toast import the component depends on — keeps the test free
// of side-effect side-channels (toast() schedules timers we don't want).
vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Residency layer defaults (/model/loaded) — mocked so tests that don't
// inject apiListLoadedModels never hit the network (apiFetch retries with
// real-timer backoff on a dead transport). Residency tests inject their own.
vi.mock('../api/system', () => ({
  listLoadedModels: vi.fn().mockResolvedValue({ models: [], count: 0 }),
  unloadLoadedModel: vi.fn(),
}));

import EngineCompatibilityMatrix from '../components/EngineCompatibilityMatrix';

/** Build a minimal AllEnginesResponse with the three rows the plan calls for. */
function makeEnginesResponse({ inProcessAvailable = true, inProcessHasLastError = false } = {}) {
  return {
    tts: {
      active: 'omnivoice',
      backends: [
        {
          id: 'omnivoice',
          display_name: 'OmniVoice (test)',
          available: inProcessAvailable,
          reason: inProcessAvailable ? null : 'omnivoice package missing',
          install_hint: 'pip install omnivoice',
          last_error: inProcessHasLastError ? 'previous load failed' : null,
          isolation_mode: 'in-process',
          gpu_compat: ['cuda', 'mps', 'cpu'],
        },
        {
          id: 'kittentts',
          display_name: 'KittenTTS (test)',
          available: false,
          reason: 'kittentts not installed',
          install_hint: 'pip install kittentts',
          last_error: 'auth failed for hf_***REDACTED***',
          isolation_mode: 'in-process',
          gpu_compat: ['cpu'],
        },
        {
          id: 'indextts2',
          display_name: 'IndexTTS2 (test)',
          available: true,
          reason: null,
          install_hint: 'git clone …',
          last_error: null,
          isolation_mode: 'subprocess',
          gpu_compat: ['cuda', 'mps', 'cpu'],
        },
      ],
    },
    asr: { active: 'whisperx', backends: [] },
    llm: { active: 'off', backends: [] },
  };
}

describe('EngineCompatibilityMatrix', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('renders one row per backend with the documented columns', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('OmniVoice (test)')).toBeInTheDocument();
    });
    expect(apiListEngines).toHaveBeenCalledTimes(1);

    // Three engine rows, one per registered backend (the column-header row
    // is role="row" too, so count by the per-engine marker).
    expect(document.querySelectorAll('[data-engine-id]').length).toBe(3);
    expect(screen.getByText('KittenTTS (test)')).toBeInTheDocument();
    expect(screen.getByText('IndexTTS2 (test)')).toBeInTheDocument();
    // The documented columns are announced as column headers.
    expect(screen.getAllByRole('columnheader').map((el) => el.textContent)).toEqual([
      'Engine',
      'Status',
      'GPU compat',
      'Isolation',
      'Actions',
    ]);
  });

  it('shows isolation_mode badge per row (subprocess for IndexTTS, in-process for the others)', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByText('IndexTTS2 (test)'));

    const indexRow = screen.getByText('IndexTTS2 (test)').closest('[role="row"]');
    const omniRow = screen.getByText('OmniVoice (test)').closest('[role="row"]');
    const kittenRow = screen.getByText('KittenTTS (test)').closest('[role="row"]');

    expect(within(indexRow).getByText('subprocess')).toBeInTheDocument();
    expect(within(omniRow).getByText('in-process')).toBeInTheDocument();
    expect(within(kittenRow).getByText('in-process')).toBeInTheDocument();
  });

  it('renders GPU compat chips for each backend', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByText('OmniVoice (test)'));

    const omniRow = screen.getByText('OmniVoice (test)').closest('[role="row"]');
    expect(within(omniRow).getByText('CUDA')).toBeInTheDocument();
    expect(within(omniRow).getByText('MPS')).toBeInTheDocument();
    expect(within(omniRow).getByText('CPU')).toBeInTheDocument();

    const kittenRow = screen.getByText('KittenTTS (test)').closest('[role="row"]');
    // KittenTTS is CPU-only.
    expect(within(kittenRow).getByText('CPU')).toBeInTheDocument();
    expect(within(kittenRow).queryByText('CUDA')).not.toBeInTheDocument();
  });

  it('shows the install reason in the expansion panel when a backend is unavailable', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByText('KittenTTS (test)'));
    const kittenRow = screen.getByText('KittenTTS (test)').closest('[role="row"]');
    // The badge text is exactly "Unavailable" (with a leading icon); the
    // details toggle is "Why unavailable?" — scope to the badge with an
    // exact match so we don't double-count the toggle.
    const badge = within(kittenRow).getByText(
      (_, el) => el?.tagName === 'SPAN' && /^\s*Unavailable\s*$/.test(el.textContent || ''),
    );
    expect(badge).toBeInTheDocument();
    // The failure reason lives in the expansion panel BELOW the row (so the
    // row itself stays two lines tall) — closed by default, open on toggle.
    expect(screen.queryByText('kittentts not installed')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('why-toggle-kittentts'));
    const panel = screen.getByTestId('engine-detail-kittentts');
    expect(within(panel).getByText('kittentts not installed')).toBeInTheDocument();
  });

  it('renders a "Last error" line in the open panel when last_error is populated', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByText('KittenTTS (test)'));
    fireEvent.click(screen.getByTestId('why-toggle-kittentts'));
    const lastErrEls = screen.getAllByTestId('last-error');
    expect(lastErrEls.length).toBeGreaterThan(0);
    // The masked sentinel survives the redactor — confirms the row renders
    // the cache verbatim and does NOT try to "clean up" the masked string.
    expect(lastErrEls[0].textContent).toMatch(/hf_\*\*\*REDACTED\*\*\*/);
  });

  it('clicking Test engine fires getEngineHealth and renders latency_ms', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    const apiGetEngineHealth = vi.fn().mockResolvedValue({
      id: 'indextts2',
      ok: true,
      message: 'pong',
      latency_ms: 1234,
    });
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={apiGetEngineHealth}
      />,
    );

    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    const indexRow = screen.getByText('IndexTTS2 (test)').closest('[role="row"]');
    const testBtn = within(indexRow).getByRole('button', { name: /test indextts2/i });
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(apiGetEngineHealth).toHaveBeenCalledWith('indextts2');
    });
    await waitFor(() => {
      expect(within(indexRow).getByTestId('health-result-indextts2')).toBeInTheDocument();
    });
    expect(within(indexRow).getByText(/1234 ms/)).toBeInTheDocument();
  });

  it('Test button is disabled while an inflight health request is pending', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    // A health request that never resolves so we can observe the inflight state.
    let resolveHealth;
    const apiGetEngineHealth = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveHealth = resolve;
        }),
    );
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={apiGetEngineHealth}
      />,
    );

    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    const indexRow = screen.getByText('IndexTTS2 (test)').closest('[role="row"]');
    const testBtn = within(indexRow).getByRole('button', { name: /test indextts2/i });
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(testBtn).toBeDisabled();
    });
    // Second click while inflight must be a no-op — the spy has been called
    // exactly once.
    fireEvent.click(testBtn);
    expect(apiGetEngineHealth).toHaveBeenCalledTimes(1);

    // Release the promise so the test doesn't leak a pending microtask.
    resolveHealth({ id: 'indextts2', ok: true, message: 'pong', latency_ms: 50 });
  });

  // ── #21 routing display ────────────────────────────────────────────────
  function routingResponse() {
    const base = (over) => ({
      display_name: over.id,
      available: true,
      reason: null,
      install_hint: null,
      last_error: null,
      isolation_mode: 'in-process',
      ...over,
    });
    return {
      tts: {
        active: 'accel',
        backends: [
          base({
            id: 'accel',
            display_name: 'Accel TTS',
            gpu_compat: ['cuda', 'mps', 'cpu'],
            effective_device: 'cuda',
            routing_status: 'accelerated',
            routing_reason: null,
          }),
          base({
            id: 'fallback',
            display_name: 'Fallback TTS',
            gpu_compat: ['cuda', 'cpu'],
            effective_device: 'cpu',
            routing_status: 'cpu_fallback',
            routing_reason: 'engine has no CUDA path; running on CPU',
          }),
          base({
            id: 'gone',
            display_name: 'Unavail TTS',
            available: false,
            reason: 'needs cuda',
            gpu_compat: ['cuda'],
            effective_device: 'cuda',
            routing_status: 'unavailable',
            routing_reason: 'requires cuda; this host has cpu',
          }),
          // Legacy payload: no routing_* keys → render exactly as before.
          base({ id: 'legacy', display_name: 'Legacy TTS', gpu_compat: ['cpu'] }),
        ],
      },
      asr: { active: '', backends: [] },
      llm: {
        active: 'off',
        backends: [
          base({
            id: 'off',
            display_name: 'Off LLM',
            gpu_compat: [],
            effective_device: 'network',
            routing_status: 'n/a',
            routing_reason: null,
          }),
        ],
      },
    };
  }

  it('highlights the effective device chip + shows an "accelerated" badge', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('Accel TTS'));
    const row = screen.getByText('Accel TTS').closest('[role="row"]');
    expect(within(row).getByText('GPU active')).toBeInTheDocument();
    // the CUDA chip (effective_device) carries the highlight class
    expect(within(row).getByText('CUDA').classList.contains('is-effective')).toBe(true);
    // a non-effective chip does not
    expect(within(row).getByText('MPS').classList.contains('is-effective')).toBe(false);
  });

  it('shows a "CPU fallback" badge for a cpu_fallback engine', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('Fallback TTS'));
    const row = screen.getByText('Fallback TTS').closest('[role="row"]');
    expect(within(row).getByText('CPU fallback')).toBeInTheDocument();
  });

  it('suppresses the routing badge for an unavailable engine', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('Unavail TTS'));
    const row = screen.getByText('Unavail TTS').closest('[role="row"]');
    expect(within(row).queryByText('GPU active')).not.toBeInTheDocument();
    expect(within(row).queryByText('CPU fallback')).not.toBeInTheDocument();
  });

  it('renders a legacy (no-routing) payload with no routing badge', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('Legacy TTS'));
    const row = screen.getByText('Legacy TTS').closest('[role="row"]');
    expect(within(row).getByText('CPU')).toBeInTheDocument(); // chip still renders
    expect(within(row).queryByText('GPU active')).not.toBeInTheDocument(); // no routing badge
    expect(within(row).queryByText('CPU fallback')).not.toBeInTheDocument();
  });

  it('shows a "Remote" badge (not device chips) for LLM rows', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(
      <EngineCompatibilityMatrix
        family="llm"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('Off LLM'));
    const row = screen.getByText('Off LLM').closest('[role="row"]');
    expect(within(row).getByText('Remote')).toBeInTheDocument();
  });

  it('renders a failure marker when the health route returns ok=false', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    const apiGetEngineHealth = vi.fn().mockResolvedValue({
      id: 'indextts2',
      ok: false,
      message: 'spawn failed',
      latency_ms: 12,
    });
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={apiGetEngineHealth}
      />,
    );

    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    const indexRow = screen.getByText('IndexTTS2 (test)').closest('[role="row"]');
    fireEvent.click(within(indexRow).getByRole('button', { name: /test indextts2/i }));

    await waitFor(() => {
      expect(within(indexRow).getByText(/failed/i)).toBeInTheDocument();
    });
  });

  // ── P3-A: routing reason is reachable without a hover ──────────────────
  it('surfaces the routing reason as visible text, not only a hover title', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('Fallback TTS'));
    const row = screen.getByText('Fallback TTS').closest('[role="row"]');
    // Visible text (keyboard/touch reachable) — was previously only a badge title.
    expect(within(row).getByTestId('routing-reason-fallback')).toHaveTextContent(
      'engine has no CUDA path; running on CPU',
    );
    // A clean accelerated row (no caveat reason) shows no reason line.
    const accelRow = screen.getByText('Accel TTS').closest('[role="row"]');
    expect(within(accelRow).queryByTestId('routing-reason-accel')).not.toBeInTheDocument();
  });

  // ── P3-B: in-process health check reads as a liveness/deps check ────────
  it('labels an in-process health check "deps OK" while subprocess shows real ms', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    const apiGetEngineHealth = vi
      .fn()
      .mockResolvedValue({ id: 'omnivoice', ok: true, message: 'import ok', latency_ms: 0 });
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={apiGetEngineHealth}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    const omniRow = screen.getByText('OmniVoice (test)').closest('[role="row"]');
    // Exact match: the row now also has a "Self-test OmniVoice" button, which a
    // loose /test omnivoice/i would ambiguously also match.
    fireEvent.click(within(omniRow).getByRole('button', { name: 'Test OmniVoice (test)' }));
    await waitFor(() => {
      expect(within(omniRow).getByTestId('health-result-omnivoice')).toHaveTextContent('deps OK');
    });
    // The misleading "0 ms" latency is NOT shown for an in-process liveness probe.
    expect(within(omniRow).queryByText(/0 ms/)).not.toBeInTheDocument();
  });

  // ── P1-B: matrix refreshes after a successful select (no manual Refresh) ─
  it('reflects the new active engine after select resolves, without a manual Refresh', async () => {
    let active = 'omnivoice';
    const resp = () => ({
      tts: {
        active,
        backends: [
          {
            id: 'omnivoice',
            display_name: 'OmniVoice (test)',
            available: true,
            reason: null,
            install_hint: null,
            last_error: null,
            isolation_mode: 'in-process',
            gpu_compat: ['cpu'],
          },
          {
            id: 'indextts2',
            display_name: 'IndexTTS2 (test)',
            available: true,
            reason: null,
            install_hint: null,
            last_error: null,
            isolation_mode: 'subprocess',
            gpu_compat: ['cuda', 'cpu'],
          },
        ],
      },
      asr: { active: '', backends: [] },
      llm: { active: 'off', backends: [] },
    });
    const apiListEngines = vi.fn(async () => resp());
    const onSelect = vi.fn(async (_family, id) => {
      active = id; // backend now reports the new active engine
    });
    render(
      <EngineCompatibilityMatrix
        family="tts"
        onSelect={onSelect}
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    const indexRow = () => screen.getByText('IndexTTS2 (test)').closest('[role="row"]');
    // Not active yet.
    expect(within(indexRow()).queryByText('active')).not.toBeInTheDocument();

    fireEvent.click(within(indexRow()).getByRole('button', { name: /use indextts2/i }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('tts', 'indextts2'));

    // Active badge moves to IndexTTS2 after the post-select reload — no manual Refresh.
    await waitFor(() => {
      expect(within(indexRow()).getByText('active')).toBeInTheDocument();
    });
    // The reload re-fetched the engine list (initial mount + post-select).
    expect(apiListEngines.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ── P1-A: the license dialog actually mounts on "Accept license" ────────
  it('mounts the Supertonic license dialog when "Accept license" is clicked', async () => {
    const apiListEngines = vi.fn().mockResolvedValue({
      tts: {
        active: 'omnivoice',
        backends: [
          {
            id: 'supertonic3',
            display_name: 'Supertonic-3',
            available: false,
            reason: 'Supertonic-3 license not accepted — review and accept to enable it.',
            install_hint: null,
            last_error: null,
            isolation_mode: 'in-process',
            gpu_compat: ['cpu'],
          },
        ],
      },
      asr: { active: '', backends: [] },
      llm: { active: 'off', backends: [] },
    });
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('Supertonic-3'));
    // Dialog is not mounted until the button is clicked (state was previously
    // discarded, so this click did nothing — the regression this guards).
    expect(screen.queryByText('Supertonic-3 — License Acceptance')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /review and accept supertonic-3 license/i }),
    );
    await waitFor(() => {
      expect(screen.getByText('Supertonic-3 — License Acceptance')).toBeInTheDocument();
    });
  });

  // ── Real-synthesis self-test (in-process TTS engines) ──────────────────
  it('clicking Self-test runs a real synthesis and renders audio seconds + sample rate', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    const apiSelfTestEngine = vi.fn().mockResolvedValue({
      id: 'omnivoice',
      ok: true,
      message: 'synthesized',
      duration_ms: 820,
      sample_rate: 24000,
      num_samples: 19680,
      audio_seconds: 0.82,
      timed_out: false,
    });
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiSelfTestEngine={apiSelfTestEngine}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    const omniRow = screen.getByText('OmniVoice (test)').closest('[role="row"]');
    fireEvent.click(within(omniRow).getByRole('button', { name: /self-test omnivoice/i }));

    await waitFor(() => expect(apiSelfTestEngine).toHaveBeenCalledWith('omnivoice'));
    await waitFor(() => {
      expect(within(omniRow).getByTestId('selftest-result-omnivoice')).toHaveTextContent(
        '0.82s @ 24 kHz in 820 ms',
      );
    });
  });

  it('renders a timed-out marker when the self-test outruns the timeout', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    const apiSelfTestEngine = vi.fn().mockResolvedValue({
      id: 'omnivoice',
      ok: false,
      message: 'timed out after 90s (model still loading?)',
      duration_ms: 90000,
      timed_out: true,
    });
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiSelfTestEngine={apiSelfTestEngine}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    const omniRow = screen.getByText('OmniVoice (test)').closest('[role="row"]');
    fireEvent.click(within(omniRow).getByRole('button', { name: /self-test omnivoice/i }));
    await waitFor(() => {
      expect(within(omniRow).getByTestId('selftest-result-omnivoice')).toHaveTextContent(
        'Self-test timed out',
      );
    });
  });

  it('does not offer Self-test for a subprocess engine (spawn-and-ping only)', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiSelfTestEngine={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    const indexRow = screen.getByText('IndexTTS2 (test)').closest('[role="row"]');
    // "Test engine" (liveness) is present; the real-synth "Self-test" is not.
    expect(within(indexRow).getByRole('button', { name: /test indextts2/i })).toBeInTheDocument();
    expect(within(indexRow).queryByRole('button', { name: /self-test/i })).not.toBeInTheDocument();
  });

  it('does not offer Self-test on a non-TTS family (ASR)', async () => {
    const apiListEngines = vi.fn().mockResolvedValue({
      tts: { active: '', backends: [] },
      asr: {
        active: 'wx',
        backends: [
          {
            id: 'wx',
            display_name: 'WhisperX (test)',
            available: true,
            reason: null,
            install_hint: null,
            last_error: null,
            isolation_mode: 'in-process',
            gpu_compat: ['cpu'],
          },
        ],
      },
      llm: { active: 'off', backends: [] },
    });
    render(
      <EngineCompatibilityMatrix
        family="asr"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiSelfTestEngine={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('WhisperX (test)'));
    const row = screen.getByText('WhisperX (test)').closest('[role="row"]');
    expect(within(row).queryByRole('button', { name: /self-test/i })).not.toBeInTheDocument();
  });

  // ── Setup snippet for path-gated opt-in engines ────────────────────────
  it('renders the copy-paste setup snippet for a path-gated opt-in engine', async () => {
    const apiListEngines = vi.fn().mockResolvedValue({
      tts: {
        active: 'omnivoice',
        backends: [
          {
            id: 'indextts2',
            display_name: 'IndexTTS-2',
            available: false,
            reason: 'IndexTTS-2 venv not found. Set OMNIVOICE_INDEXTTS_DIR.',
            install_hint: 'git clone index-tts/index-tts',
            setup_snippet: 'export OMNIVOICE_INDEXTTS_DIR=/path/to/index-tts',
            last_error: null,
            isolation_mode: 'subprocess',
            gpu_compat: ['cuda', 'cpu'],
          },
        ],
      },
      asr: { active: '', backends: [] },
      llm: { active: 'off', backends: [] },
    });
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiSelfTestEngine={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS-2'));
    // The snippet lives in the row's expansion panel — open it first.
    fireEvent.click(screen.getByTestId('why-toggle-indextts2'));
    const snippet = screen.getByTestId('setup-snippet-indextts2');
    expect(snippet).toHaveTextContent('export OMNIVOICE_INDEXTTS_DIR=/path/to/index-tts');
    expect(
      within(snippet).getByRole('button', { name: /copy setup command/i }),
    ).toBeInTheDocument();
  });

  it('shows no setup snippet for a bundled engine', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiSelfTestEngine={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('KittenTTS (test)'));
    // KittenTTS in the fixture carries no setup_snippet → no snippet block
    // even with its details panel open.
    fireEvent.click(screen.getByTestId('why-toggle-kittentts'));
    expect(screen.queryByTestId('setup-snippet-kittentts')).not.toBeInTheDocument();
  });

  // ── #981 — mlx-audio curated-model picker ───────────────────────────────
  function mlxAudioResponse({ activeModelId = 'kokoro' } = {}) {
    return {
      tts: {
        active: 'mlx-audio',
        backends: [
          {
            id: 'mlx-audio',
            display_name: 'MLX-Audio (test)',
            available: true,
            reason: null,
            install_hint: null,
            last_error: null,
            isolation_mode: 'in-process',
            gpu_compat: ['mps', 'cpu'],
            curated_models: [
              {
                key: 'kokoro',
                label: 'Kokoro (default, fast)',
                repo_id: 'mlx-community/Kokoro-82M-bf16',
              },
              { key: 'csm', label: 'CSM (voice cloning)', repo_id: 'mlx-community/csm-1b-8bit' },
              {
                key: 'outetts',
                label: 'OuteTTS',
                repo_id: 'mlx-community/Llama-OuteTTS-1.0-1B-4bit',
              },
            ],
            active_model_id: activeModelId,
          },
        ],
      },
      asr: { active: '', backends: [] },
      llm: { active: 'off', backends: [] },
    };
  }

  it('renders the curated-model picker for mlx-audio, pre-selected to the active model', async () => {
    const apiListEngines = vi
      .fn()
      .mockResolvedValue(mlxAudioResponse({ activeModelId: 'outetts' }));
    render(
      <EngineCompatibilityMatrix
        family="tts"
        onSelect={vi.fn()}
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('MLX-Audio (test)'));
    const select = screen.getByTestId('curated-model-select-mlx-audio');
    expect(select).toHaveValue('outetts');
    // All curated models are offered as options.
    expect(
      within(select).getByRole('option', { name: 'Kokoro (default, fast)' }),
    ).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'CSM (voice cloning)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'OuteTTS' })).toBeInTheDocument();
  });

  it('picking a different curated model calls onSelect with the model key and refreshes', async () => {
    let activeModelId = 'kokoro';
    const apiListEngines = vi.fn(async () => mlxAudioResponse({ activeModelId }));
    const onSelect = vi.fn(async (_family, _id, modelId) => {
      activeModelId = modelId;
    });
    render(
      <EngineCompatibilityMatrix
        family="tts"
        onSelect={onSelect}
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('MLX-Audio (test)'));
    const select = screen.getByTestId('curated-model-select-mlx-audio');
    fireEvent.change(select, { target: { value: 'csm' } });

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('tts', 'mlx-audio', 'csm');
    });
    // Reloaded after the pick — matrix reflects the new active_model_id.
    await waitFor(() => {
      expect(screen.getByTestId('curated-model-select-mlx-audio')).toHaveValue('csm');
    });
    expect(apiListEngines.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not render a curated-model picker for engines without curated_models', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        onSelect={vi.fn()}
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    expect(screen.queryByTestId(/curated-model-select-/)).not.toBeInTheDocument();
  });

  it('disables the curated-model picker when no onSelect is provided', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(mlxAudioResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('MLX-Audio (test)'));
    expect(screen.getByTestId('curated-model-select-mlx-audio')).toBeDisabled();
  });

  // ── showFamilyTabs={false} — pinned per-family mount (Settings → Engines) ─
  function multiFamilyResponse() {
    return {
      tts: {
        active: 'omnivoice',
        backends: [
          {
            id: 'omnivoice',
            display_name: 'OmniVoice (test)',
            available: true,
            reason: null,
            install_hint: null,
            last_error: null,
            isolation_mode: 'in-process',
            gpu_compat: ['cpu'],
          },
        ],
      },
      asr: {
        active: 'whisperx',
        backends: [
          {
            id: 'whisperx',
            display_name: 'WhisperX (test)',
            available: true,
            reason: null,
            install_hint: null,
            last_error: null,
            isolation_mode: 'in-process',
            gpu_compat: ['cpu'],
          },
        ],
      },
      llm: { active: 'off', backends: [] },
    };
  }

  it('pins to the given family and hides the TTS/ASR/LLM switcher when showFamilyTabs is false', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(multiFamilyResponse());
    render(
      <EngineCompatibilityMatrix
        family="asr"
        showFamilyTabs={false}
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('WhisperX (test)'));
    // Pinned header names the family instead of the generic matrix title…
    expect(screen.getByText('ASR Engines')).toBeInTheDocument();
    // …the TTS family never leaks into the pinned table…
    expect(screen.queryByText('OmniVoice (test)')).not.toBeInTheDocument();
    // …and there is no family switcher to wander off to.
    expect(document.querySelector('.engine-matrix__tab-family')).toBeNull();
  });

  it('keeps the family switcher by default (standalone mounts unchanged)', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(multiFamilyResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    expect(screen.getByText('Engine Compatibility Matrix')).toBeInTheDocument();
    expect(document.querySelectorAll('.engine-matrix__tab-family').length).toBe(3);
  });

  it('names what each family does in pinned mode (one description line)', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(multiFamilyResponse());
    render(
      <EngineCompatibilityMatrix
        family="asr"
        showFamilyTabs={false}
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('WhisperX (test)'));
    expect(screen.getByTestId('family-desc-asr')).toHaveTextContent(/turns audio into text/i);
  });

  // ── Engine identity mark — one scannable monogram per row ───────────────
  it('renders a deterministic identity mark on every engine row', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    // Monogram derives from the id: "omnivoice" → "OM", "indextts2" → "IN".
    expect(screen.getByTestId('engine-mark-omnivoice')).toHaveTextContent('OM');
    expect(screen.getByTestId('engine-mark-indextts2')).toHaveTextContent('IN');
    expect(screen.getByTestId('engine-mark-kittentts')).toBeInTheDocument();
    // Decorative — the name/id are the accessible text.
    expect(screen.getByTestId('engine-mark-omnivoice')).toHaveAttribute('aria-hidden', 'true');
  });

  // ── `hint` — available-but-has-advice rows ──────────────────────────────
  function hintResponse() {
    const resp = makeEnginesResponse();
    // OmniVoice: available with advice (the VoxCPM2 ">=2.0.3" shape).
    resp.tts.backends[0].hint =
      'installed voxcpm 2.0.1 is older than 2.0.3 — upgrading is recommended';
    return resp;
  }

  it('renders the ok-with-advice hint as a quiet inline line on an available row', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(hintResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    expect(screen.getByTestId('engine-hint-omnivoice')).toHaveTextContent(
      'installed voxcpm 2.0.1 is older than 2.0.3 — upgrading is recommended',
    );
    // Rows without advice (or legacy payloads without the field) show none.
    expect(screen.queryByTestId('engine-hint-indextts2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('engine-hint-kittentts')).not.toBeInTheDocument();
  });

  // ── Capability badge — voice cloning ────────────────────────────────────
  function cloningResponse() {
    const resp = makeEnginesResponse();
    resp.tts.backends[0].supports_cloning = true; // omnivoice
    resp.tts.backends[2].supports_cloning = false; // indextts2 — explicit false
    // kittentts: field absent (legacy payload) → no badge either.
    return resp;
  }

  it('badges voice-cloning-capable engines — and only on explicit true', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(cloningResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    expect(screen.getByTestId('clone-badge-omnivoice')).toHaveTextContent('Voice cloning');
    expect(screen.queryByTestId('clone-badge-indextts2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clone-badge-kittentts')).not.toBeInTheDocument();
  });

  it('never badges cloning on a non-TTS family (capability is TTS-only)', async () => {
    const resp = multiFamilyResponse();
    resp.asr.backends[0].supports_cloning = true; // hostile/buggy payload
    const apiListEngines = vi.fn().mockResolvedValue(resp);
    render(
      <EngineCompatibilityMatrix
        family="asr"
        showFamilyTabs={false}
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('WhisperX (test)'));
    expect(screen.queryByTestId('clone-badge-whisperx')).not.toBeInTheDocument();
  });

  // ── Memory residency — "In memory" chip + Unload ────────────────────────
  const LOADED = {
    models: [
      {
        id: 'sidecar:indextts2',
        name: 'indextts2 (sidecar)',
        checkpoint: 'indextts2',
        device: 'mps',
        vram_mb: 812.5,
        unloadable: true,
        engine_id: 'indextts2',
        is_active_engine: false,
      },
    ],
    count: 1,
  };

  it('marks a loaded engine "In memory" and unloads it via its /model/loaded id', async () => {
    let loaded = LOADED;
    const apiListLoadedModels = vi.fn(async () => loaded);
    const apiUnloadModel = vi.fn(async () => {
      loaded = { models: [], count: 0 }; // backend freed it
      return { unloaded: 'sidecar:indextts2', success: true };
    });
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiListLoadedModels={apiListLoadedModels}
        apiUnloadModel={apiUnloadModel}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    const row = () => screen.getByText('IndexTTS2 (test)').closest('[role="row"]');
    await waitFor(() => {
      expect(within(row()).getByTestId('resident-indextts2')).toHaveTextContent('In memory');
    });
    // Non-resident rows carry neither the chip nor the button.
    const omniRow = screen.getByText('OmniVoice (test)').closest('[role="row"]');
    expect(within(omniRow).queryByTestId('resident-omnivoice')).not.toBeInTheDocument();
    expect(
      within(omniRow).queryByRole('button', { name: /unload omnivoice/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(row()).getByRole('button', { name: /unload indextts2/i }));
    await waitFor(() => {
      // Unload targets the /model/loaded id (sidecar:<engine>), not the engine id.
      expect(apiUnloadModel).toHaveBeenCalledWith('sidecar:indextts2');
    });
    // Chip and button clear after the residency refresh.
    await waitFor(() => {
      expect(within(row()).queryByTestId('resident-indextts2')).not.toBeInTheDocument();
    });
    expect(
      within(row()).queryByRole('button', { name: /unload indextts2/i }),
    ).not.toBeInTheDocument();
  });

  it('offers no Unload when the loaded entry is not unloadable', async () => {
    const apiListLoadedModels = vi.fn().mockResolvedValue({
      models: [{ ...LOADED.models[0], unloadable: false }],
      count: 1,
    });
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiListLoadedModels={apiListLoadedModels}
        apiUnloadModel={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    const row = screen.getByText('IndexTTS2 (test)').closest('[role="row"]');
    await waitFor(() => {
      expect(within(row).getByTestId('resident-indextts2')).toBeInTheDocument();
    });
    expect(
      within(row).queryByRole('button', { name: /unload indextts2/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the matrix normally when the residency probe fails (advisory only)', async () => {
    const apiListLoadedModels = vi.fn().mockRejectedValue(new Error('backend restarting'));
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiListLoadedModels={apiListLoadedModels}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    expect(document.querySelectorAll('[data-engine-id]').length).toBe(3);
    expect(screen.queryByTestId('resident-indextts2')).not.toBeInTheDocument();
  });

  // ── Strict two-line row layout ───────────────────────────────────────────
  it('renders strict two-line rows: fixed height, truncated name with full title', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));

    for (const row of document.querySelectorAll('[data-engine-id]')) {
      // Fixed two-line height + clipping — the class pair that stops one
      // engine from filling a viewport (the marker class is asserted so a
      // future restyle can't silently drop the constraint).
      expect(row.classList.contains('is-two-line')).toBe(true);
      expect(row.className).toMatch(/\bh-16\b/);
      expect(row.className).toMatch(/\boverflow-hidden\b/);
      // The display name never wraps: single-line truncation with the full
      // name reachable via title.
      const name = row.querySelector('.engine-matrix__name');
      expect(name.className).toMatch(/\btruncate\b/);
      expect(name.className).toMatch(/\bwhitespace-nowrap\b/);
      expect(name).toHaveAttribute('title', name.textContent);
    }
  });

  it('header and every row share identical grid column tracks', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));

    const headerRow = screen.getAllByRole('columnheader')[0].closest('[role="row"]');
    const track = headerRow.className.match(/grid-cols-\[[^\]]+\]/)?.[0];
    expect(track).toBeTruthy();
    for (const row of document.querySelectorAll('[data-engine-id]')) {
      expect(row.className).toContain(track);
    }
  });

  it('opens and closes the details expansion panel below the row', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('KittenTTS (test)'));

    const toggle = screen.getByTestId('why-toggle-kittentts');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('engine-detail-kittentts')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByTestId('engine-detail-kittentts');
    // The panel is a SIBLING below the row — not inside it — so the row keeps
    // its fixed two-line height and sibling rows stay aligned.
    const kittenRow = screen.getByText('KittenTTS (test)').closest('[role="row"]');
    expect(kittenRow.contains(panel)).toBe(false);
    expect(kittenRow.nextElementSibling).toBe(panel);
    expect(within(panel).getByText('kittentts not installed')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('engine-detail-kittentts')).not.toBeInTheDocument();
  });

  it('available rows offer no details toggle (hints stay inline on line 2)', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    expect(screen.queryByTestId('why-toggle-omnivoice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('why-toggle-indextts2')).not.toBeInTheDocument();
    expect(screen.getByTestId('why-toggle-kittentts')).toBeInTheDocument();
  });

  // ── One-click sidecar install (IndexTTS-2 & friends) ────────────────────

  /** An unavailable, one-click-installable IndexTTS2 row. */
  function makeInstallableResponse() {
    const res = makeEnginesResponse();
    res.tts.backends[2] = {
      ...res.tts.backends[2],
      available: false,
      reason: 'IndexTTS-2 venv not found.',
      setup_snippet: 'export OMNIVOICE_INDEXTTS_DIR=/path/to/index-tts',
      one_click_install: true,
    };
    return res;
  }

  /** Pre-install status: no job yet (what the on-mount re-attach probe sees). */
  function makeIdleStatus() {
    return {
      engine_id: 'indextts2',
      installed: false,
      managed: false,
      install_dir: null,
      job: null,
    };
  }

  function makeInstallStatus(jobState, overrides = {}) {
    return {
      engine_id: 'indextts2',
      installed: false,
      managed: false,
      install_dir: null,
      job: {
        engine_id: 'indextts2',
        state: jobState,
        steps: [
          { id: 'preflight', state: 'done', detail: null },
          { id: 'fetch_source', state: 'running', detail: null },
          { id: 'create_venv', state: 'pending', detail: null },
          { id: 'install_deps', state: 'pending', detail: null },
          { id: 'verify', state: 'pending', detail: null },
          { id: 'fetch_weights', state: 'pending', detail: null },
          { id: 'persist', state: 'pending', detail: null },
        ],
        log: ['Cloning https://github.com/index-tts/index-tts.git (git, depth 1) …'],
        error: null,
        remediation: null,
        weights_progress: null,
        started_at: 1,
        finished_at: null,
        ...overrides,
      },
    };
  }

  it('installable unavailable rows get an Install button; clicking it starts the job and shows step progress', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeInstallableResponse());
    const apiInstallEngine = vi.fn().mockResolvedValue({ status: 'started', engine: 'indextts2' });
    // First call = the on-mount re-attach probe (no job yet); later calls =
    // the post-click status refresh with the running job.
    const apiInstallStatus = vi
      .fn()
      .mockResolvedValueOnce(makeIdleStatus())
      .mockResolvedValue(makeInstallStatus('running'));
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiInstallEngine={apiInstallEngine}
        apiInstallStatus={apiInstallStatus}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS2 (test)'));

    const installBtn = screen.getByTestId('install-indextts2');
    expect(installBtn).toHaveTextContent('Install');
    fireEvent.click(installBtn);

    await waitFor(() => expect(apiInstallEngine).toHaveBeenCalledWith('indextts2'));
    expect(apiInstallStatus).toHaveBeenCalledWith('indextts2');

    // Clicking auto-opens the detail panel where the progress renders.
    const progress = await screen.findByTestId('install-progress-indextts2');
    expect(within(progress).getByText(/Checking uv and disk space/)).toBeInTheDocument();
    const running = progress.querySelector('[data-install-step="fetch_source"]');
    expect(running).toHaveAttribute('data-step-state', 'running');
    // The live log tail is visible while the job runs.
    expect(within(progress).getByText(/Cloning https:\/\//)).toBeInTheDocument();
    // The button reflects the in-flight job.
    expect(screen.getByTestId('install-indextts2')).toHaveTextContent('Installing…');
  });

  it('a failed job renders the error with its remediation and offers Retry', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeInstallableResponse());
    const apiInstallEngine = vi.fn().mockResolvedValue({ status: 'started', engine: 'indextts2' });
    const apiInstallStatus = vi
      .fn()
      .mockResolvedValueOnce(makeIdleStatus())
      .mockResolvedValue(
        makeInstallStatus('failed', {
          error: 'Not enough disk space to install IndexTTS-2',
          remediation: 'Free up disk space and retry.',
          finished_at: 2,
        }),
      );
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiInstallEngine={apiInstallEngine}
        apiInstallStatus={apiInstallStatus}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    fireEvent.click(screen.getByTestId('install-indextts2'));

    const progress = await screen.findByTestId('install-progress-indextts2');
    expect(
      within(progress).getByText(/Not enough disk space .* Free up disk space and retry\./),
    ).toBeInTheDocument();
    expect(screen.getByTestId('install-indextts2')).toHaveTextContent('Retry install');
  });

  it('already_installed responses skip the job and just reload the matrix', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeInstallableResponse());
    const apiInstallEngine = vi
      .fn()
      .mockResolvedValue({ status: 'already_installed', engine: 'indextts2' });
    const apiInstallStatus = vi.fn().mockResolvedValue(makeIdleStatus());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiInstallEngine={apiInstallEngine}
        apiInstallStatus={apiInstallStatus}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    fireEvent.click(screen.getByTestId('install-indextts2'));

    await waitFor(() => expect(apiListEngines).toHaveBeenCalledTimes(2)); // reload()
    // No job progress ever rendered — nothing to poll beyond the mount probe.
    expect(screen.queryByTestId('install-progress-indextts2')).not.toBeInTheDocument();
  });

  it('demotes the manual setup snippet to a collapsed fallback on installable rows', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeInstallableResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        // Installable-but-unavailable rows probe install status on mount
        // (re-attach to an in-flight job) — stub it so no network happens.
        apiInstallStatus={vi.fn().mockResolvedValue(makeIdleStatus())}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    fireEvent.click(screen.getByTestId('why-toggle-indextts2'));

    // Installable row: snippet lives INSIDE a collapsed <details> fallback.
    const manual = screen.getByTestId('manual-install-indextts2');
    expect(manual.tagName).toBe('DETAILS');
    expect(manual).not.toHaveAttribute('open');
    expect(within(manual).getByTestId('setup-snippet-indextts2')).toBeInTheDocument();
  });

  it('re-attaches to an in-flight install job on mount (no click needed)', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeInstallableResponse());
    const apiInstallStatus = vi.fn().mockResolvedValue(makeInstallStatus('running'));
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
        apiInstallStatus={apiInstallStatus}
      />,
    );
    await waitFor(() => screen.getByText('IndexTTS2 (test)'));
    // The mount probe found a running job — the button reflects it without
    // any user interaction (Settings was closed and reopened mid-install).
    await waitFor(() =>
      expect(screen.getByTestId('install-indextts2')).toHaveTextContent('Installing…'),
    );
    expect(apiInstallStatus).toHaveBeenCalledWith('indextts2');
  });

  it('keeps the setup snippet top-level on rows without a one-click installer', async () => {
    const res = makeEnginesResponse();
    res.tts.backends[1].setup_snippet = 'export OMNIVOICE_SHERPA_MODEL=/m';
    const apiListEngines = vi.fn().mockResolvedValue(res);
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText('KittenTTS (test)'));
    fireEvent.click(screen.getByTestId('why-toggle-kittentts'));
    expect(screen.getByTestId('setup-snippet-kittentts')).toBeInTheDocument();
    expect(screen.queryByTestId('manual-install-kittentts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('install-kittentts')).not.toBeInTheDocument();
  });
});
