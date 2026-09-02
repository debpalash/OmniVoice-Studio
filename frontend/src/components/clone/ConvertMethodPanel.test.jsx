import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../WaveformPlayer', () => ({
  default: ({ src, source }) => (
    <div data-testid={`waveform-${source}`}>{typeof src === 'string' ? src : src.name}</div>
  ),
}));

// The shared voice picker pulls react-query + archetypes — reduce it to a
// plain <select> so the panel's own wiring is what's under test.
vi.mock('../VoiceSelector', () => ({
  default: ({ value, onChange, profiles }) => (
    <select
      aria-label="voice-selector"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  ),
}));

// Mic capture needs real getUserMedia — inert here.
vi.mock('../../hooks/useRecording', () => ({
  default: () => ({
    isRecording: false,
    isCleaning: false,
    recordingTime: 0,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

const convertSpeech = vi.fn();
vi.mock('../../api/convert', () => ({
  convertSpeech: (...args) => convertSpeech(...args),
}));

const toastAsrModelMissing = vi.fn();
vi.mock('../../utils/asrModelMissing', () => ({
  asrMissingPayload: (err) =>
    err?.detail?.error === 'asr_model_missing' ? err.detail : null,
  toastAsrModelMissing: (...args) => toastAsrModelMissing(...args),
}));

const toastError = vi.fn();
vi.mock('react-hot-toast', () => ({
  toast: { error: (...args) => toastError(...args) },
}));

import ConvertMethodPanel from './ConvertMethodPanel';

const t = (key) => key;
const profiles = [{ id: 'vp-1', name: 'Morgan' }];

function addSourceClip() {
  const file = new File(['wav-bytes'], 'source.wav', { type: 'audio/wav' });
  file.arrayBuffer = async () => new ArrayBuffer(8);
  fireEvent.change(document.getElementById('convert-audio-upload'), {
    target: { files: [file] },
  });
  return file;
}

beforeEach(() => {
  convertSpeech.mockReset();
  toastAsrModelMissing.mockReset();
  toastError.mockReset();
});

describe('ConvertMethodPanel', () => {
  it('keeps Convert disabled until a source clip AND a target voice are set', () => {
    render(<ConvertMethodPanel t={t} profiles={profiles} />);
    const button = screen.getByRole('button', { name: 'convert.convert' });
    expect(button).toBeDisabled();
    expect(screen.getByText('convert.need_source_and_voice')).toBeInTheDocument();

    addSourceClip();
    expect(button).toBeDisabled(); // still no voice

    fireEvent.change(screen.getByLabelText('voice-selector'), { target: { value: 'vp-1' } });
    expect(button).toBeEnabled();
    expect(screen.queryByText('convert.need_source_and_voice')).toBeNull();
  });

  it('previews the source clip with the shared waveform player', () => {
    render(<ConvertMethodPanel t={t} profiles={profiles} />);
    addSourceClip();
    expect(screen.getByTestId('waveform-convert-source')).toHaveTextContent('source.wav');
  });

  it('POSTs audio + profile_id + match_duration (default on) and shows the take', async () => {
    convertSpeech.mockResolvedValue({
      id: 'take0001',
      audio_url: '/audio/take0001.wav',
      text: 'hello there',
      duration_s: 1.4,
    });
    render(<ConvertMethodPanel t={t} profiles={profiles} />);
    addSourceClip();
    fireEvent.change(screen.getByLabelText('voice-selector'), { target: { value: 'vp-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));

    await waitFor(() => expect(screen.getByTestId('convert-result')).toBeInTheDocument());

    const fd = convertSpeech.mock.calls[0][0];
    expect(fd.get('profile_id')).toBe('vp-1');
    expect(fd.get('match_duration')).toBe('1');
    expect(fd.get('audio')).toBeInstanceOf(Blob);

    expect(screen.getByTestId('waveform-output').textContent).toContain('/audio/take0001.wav');
    expect(screen.getByText(/hello there/)).toBeInTheDocument();
  });

  it('sends match_duration=0 when the toggle is off', async () => {
    convertSpeech.mockResolvedValue({
      id: 't2',
      audio_url: '/audio/t2.wav',
      text: 'x',
      duration_s: 1,
    });
    render(<ConvertMethodPanel t={t} profiles={profiles} />);
    addSourceClip();
    fireEvent.change(screen.getByLabelText('voice-selector'), { target: { value: 'vp-1' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));

    await waitFor(() => expect(convertSpeech).toHaveBeenCalled());
    expect(convertSpeech.mock.calls[0][0].get('match_duration')).toBe('0');
  });

  it('routes the typed asr_model_missing 409 to the download CTA toast', async () => {
    const err = new Error('409');
    err.detail = { error: 'asr_model_missing', recommended: { repo_id: 'org/whisper' } };
    convertSpeech.mockRejectedValue(err);
    render(<ConvertMethodPanel t={t} profiles={profiles} />);
    addSourceClip();
    fireEvent.change(screen.getByLabelText('voice-selector'), { target: { value: 'vp-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));

    await waitFor(() => expect(toastAsrModelMissing).toHaveBeenCalledWith(err.detail));
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByTestId('convert-result')).toBeNull();
  });

  it('surfaces other backend errors as a plain error toast', async () => {
    convertSpeech.mockRejectedValue(new Error('503 Service Unavailable: [shutting_down]'));
    render(<ConvertMethodPanel t={t} profiles={profiles} />);
    addSourceClip();
    fireEvent.change(screen.getByLabelText('voice-selector'), { target: { value: 'vp-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'convert.convert' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        '503 Service Unavailable: [shutting_down]',
        expect.anything(),
      ),
    );
  });
});
