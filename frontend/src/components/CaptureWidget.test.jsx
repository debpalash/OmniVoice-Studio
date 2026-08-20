/**
 * CaptureWidget pill behaviour — mocked WS + Tauri invoke.
 *
 * Covers the truthfulness rebuild: model status frames render real
 * download/load progress, "Pasted" only appears after simulate_paste resolves
 * Ok, an "a11y:"-prefixed paste failure renders the actionable Accessibility
 * error, Esc aborts without pasting, live retract-retype is opt-in (default
 * sessions never call simulate_type), the missing-Accessibility setup state
 * shows on mount, and the waveform bars move from real mic frames.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

// ── Hoisted mock state (vi.mock factories may only reference vi.hoisted vars) ──
const mocks = vi.hoisted(() => {
  const state = {
    dictationEnabled: true,
    dictationMode: 'toggle',
    dictationModelId: 'sherpa-parakeet-tdt-v3', // sherpa → raw-PCM live path
    aecEnabled: false,
    loadDictationPrefs: () => {},
  };
  const holder = {
    // Per-test knobs for the Tauri invoke mock.
    a11y: true,
    paste: async () => undefined,
    calls: [],
    // Captured micCapture frame callback (the worklet feed).
    onFrame: null,
  };
  return {
    state,
    holder,
    authenticatedWsUrl: vi.fn(async (path) => `ws://test${path}&ws_ticket=one-use`),
    invoke: async (cmd, args) => {
      holder.calls.push([cmd, args]);
      if (cmd === 'check_accessibility') return holder.a11y;
      if (cmd === 'simulate_paste') return holder.paste();
      return undefined;
    },
  };
});

vi.mock('../store', () => ({
  useAppStore: Object.assign((sel) => sel(mocks.state), { getState: () => mocks.state }),
}));
vi.mock('../api/client', () => ({
  API: 'http://test',
  wsUrl: (p) => `ws://test${p}`,
  apiFetch: vi.fn(async () => ({ json: async () => ({}) })),
}));
vi.mock('../api/authSession', () => ({ authenticatedWsUrl: mocks.authenticatedWsUrl }));
vi.mock('../pages/Transcriptions', () => ({ addTranscription: vi.fn() }));
vi.mock('../utils/copyText', () => ({ copyText: vi.fn(async () => {}) }));
vi.mock('react-hot-toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ hide: vi.fn(async () => {}) }),
}));
vi.mock('../utils/aec/micCapture', () => ({
  startMicCapture: async (stream, onFrame) => {
    mocks.holder.onFrame = onFrame;
    return async () => {};
  },
}));

import CaptureWidget from './CaptureWidget';

// ── Browser API fakes (jsdom has neither WebSocket use here nor MediaRecorder) ──
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN; // pretend the connect is instant
    this.sent = [];
    this._listeners = {};
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  /** Deliver a backend JSON frame. */
  msg(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  constructor() {
    this.state = 'inactive';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
  }
}

function withI18n(node) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}

