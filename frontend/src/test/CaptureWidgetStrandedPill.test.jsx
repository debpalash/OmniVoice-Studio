/**
 * The dictation widget must never sit on screen with nothing in it.
 *
 * Visibility is decided in Rust — `lib.rs` shows the `widget` window on the
 * global shortcut and *then* emits `tray-dictate` — while the content is
 * decided in CaptureWidget. Nothing kept the two in agreement, and three
 * defects compounded into one very visible bug:
 *
 *   1. The tray listener's effect depended on `[state]`, so every state change
 *      tore the Tauri subscription down and re-attached it across an
 *      `await import()` + `await listen()`. A shortcut press landing in that
 *      gap was simply lost.
 *   2. `state === 'idle'` renders null, so a window shown for a lost press had
 *      no pill in it — and `body`'s opaque chrome background (index.css) made
 *      the empty window a hard-edged dark square rather than nothing at all.
 *   3. `dismiss()` was the only path that hid the window, and it is reachable
 *      only from the X button, Esc, or a post-session timer. None of those can
 *      fire for a session that never started — the X isn't rendered, and Esc
 *      never arrives because the widget refuses focus on macOS/Windows
 *      (#287, #982). The square was unrecoverable.
 *
 * These tests pin the two invariants that make the class impossible: the tray
 * listener subscribes exactly once for the component's lifetime, and an idle
 * widget window reconciles itself to hidden.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

const mocks = vi.hoisted(() => {
  const state = {
    dictationEnabled: true,
    dictationMode: 'toggle',
    dictationModelId: 'sherpa-parakeet-tdt-v3',
    aecEnabled: false,
    loadDictationPrefs: () => {},
  };
  const holder = {
    a11y: true,
    // Handlers captured from `listen()`, keyed by event name.
    handlers: {},
    listenCalls: [],
    hide: vi.fn(async () => {}),
    isVisible: vi.fn(async () => true),
    label: 'widget',
  };
  return { state, holder };
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
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd) => {
    if (cmd === 'check_accessibility') return mocks.holder.a11y;
    return undefined;
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, fn) => {
    mocks.holder.listenCalls.push(name);
    mocks.holder.handlers[name] = fn;
    return () => {};
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    get label() {
      return mocks.holder.label;
    },
    hide: mocks.holder.hide,
    isVisible: mocks.holder.isVisible,
  }),
}));
vi.mock('../utils/aec/micCapture', () => ({
  startMicCapture: async () => async () => {},
}));

import CaptureWidget from '../components/CaptureWidget';

const renderWidget = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <CaptureWidget />
    </I18nextProvider>,
  );

beforeEach(() => {
  window.__TAURI_INTERNALS__ = {};
  mocks.holder.handlers = {};
  mocks.holder.listenCalls = [];
  mocks.holder.hide.mockClear();
  mocks.holder.isVisible.mockClear();
  mocks.holder.isVisible.mockImplementation(async () => true);
  mocks.holder.a11y = true;
  mocks.holder.label = 'widget';
  mocks.state.dictationEnabled = true;
  mocks.state.dictationMode = 'toggle';
});

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('tray listener stability', () => {
  it('subscribes exactly once even after the pill changes state', async () => {
    // A denied Accessibility probe drives state idle → 'setup' on mount, which
    // is a real state transition. With the old `[state]` dependency this tore
    // the subscription down and re-listened, doubling the counts — and leaving
    // a window with no listener attached in between, which is where presses
    // were lost.
    mocks.holder.a11y = false;
    renderWidget();

    await waitFor(() => {
      expect(mocks.holder.handlers['tray-dictate']).toBeTypeOf('function');
    });
    // Let the state transition settle.
    await act(async () => {
      await Promise.resolve();
    });

    const starts = mocks.holder.listenCalls.filter((n) => n === 'tray-dictate');
    const stops = mocks.holder.listenCalls.filter((n) => n === 'tray-dictate-stop');
    expect(starts).toHaveLength(1);
    expect(stops).toHaveLength(1);
  });
});

describe('the widget window never strands empty', () => {
  it('hides itself when a press arrives while dictation is disabled', async () => {
    // Rust shows the window before it emits, and the emit is unconditional —
    // it does not know the toggle is off. If the handler just returns, the
    // window stays up with an idle (null-rendering) pill in it.
    mocks.state.dictationEnabled = false;
    renderWidget();

    await waitFor(() => {
      expect(mocks.holder.handlers['tray-dictate']).toBeTypeOf('function');
    });
    await act(async () => {
      mocks.holder.handlers['tray-dictate']();
      await Promise.resolve();
    });

    expect(mocks.holder.hide).toHaveBeenCalled();
  });

  it('reconciles a visible-but-idle widget window to hidden', async () => {
    vi.useFakeTimers();
    renderWidget();

    // Nothing has happened yet — the grace period must not have elapsed.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(mocks.holder.hide).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.holder.isVisible).toHaveBeenCalled();
    expect(mocks.holder.hide).toHaveBeenCalled();
  });

  it('leaves an already-hidden window alone', async () => {
    vi.useFakeTimers();
    mocks.holder.isVisible.mockImplementation(async () => false);
    renderWidget();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.holder.isVisible).toHaveBeenCalled();
    expect(mocks.holder.hide).not.toHaveBeenCalled();
  });

  it('never hides the main window — only the standalone widget owns visibility', async () => {
    // The same component also renders as an in-app pill inside the main
    // window, where hiding the window would take the whole app off screen.
    vi.useFakeTimers();
    mocks.holder.label = 'main';
    renderWidget();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.holder.hide).not.toHaveBeenCalled();
  });
});
