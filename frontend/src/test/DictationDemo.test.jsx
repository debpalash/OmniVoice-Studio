import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

import DictationDemo from '../components/DictationDemo';

function withI18n(node) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}

describe('DictationDemo', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders the three bundled scripts', () => {
    render(withI18n(<DictationDemo />));
    expect(screen.getByText(/Schedule a meeting with Pat/)).toBeInTheDocument();
    expect(screen.getByText(/Patch the WebGPU shader/)).toBeInTheDocument();
    expect(screen.getByText(/réserver une table/)).toBeInTheDocument();
  });

  it('shows the "no hotkey" warning when outside Tauri', () => {
    render(withI18n(<DictationDemo />));
    // In jsdom, isTauri() returns false → state stays 'unknown' → warn badge.
    expect(screen.getByText(/No hotkey registered/i)).toBeInTheDocument();
  });

  it('hides the demo when the sample assets are missing (HEAD 404)', async () => {
    // The mount probe HEAD-checks the first sample; a 404 means no rendered
    // assets on disk → the whole demo should disappear rather than show cards
    // that fail on click.
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));
    const { container } = render(withI18n(<DictationDemo />));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText(/Schedule a meeting with Pat/)).not.toBeInTheDocument();
  });

  it('POSTs the bundled WAV to /transcribe when Replay is clicked', async () => {
    const wavBlob = new Blob([new Uint8Array([0, 0, 0, 0])], { type: 'audio/wav' });
    // Make the recognized text deliberately different from the on-card
    // script so we can assert the transcribed result appears in the UI.
    const RECOGNIZED = 'sentinel-recognized-payload-9421';
    global.fetch = vi.fn((url) => {
      if (String(url).endsWith('.wav')) {
        return Promise.resolve({ ok: true, blob: () => Promise.resolve(wavBlob) });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ text: RECOGNIZED, language: 'en' }),
      });
    });

    render(withI18n(<DictationDemo />));
    const replayButton = screen.getByLabelText(/Replay Conversational/i);
    fireEvent.click(replayButton);

    // Wait for both fetches to complete and the recognized text to render.
    // The full chain is: fetch(.wav) → fetch(/transcribe) → setState → render.
    await waitFor(
      () => {
        const calls = global.fetch.mock.calls;
        const wavCall = calls.find(c => String(c[0]).endsWith('.wav'));
        expect(wavCall).toBeTruthy();
      },
      { timeout: 3000 },
    );
    await waitFor(
      () => {
        const calls = global.fetch.mock.calls;
        expect(calls.find(c => String(c[0]).endsWith('/transcribe'))).toBeTruthy();
      },
      { timeout: 3000 },
    );
    await waitFor(
      () => expect(screen.getByText(RECOGNIZED)).toBeInTheDocument(),
      { timeout: 3000 },
    );

    const calls = global.fetch.mock.calls;
    const transcribeCall = calls.find(c => String(c[0]).endsWith('/transcribe'));
    expect(transcribeCall[1]?.method).toBe('POST');
  });
});