// Start a session via the in-page shortcut and wait for the live socket.
async function startSession() {
  fireEvent.keyDown(window, { code: 'Space', ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  await screen.findByText(/Listening/);
  return FakeWebSocket.instances[0];
}

describe('CaptureWidget', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    mocks.holder.a11y = true;
    mocks.holder.paste = async () => undefined;
    mocks.holder.calls = [];
    mocks.holder.onFrame = null;
    mocks.authenticatedWsUrl.mockClear();
    mocks.authenticatedWsUrl.mockImplementation(
      async (path) => `ws://test${path}${path.includes('?') ? '&' : '?'}ws_ticket=one-use`,
    );
    mocks.state.dictationMode = 'toggle';
    mocks.state.dictationModelId = 'sherpa-parakeet-tdt-v3';
    FakeWebSocket.instances = [];
    global.WebSocket = FakeWebSocket;
    global.MediaRecorder = FakeMediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
    localStorage.clear();
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete global.WebSocket;
    delete global.MediaRecorder;
  });

  const pasteCalls = () => mocks.holder.calls.filter(([c]) => c === 'simulate_paste');
  const typeCalls = () => mocks.holder.calls.filter(([c]) => c === 'simulate_type');

  it('honors a hold-mode release while microphone startup is pending', async () => {
    mocks.state.dictationMode = 'hold';
    let resolveMicrophone;
    const getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMicrophone = resolve;
        }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    render(withI18n(<CaptureWidget />));

    fireEvent.keyDown(window, { code: 'Space', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.keyUp(window, { code: 'Space' });
    await act(async () => {
      resolveMicrophone({ getTracks: () => [{ stop() {} }] });
    });

    expect(await screen.findByText(/Transcribing/)).toBeInTheDocument();
    expect(screen.queryByText(/Listening/)).not.toBeInTheDocument();
  });

  it('falls back to raw PCM when MediaRecorder cannot be constructed', async () => {
    mocks.state.dictationModelId = null;
    delete global.MediaRecorder;
    render(withI18n(<CaptureWidget />));

    const ws = await startSession();
    expect(ws.url).toContain('/ws/transcribe?pcm=1&sr=16000');
    expect(mocks.authenticatedWsUrl).toHaveBeenCalledWith('/ws/transcribe?pcm=1&sr=16000', {
      apiBase: 'http://test',
    });
    expect(ws.url).toContain('ws_ticket=one-use');
    expect(mocks.holder.onFrame).toBeTypeOf('function');

    act(() => mocks.holder.onFrame(new Float32Array([0.25, -0.25])));
    expect(ws.sent.some((value) => value instanceof ArrayBuffer)).toBe(true);
  });

  it('renders truthful model status from {type:"status"} frames', async () => {
    render(withI18n(<CaptureWidget />));
    const ws = await startSession();

    act(() => ws.msg({ type: 'status', stage: 'downloading', progress: 0.42 }));
    expect(screen.getByText(/Downloading voice model/)).toBeInTheDocument();
    expect(screen.getByText(/42%/)).toBeInTheDocument();

    act(() => ws.msg({ type: 'status', stage: 'loading' }));
    expect(screen.getByText(/Loading model/)).toBeInTheDocument();

    act(() => ws.msg({ type: 'status', stage: 'ready' }));
    expect(screen.getByText(/Listening/)).toBeInTheDocument();
  });

  it('shows "Pasted" only after simulate_paste resolved Ok', async () => {
    render(withI18n(<CaptureWidget />));
    const ws = await startSession();

    // Offline-model shape: one utterance final, then the EOF summary.
    act(() => ws.msg({ type: 'final', text: 'hello world' }));
    act(() => ws.msg({ type: 'final', text: 'hello world' }));

    await screen.findByText(/Pasted/);
    expect(pasteCalls().length).toBeGreaterThan(0);
    expect(pasteCalls()[0][1]).toEqual({ text: 'hello world' });
  });

  it('an "a11y:" paste rejection renders the actionable error, never "Pasted"', async () => {
    mocks.holder.paste = async () => {
      throw 'a11y: process is not trusted';
    };
    render(withI18n(<CaptureWidget />));
    const ws = await startSession();

    act(() => ws.msg({ type: 'final', text: 'hello world' }));
    act(() => ws.msg({ type: 'final', text: 'hello world' }));

    await screen.findByText(/Accessibility access needed/);
    expect(screen.queryByText(/Pasted/)).not.toBeInTheDocument();

    // The action button opens the OS Accessibility pane.
    fireEvent.click(screen.getByText('Open Settings'));
    await waitFor(() =>
      expect(mocks.holder.calls.some(([c]) => c === 'open_accessibility_settings')).toBe(true),
    );
  });

  it('Esc during recording aborts: socket closed, nothing pasted, pill gone', async () => {
    const { container } = render(withI18n(<CaptureWidget />));
    const ws = await startSession();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('.capture-pill')).toBeNull());
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(pasteCalls()).toEqual([]);
  });

  it('live retract-retype is OFF by default: partials never simulate_type', async () => {
    render(withI18n(<CaptureWidget />));
    const ws = await startSession();

    act(() => ws.msg({ type: 'partial', text: 'hel' }));
    act(() => ws.msg({ type: 'partial', text: 'hello wor' }));
    act(() => ws.msg({ type: 'final', text: 'hello world' }));
    act(() => ws.msg({ type: 'final', text: 'hello world' }));

    await screen.findByText(/Pasted/);
    // Committed final went through the paste path; no keystroke storms.
    expect(typeCalls()).toEqual([]);
    expect(pasteCalls().length).toBeGreaterThan(0);
  });

  it('the LS_LIVE_TYPING pref opts back into word-by-word typing', async () => {
    localStorage.setItem('omni_capture_live_typing', '1');
    render(withI18n(<CaptureWidget />));
    const ws = await startSession();

    act(() => ws.msg({ type: 'partial', text: 'hello' }));
    await waitFor(() => expect(typeCalls().length).toBeGreaterThan(0));
    expect(typeCalls()[0][1]).toEqual({ text: 'hello', backspaces: 0 });
  });

  it('a refined EOF summary is not re-pasted as a new utterance', async () => {
    render(withI18n(<CaptureWidget />));
    const ws = await startSession();

    // Two per-utterance commits paste live…
    act(() => ws.msg({ type: 'final', text: 'Hello world.' }));
    act(() => ws.msg({ type: 'final', text: 'Second bit.' }));
    // …then the EOF summary arrives with an LLM-refined variant. Its raw
    // `text` equals the committed join, so it must finalise — never paste
    // the whole (refined) transcript a third time.
    act(() =>
      ws.msg({
        type: 'final',
        text: 'Hello world. Second bit.',
        refined_text: 'Hello world, second bit.',
      }),
    );

    await screen.findByText(/Pasted/);
    expect(pasteCalls().map(([, a]) => a.text)).toEqual(['Hello world.', 'Second bit.']);
  });

  it('renders the one-time Accessibility setup state when the mount probe fails', async () => {
    mocks.holder.a11y = false;
    render(withI18n(<CaptureWidget />));

    await screen.findByText(/Allow Accessibility/);
    expect(screen.getByText('Open Settings')).toBeInTheDocument();
    // It does not pretend to record.
    expect(screen.queryByText(/Listening/)).not.toBeInTheDocument();
  });

  it('clears the Accessibility setup pill after the native grant changes', async () => {
    vi.useFakeTimers();
    try {
      mocks.holder.a11y = false;
      render(withI18n(<CaptureWidget />));

      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(/Allow Accessibility/)).toBeInTheDocument();

      mocks.holder.a11y = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });

      expect(screen.queryByText(/Allow Accessibility/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waveform bars move from the worklet mic frames', async () => {
    const { container } = render(withI18n(<CaptureWidget />));
    await startSession();
    expect(mocks.holder.onFrame).toBeTypeOf('function');

    // Feed ~5 frames of speech-level audio (≈100 ms at 20 ms/frame).
    for (let i = 0; i < 5; i++) mocks.holder.onFrame(new Float32Array(320).fill(0.5));

    await waitFor(() => {
      const bars = container.querySelectorAll('.capture-pill__wave-bar');
      expect(bars.length).toBe(12);
      const heights = [...bars].map((b) => parseInt(b.style.height, 10));
      expect(Math.max(...heights)).toBeGreaterThan(12); // above the silence floor
    });
  });

  // ── The pill must never strand ─────────────────────────────────────────
  // Errors deliberately do not auto-dismiss, so a failed paste keeps the
  // transcript on screen for the user to copy. But the mic / model-missing /
  // server / connection paths have NO transcript to rescue, and those left the
  // widget parked on top of everything until the app was restarted — reported
  // as "the dictation bubble is permanently sticking when it's not used".
  // The distinction is the whole fix, so both halves are pinned here.

  it('an error with nothing to rescue dismisses itself', async () => {
    // Start the session on REAL timers — startSession() awaits, and fake
    // timers would stall those awaits forever.
    const { container } = render(withI18n(<CaptureWidget />));
    const ws = await startSession();

    vi.useFakeTimers();
    try {
      // A server-side failure carrying no transcript.
      act(() => ws.msg({ type: 'error', kind: 'server', message: 'backend went away' }));
      expect(container.querySelector('.capture-pill')).not.toBeNull();

      // Long enough to read, then gone — without the user touching anything.
      await act(async () => {
        vi.advanceTimersByTime(9000);
      });
      expect(container.querySelector('.capture-pill')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error holding a transcript stays up — that text is the user's to copy", async () => {
    mocks.holder.paste = async () => {
      throw 'a11y: process is not trusted';
    };
    const { container } = render(withI18n(<CaptureWidget />));
    const ws = await startSession();

    // Drive to the error state on real timers so the paste rejection settles.
    act(() => ws.msg({ type: 'final', text: 'hello world' }));
    act(() => ws.msg({ type: 'final', text: 'hello world' }));
    await screen.findByText(/Accessibility access needed/);

    vi.useFakeTimers();
    try {
      // Well past the no-transcript dismissal window.
      await act(async () => {
        vi.advanceTimersByTime(30000);
      });
      // Still there: auto-dismissing would silently discard the only copy of
      // what the user just said.
      expect(container.querySelector('.capture-pill')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
