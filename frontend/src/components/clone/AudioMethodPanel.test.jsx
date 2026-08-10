import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../WaveformPlayer', () => ({
  default: ({ src }) => <div data-testid="reference-waveform">{src.name}</div>,
}));

import AudioMethodPanel from './AudioMethodPanel';
import { createInputLevelStore } from '../../utils/audioInput';

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
  audioInputs: [
    { deviceId: 'built-in', label: 'Built-in microphone' },
    { deviceId: 'usb', label: '' },
  ],
  selectedAudioInputId: '',
  setSelectedAudioInputId: vi.fn(),
  channelMode: 'auto',
  setChannelMode: vi.fn(),
  inputLevelStore: createInputLevelStore(),
};

describe('AudioMethodPanel', () => {
  it('previews the cleaned reference with the shared waveform player', () => {
    const refAudio = new File(['clean'], 'recording_clean.wav', { type: 'audio/wav' });
    render(<AudioMethodPanel {...baseProps} refAudio={refAudio} />);

    expect(screen.getByTestId('reference-waveform')).toHaveTextContent('recording_clean.wav');
  });

  it('selects an input device and channel mode', async () => {
    const setDevice = vi.fn();
    const setChannels = vi.fn();
    render(
      <AudioMethodPanel
        {...baseProps}
        setSelectedAudioInputId={setDevice}
        setChannelMode={setChannels}
      />,
    );

    fireEvent.change(screen.getByLabelText('recording.input_device'), {
      target: { value: 'built-in' },
    });
    fireEvent.change(screen.getByLabelText('recording.channels'), { target: { value: 'mono' } });
    expect(setDevice).toHaveBeenCalledWith('built-in');
    expect(setChannels).toHaveBeenCalledWith('mono');
    expect(screen.getByRole('option', { name: 'recording.microphone_number' })).toBeInTheDocument();
  });

  it('shows whether live microphone input is detected', () => {
    const inputLevelStore = createInputLevelStore(0.01);
    render(<AudioMethodPanel {...baseProps} isRecording inputLevelStore={inputLevelStore} />);
    expect(screen.getByText('recording.no_input_detected')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'recording.input_level' })).toHaveValue(0.01);

    act(() => inputLevelStore.set(0.3));
    expect(screen.getByText('recording.input_detected')).toBeInTheDocument();
  });
});
