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
  wsUrl: (p) => `ws://test${p}`,
  apiFetch: vi.fn(async () => ({ json: async () => ({}) })),
}));
vi.mock('../pages/Transcriptions', () => ({ addTranscription: vi.fn() }));
vi.mock('../utils/copyText', () => ({ copyText: vi.fn(async () => {}) }));
vi.mock('react-hot-toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
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
});
