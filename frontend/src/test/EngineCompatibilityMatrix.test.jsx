import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Mock the toast import the component depends on — keeps the test free
// of side-effect side-channels (toast() schedules timers we don't want).
vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
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

    // Three engine rows, one per registered backend.
    expect(screen.getAllByRole('row').length).toBe(3);
    expect(screen.getByText('KittenTTS (test)')).toBeInTheDocument();
    expect(screen.getByText('IndexTTS2 (test)')).toBeInTheDocument();
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

  it('shows the install reason inline when a backend is unavailable', async () => {
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
    expect(within(kittenRow).getByText('kittentts not installed')).toBeInTheDocument();
    // The badge text is exactly "Unavailable" (with a leading icon); the new
    // disclosure summary is "Why unavailable?" — scope to the badge with an
    // exact match so we don't double-count the summary.
    const badge = within(kittenRow).getByText(
      (_, el) => el?.tagName === 'SPAN' && /^\s*Unavailable\s*$/.test(el.textContent || ''),
    );
    expect(badge).toBeInTheDocument();
  });

  it('renders a "Last error" line when last_error is populated', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    render(
      <EngineCompatibilityMatrix
        family="tts"
        apiListEngines={apiListEngines}
        apiGetEngineHealth={vi.fn()}
      />,
    );

    await waitFor(() => screen.getByText('KittenTTS (test)'));
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
    // KittenTTS in the fixture carries no setup_snippet → no snippet block.
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
});
