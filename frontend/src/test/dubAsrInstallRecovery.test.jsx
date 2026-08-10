import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';

const dubApi = vi.hoisted(() => ({
  dubUpload: vi.fn(),
  dubIngestUrl: vi.fn(),
  dubAbort: vi.fn(),
  dubCleanupSegments: vi.fn(),
  dubTranslate: vi.fn(),
  dubGenerate: vi.fn(),
  tasksStreamUrl: vi.fn(() => '/tasks'),
  tasksCancel: vi.fn(),
  transcribeStreamUrl: vi.fn((jobId) => `/transcribe/${jobId}`),
  dubImportSrt: vi.fn(),
}));
vi.mock('../api/dub', () => dubApi);

const setupApi = vi.hoisted(() => ({
  installModel: vi.fn(),
  listModels: vi.fn(),
  cancelInstallModel: vi.fn(),
}));
vi.mock('../api/setup', () => ({
  ...setupApi,
  setupDownloadStreamUrl: () => '/setup/download-stream',
}));

vi.mock('../api/client', () => ({
  apiPost: vi.fn(),
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  API: '',
}));

import useDubWorkflow from '../hooks/useDubWorkflow';

const baseState = useAppStore.getState();
let streams;

class FakeEventSource {
  static CLOSED = 2;

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = new Map();
    streams.push(this);
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(name, data = {}) {
    const event = { data: JSON.stringify(data) };
    if (name === 'message') this.onmessage?.(event);
    else this.listeners.get(name)?.(event);
  }
}

function renderWorkflow() {
  return renderHook(() =>
    useDubWorkflow({
      loadProjects: vi.fn(),
      loadProfiles: vi.fn(),
      loadDubHistory: vi.fn(),
      setLastGenFingerprints: vi.fn(),
    }),
  );
}

describe('Dubbing missing-ASR recovery', () => {
  beforeEach(() => {
    streams = [];
    globalThis.EventSource = FakeEventSource;
    useAppStore.setState(baseState, true);
    useAppStore.setState({ dubJobId: 'job-kept-for-retry', dubStep: 'idle' });
    setupApi.installModel.mockReset().mockResolvedValue({ status: 'install_started' });
    setupApi.listModels.mockReset().mockResolvedValue({ models: [] });
  });

  it('keeps the job, installs inline, then automatically retranscribes it', async () => {
    const { result } = renderWorkflow();
    let firstAttempt;
    act(() => {
      firstAttempt = result.current.handleDubRetryTranscribe();
    });
    streams[0].emit('error', {
      error: 'asr_model_missing',
      detail: 'No speech-to-text model is installed.',
      recommended: {
        repo_id: 'Systran/faster-whisper-large-v3',
        label: 'Whisper large-v3',
        size_gb: 2.9,
      },
    });
    await act(async () => firstAttempt);

    expect(result.current.asrInstall).toMatchObject({
      phase: 'missing',
      repoId: 'Systran/faster-whisper-large-v3',
    });
    expect(useAppStore.getState().dubJobId).toBe('job-kept-for-retry');

    let recovery;
    act(() => {
      recovery = result.current.handleInstallMissingAsr();
    });
    await waitFor(() => expect(setupApi.installModel).toHaveBeenCalledOnce());
    streams[1].emit('message', {
      repo_id: 'Systran/faster-whisper-large-v3',
      phase: 'install_done',
    });

    await waitFor(() => expect(streams).toHaveLength(3));
    expect(streams[2].url).toContain('/transcribe/job-kept-for-retry');
    streams[2].emit('final', { segments: [{ id: '1', text: 'hello' }] });
    streams[2].emit('done');
    await act(async () => recovery);

    expect(useAppStore.getState().dubStep).toBe('editing');
    expect(result.current.asrInstall).toBeNull();
  });
});
