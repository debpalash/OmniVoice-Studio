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
  installSidecarEngine: vi.fn(),
  getSidecarInstallStatus: vi.fn(),
}));

// Residency layer (/model/loaded) — mocked so the matrix never hits the
// network in tests; the single-probe behavior is asserted below.
vi.mock('../../api/system', () => ({
  listLoadedModels: vi.fn(),
  unloadLoadedModel: vi.fn(),
}));

import { listEngines, selectEngine } from '../../api/engines';
import { listLoadedModels } from '../../api/system';
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

/** Click the family tab whose label text is `label` (TTS / ASR / LLM). */
function clickFamilyTab(label) {
  const tab = Array.from(document.querySelectorAll('.engine-matrix__tab-family')).find(
    (el) => el.textContent === label,
  );
  expect(tab).toBeTruthy();
  fireEvent.click(tab.closest('button'));
}

describe('EnginesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listEngines.mockResolvedValue(ENGINES);
    listLoadedModels.mockResolvedValue({ models: [], count: 0 });
  });

  it('renders ONE tabbed section — TTS/ASR/LLM tab strip, one family at a time', async () => {
    render(<EnginesTab />);
    await waitFor(() => screen.getByText('OmniVoice (test)'));

    // One settings card, not three stacked per-family matrices.
    expect(document.querySelectorAll('[data-slot="settings-section"]').length).toBe(1);
    // The tab strip offers all three families (with the active engine caption).
    expect(document.querySelectorAll('.engine-matrix__tab-family').length).toBe(3);
    // Only the selected family's engines are on screen.
    expect(screen.queryByText('WhisperX (test)')).not.toBeInTheDocument();
    expect(screen.queryByText('Off (test)')).not.toBeInTheDocument();
  });

  it('switching to the ASR tab shows ASR engines without refetching /engines', async () => {
    render(<EnginesTab />);
    await waitFor(() => screen.getByText('OmniVoice (test)'));

    clickFamilyTab('ASR');
    await waitFor(() => screen.getByText('WhisperX (test)'));
    expect(screen.getByText('OpenAI-compatible ASR (test)')).toBeInTheDocument();
    expect(screen.queryByText('OmniVoice (test)')).not.toBeInTheDocument();
    // Tab switches re-slice the already-fetched payload — no second request.
    expect(listEngines).toHaveBeenCalledTimes(1);
  });

  it('fetches GET /engines exactly once on mount', async () => {
    render(<EnginesTab />);
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    expect(listEngines).toHaveBeenCalledTimes(1);
  });

  it('probes GET /model/loaded exactly once on mount', async () => {
    render(<EnginesTab />);
    await waitFor(() => screen.getByText('OmniVoice (test)'));
    await waitFor(() => expect(listLoadedModels).toHaveBeenCalled());
    expect(listLoadedModels).toHaveBeenCalledTimes(1);
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
    await waitFor(() => screen.getByText('OmniVoice (test)'));

    clickFamilyTab('ASR');
    await waitFor(() => screen.getByText('OpenAI-compatible ASR (test)'));

    fireEvent.click(screen.getByRole('button', { name: /use openai-compatible asr \(test\)/i }));
    await waitFor(() => {
      expect(selectEngine).toHaveBeenCalledWith('asr', 'openai-compat-asr', undefined);
    });
  });
});
