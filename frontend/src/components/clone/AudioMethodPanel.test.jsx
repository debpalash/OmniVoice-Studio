import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../WaveformPlayer', () => ({
  default: ({ src }) => <div data-testid="reference-waveform">{src.name}</div>,
}));

import AudioMethodPanel from './AudioMethodPanel';

const baseProps = {
  t: (key) => key,
  selectedProfile: null,
  setSelectedProfile: vi.fn(),
  profiles: [],
  ingestRefAudio: vi.fn(),
  isCleaning: false,
  isRecording: false,
  recordingTime: 0,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  refText: '',
  setRefText: vi.fn(),
  instruct: '',
  setInstruct: vi.fn(),
  defineMethod: 'audio',
  designSeed: null,
  setDesignSeed: vi.fn(),
  keepSeed: false,
  setKeepSeed: vi.fn(),
  showSaveProfile: false,
  setShowSaveProfile: vi.fn(),
  profileName: '',
  setProfileName: vi.fn(),
  handleSaveProfile: vi.fn(),
};

describe('AudioMethodPanel', () => {
  it('previews the cleaned reference with the shared waveform player', () => {
    const refAudio = new File(['clean'], 'recording_clean.wav', { type: 'audio/wav' });
    render(<AudioMethodPanel {...baseProps} refAudio={refAudio} />);

    expect(screen.getByTestId('reference-waveform')).toHaveTextContent('recording_clean.wav');
  });
});
