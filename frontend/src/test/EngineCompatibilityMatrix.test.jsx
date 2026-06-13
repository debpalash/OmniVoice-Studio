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
function makeEnginesResponse({
  inProcessAvailable = true,
  inProcessHasLastError = false,
} = {}) {
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
    const badge = within(kittenRow).getByText((_, el) =>
      el?.tagName === 'SPAN' && /^\s*Unavailable\s*$/.test(el.textContent || '')
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
      id: 'indextts2', ok: true, message: 'pong', latency_ms: 1234,
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
    const apiGetEngineHealth = vi.fn(() => new Promise((resolve) => { resolveHealth = resolve; }));
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
      display_name: over.id, available: true, reason: null, install_hint: null,
      last_error: null, isolation_mode: 'in-process', ...over,
    });
    return {
      tts: {
        active: 'accel',
        backends: [
          base({ id: 'accel', display_name: 'Accel TTS', gpu_compat: ['cuda', 'mps', 'cpu'],
                 effective_device: 'cuda', routing_status: 'accelerated', routing_reason: null }),
          base({ id: 'fallback', display_name: 'Fallback TTS', gpu_compat: ['cuda', 'cpu'],
                 effective_device: 'cpu', routing_status: 'cpu_fallback',
                 routing_reason: 'engine has no CUDA path; running on CPU' }),
          base({ id: 'gone', display_name: 'Unavail TTS', available: false, reason: 'needs cuda',
                 gpu_compat: ['cuda'], effective_device: 'cuda',
                 routing_status: 'unavailable', routing_reason: 'requires cuda; this host has cpu' }),
          // Legacy payload: no routing_* keys → render exactly as before.
          base({ id: 'legacy', display_name: 'Legacy TTS', gpu_compat: ['cpu'] }),
        ],
      },
      asr: { active: '', backends: [] },
      llm: {
        active: 'off',
        backends: [base({ id: 'off', display_name: 'Off LLM', gpu_compat: [],
                          effective_device: 'network', routing_status: 'n/a', routing_reason: null })],
      },
    };
  }

  it('highlights the effective device chip + shows an "accelerated" badge', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(<EngineCompatibilityMatrix family="tts" apiListEngines={apiListEngines} apiGetEngineHealth={vi.fn()} />);
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
    render(<EngineCompatibilityMatrix family="tts" apiListEngines={apiListEngines} apiGetEngineHealth={vi.fn()} />);
    await waitFor(() => screen.getByText('Fallback TTS'));
    const row = screen.getByText('Fallback TTS').closest('[role="row"]');
    expect(within(row).getByText('CPU fallback')).toBeInTheDocument();
  });

  it('suppresses the routing badge for an unavailable engine', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(<EngineCompatibilityMatrix family="tts" apiListEngines={apiListEngines} apiGetEngineHealth={vi.fn()} />);
    await waitFor(() => screen.getByText('Unavail TTS'));
    const row = screen.getByText('Unavail TTS').closest('[role="row"]');
    expect(within(row).queryByText('GPU active')).not.toBeInTheDocument();
    expect(within(row).queryByText('CPU fallback')).not.toBeInTheDocument();
  });

  it('renders a legacy (no-routing) payload with no routing badge', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(<EngineCompatibilityMatrix family="tts" apiListEngines={apiListEngines} apiGetEngineHealth={vi.fn()} />);
    await waitFor(() => screen.getByText('Legacy TTS'));
    const row = screen.getByText('Legacy TTS').closest('[role="row"]');
    expect(within(row).getByText('CPU')).toBeInTheDocument();             // chip still renders
    expect(within(row).queryByText('GPU active')).not.toBeInTheDocument(); // no routing badge
    expect(within(row).queryByText('CPU fallback')).not.toBeInTheDocument();
  });

  it('shows a "Remote" badge (not device chips) for LLM rows', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(routingResponse());
    render(<EngineCompatibilityMatrix family="llm" apiListEngines={apiListEngines} apiGetEngineHealth={vi.fn()} />);
    await waitFor(() => screen.getByText('Off LLM'));
    const row = screen.getByText('Off LLM').closest('[role="row"]');
    expect(within(row).getByText('Remote')).toBeInTheDocument();
  });

  it('renders a failure marker when the health route returns ok=false', async () => {
    const apiListEngines = vi.fn().mockResolvedValue(makeEnginesResponse());
    const apiGetEngineHealth = vi.fn().mockResolvedValue({
      id: 'indextts2', ok: false, message: 'spawn failed', latency_ms: 12,
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
});
