/**
 * Connect-time WS error vs. mic-graph setup race: a typed asr_model_missing
 * error frame can arrive while startRecording is still awaiting
 * startMicCapture. The error branch resolves the session (error pill, socket
 * closed, wsHadFinalRef latched) — startRecording's tail must then ABORT
 * instead of clobbering the error with setState('recording') + tray flag,
 * which (with the socket gone) stranded the next Stop on "Transcribing…".
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
    loading: vi.fn(),
  }),
}));
vi.mock('react-hot-toast', () => ({ default: toastMock, toast: toastMock }));

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => invokeMock(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ hide: async () => {} }),
}));

vi.mock('../api/client', () => ({
  wsUrl: (p) => `ws://test${p}`,
  apiFetch: vi.fn(),
}));
vi.mock('../pages/Transcriptions', () => ({ addTranscription: vi.fn() }));

const { toastAsrMock } = vi.hoisted(() => ({ toastAsrMock: vi.fn() }));
vi.mock('../utils/asrModelMissing', () => ({
  // Matches the real payload extraction for the WS frame shape.
  asrMissingPayload: (err) =>
    err && typeof err === 'object' && err.error === 'asr_model_missing' ? err : null,
  toastAsrModelMissing: toastAsrMock,
}));

// Deferred startMicCapture so each test controls WHEN (and HOW — resolve or
// reject) the mic graph finishes setting up relative to the WS error frame.
const { micControl, micStop } = vi.hoisted(() => ({
  micControl: { resolve: null, reject: null },
  micStop: vi.fn(async () => {}),
}));
vi.mock('../utils/aec/micCapture', () => ({
  startMicCapture: vi.fn(
    () =>
      new Promise((resolve, reject) => {
        micControl.resolve = resolve;
        micControl.reject = reject;
      }),
  ),
}));
vi.mock('../utils/aec/pcm', () => ({
  frameFromFloat: vi.fn(),
  floatToInt16: vi.fn(() => new Int16Array(0)),
  AEC_NEAR: 0,
  AEC_FAR: 1,
}));

// Sherpa live model selected → raw-PCM path (startMicCapture is awaited).
const storeState = {
  dictationEnabled: true,
  dictationMode: 'toggle',
  loadDictationPrefs: vi.fn(),
  aecEnabled: false,
  dictationModelId: 'sherpa-parakeet-v3',
};
vi.mock('../store', () => {
  const useAppStore = (sel) => sel(storeState);
  useAppStore.getState = () => storeState;
  return { useAppStore };
});

import CaptureWidget from '../components/CaptureWidget';

class FakeWS {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWS.CONNECTING;
    FakeWS.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
}

function pressShortcut() {
  fireEvent.keyDown(window, { code: 'Space', ctrlKey: true, shiftKey: true });
}

let realWebSocket;

beforeEach(() => {
  window.__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd) => {
    if (cmd === 'check_microphone') return 'granted';
    if (cmd === 'check_accessibility') return true;
    return undefined;
  });
  FakeWS.instances = [];
  storeState.dictationModelId = 'sherpa-parakeet-v3';
  realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  // jsdom has no MediaRecorder; only isTypeSupported is reached on the
  // raw-PCM (sherpa) path exercised here.
  globalThis.MediaRecorder = class {
    static isTypeSupported() {
      return false;
    }
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    configurable: true,
  });
});

afterEach(() => {
  globalThis.WebSocket = realWebSocket;
  delete globalThis.MediaRecorder;
  delete window.__TAURI_INTERNALS__;
  delete navigator.mediaDevices;
});

describe('CaptureWidget — connect-time asr_model_missing during mic setup', () => {
  it('turns a PCM-fallback socket failure into a terminal error', async () => {
    storeState.dictationModelId = 'whisperx';
    render(<CaptureWidget />);
    pressShortcut();

    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const ws = FakeWS.instances[0];
    ws.onerror?.(new Event('error'));
    ws.onclose?.();
    micControl.resolve(micStop);

    await waitFor(() => expect(screen.getByText(/Transcription failed/)).toBeInTheDocument());
    expect(invokeMock).not.toHaveBeenCalledWith('set_tray_recording', { recording: true });
  });

  it('keeps the error pill: no recording state, no tray flag, mic released', async () => {
    render(<CaptureWidget />);
    pressShortcut();

    // The socket opens before the mic worklet finishes setting up.
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const ws = FakeWS.instances[0];

    // Typed preflight error lands while startMicCapture is still pending.
    ws.onmessage({
      data: JSON.stringify({
        type: 'error',
        kind: 'asr_model_missing',
        error: 'asr_model_missing',
        message: 'no ASR model installed',
        recommended: { repo_id: 'x/y', label: 'Y', size_gb: 1 },
      }),
    });
    await waitFor(() => {
      expect(screen.getByText(/No speech-to-text model/)).toBeInTheDocument();
    });
    expect(toastAsrMock).toHaveBeenCalled();

    // Mic graph setup completes AFTER the error — the tail must abort:
    // release the worklet, keep the error state, never flip the tray on.
    micControl.resolve(micStop);
    await waitFor(() => expect(micStop).toHaveBeenCalled());

    expect(screen.getByText(/No speech-to-text model/)).toBeInTheDocument();
    expect(screen.queryByText(/Listening/)).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('set_tray_recording', { recording: true });
  });

  it('setup REJECTION after the terminal frame must not clobber it with a mic error', async () => {
    // #1175 review: the guard used to live only on the success path — a
    // startMicCapture rejection after the typed asr_model_missing frame
    // overwrote the truthful terminal state with a generic microphone error.
    toastMock.error.mockClear();
    render(<CaptureWidget />);
    pressShortcut();

    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const ws = FakeWS.instances[0];
    ws.onmessage({
      data: JSON.stringify({
        type: 'error',
        kind: 'asr_model_missing',
        error: 'asr_model_missing',
        message: 'no ASR model installed',
        recommended: { repo_id: 'x/y', label: 'Y', size_gb: 1 },
      }),
    });
    await waitFor(() => {
      expect(screen.getByText(/No speech-to-text model/)).toBeInTheDocument();
    });

    micControl.reject(Object.assign(new Error('mic exploded'), { name: 'NotReadableError' }));
    // Let the rejection propagate through startRecording's catch.
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText(/No speech-to-text model/)).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('set_tray_recording', { recording: true });
  });
});
