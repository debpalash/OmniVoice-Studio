import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Keep toast side-channels out of the test (timers, portals).
vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock('../../api/engines', () => ({
  listEngines: vi.fn(),
  selectEngine: vi.fn(),
  getEngineHealth: vi.fn(),
  selfTestEngine: vi.fn(),
}));

import { listEngines, selectEngine } from '../../api/engines';
import EnginesTab from './EnginesTab';

function entry(id, name) {
  return {
    id,
    display_name: name,
    available: true,
    reason: null,
    install_hint: null,
    last_error: null,
    isolation_mode: 'in-process',
    gpu_compat: ['cpu'],
  };
}

const ENGINES = {
  tts: { active: 'omnivoice', backends: [entry('omnivoice', 'OmniVoice (test)')] },
  asr: {
    active: 'whisperx',
    backends: [
      entry('whisperx', 'WhisperX (test)'),
      entry('openai-compat-asr', 'OpenAI-compatible ASR (test)'),
    ],
  },
  llm: { active: 'off', backends: [entry('off', 'Off (test)')] },
};

describe('EnginesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listEngines.mockResolvedValue(ENGINES);
  });

  it('renders a pinned picker per family — TTS, ASR and LLM all visible at once', async () => {
    render(<EnginesTab />);
    await waitFor(() => screen.getByText('WhisperX (test)'));

    // One named section per family (the ASR picker used to be tucked behind
    // a family tab inside a single TTS-titled matrix — no picker to find).
    expect(screen.getByText('TTS Engines')).toBeInTheDocument();
    expect(screen.getByText('ASR Engines')).toBeInTheDocument();
    expect(screen.getByText('LLM Engines')).toBeInTheDocument();
    // Pinned matrices render no family switcher.
    expect(document.querySelector('.engine-matrix__tab-family')).toBeNull();
  });

  it('the stacked matrices share one GET /engines on mount', async () => {
    render(<EnginesTab />);
    await waitFor(() => screen.getByText('WhisperX (test)'));
    expect(listEngines).toHaveBeenCalledTimes(1);
  });

  it('clicking Use on an ASR engine selects it with family="asr"', async () => {
    selectEngine.mockResolvedValue({
      family: 'asr',
      active: 'openai-compat-asr',
      env_override: false,
      routing_status: 'cpu_only',
      effective_device: 'cpu',
      routing_reason: null,
    });
    render(<EnginesTab />);
    await waitFor(() => screen.getByText('OpenAI-compatible ASR (test)'));

    fireEvent.click(screen.getByRole('button', { name: /use openai-compatible asr \(test\)/i }));
    await waitFor(() => {
      expect(selectEngine).toHaveBeenCalledWith('asr', 'openai-compat-asr', undefined);
    });
  });
});
