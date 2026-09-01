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
  tasksStreamUrl: vi.fn((taskId) => `/tasks/${taskId}`),
  tasksCancel: vi.fn(),
  transcribeStreamUrl: vi.fn((jobId) => `/transcribe/${jobId}`),
  dubImportSrt: vi.fn(),
}));
vi.mock('../api/dub', () => ({
  ...dubApi,
  DUB_COOKIE_TRANSPORT_ERROR: 'cookie_transport_error',
  DUB_COOKIE_SIZE_ERROR: 'cookie_size_error',
}));

const setupApi = vi.hoisted(() => ({
  cancelInstallModel: vi.fn(),
}));
vi.mock('../api/setup', () => ({
  ...setupApi,
  installModel: vi.fn(),
  listModels: vi.fn(),
  setupDownloadStreamUrl: () => '/setup/download-stream',
}));

vi.mock('../api/client', () => ({
  apiPost: vi.fn(),
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  API: '',
}));

import useDubWorkflow, { shouldQueueSrtImport } from '../hooks/useDubWorkflow';

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

describe('SRT import during source-speaker analysis', () => {
  beforeEach(() => {
    streams = [];
    globalThis.EventSource = FakeEventSource;
    useAppStore.setState(baseState, true);
    useAppStore.setState({ dubJobId: '', dubStep: 'idle', dubSegments: [] });
    for (const mock of Object.values(dubApi)) mock.mockReset?.();
    dubApi.tasksStreamUrl.mockImplementation((taskId) => `/tasks/${taskId}`);
    dubApi.transcribeStreamUrl.mockImplementation((jobId) => `/transcribe/${jobId}`);
    dubApi.dubAbort.mockResolvedValue({});
    dubApi.dubImportSrt.mockResolvedValue({
      segments: [{ id: 'srt', text: 'selected subtitle' }],
      stats: { imported: 1 },
    });
    setupApi.cancelInstallModel.mockReset().mockResolvedValue({});
  });

  it('queues only while source analysis is incomplete', () => {
    expect(shouldQueueSrtImport('uploading')).toBe(true);
    expect(shouldQueueSrtImport('transcribing')).toBe(true);
    expect(shouldQueueSrtImport('transcribing', true)).toBe(false);
    expect(shouldQueueSrtImport('editing')).toBe(false);
  });

  it.each([
    ['upload', 'job-upload'],
    ['URL ingest', 'job-url'],
  ])('applies the selected file after %s analysis completes', async (source, jobId) => {
    const file = new File(['subtitle'], 'selected.srt');
    const { result } = renderWorkflow();
    let operation;

    if (source === 'upload') {
      dubApi.dubUpload.mockResolvedValue({ job_id: jobId, task_id: `prep-${jobId}` });
      act(() => {
        operation = result.current.handleDubUpload(new File(['video'], 'source.mp4'));
      });
    } else {
      dubApi.dubIngestUrl.mockResolvedValue({ job_id: jobId, task_id: `prep-${jobId}` });
      act(() => {
        operation = result.current.handleDubIngestUrl('https://example.test/video');
      });
    }

    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].emit('message', { type: 'ready' }));
    await waitFor(() => expect(useAppStore.getState().dubStep).toBe('transcribing'));
    await act(async () => result.current.handleDubImportSrt(file));
    expect(dubApi.dubImportSrt).not.toHaveBeenCalled();

    await waitFor(() => expect(streams).toHaveLength(2));
    act(() => {
      streams[1].emit('final', { segments: [{ id: 'asr', text: 'generated' }] });
      streams[1].emit('done');
    });
    await act(async () => operation);

    expect(dubApi.dubImportSrt).toHaveBeenCalledWith(jobId, file, {
      signal: expect.any(AbortSignal),
    });
    expect(useAppStore.getState().dubSegments).toEqual([
      expect.objectContaining({ id: 'srt', text: 'selected subtitle' }),
    ]);
    expect(useAppStore.getState().dubStep).toBe('editing');
  });

  it('retains the queued file through transcription and import failures until retry succeeds', async () => {
    useAppStore.setState({ dubJobId: 'job-retry', dubStep: 'transcribing' });
    const file = new File(['subtitle'], 'retry.srt');
    dubApi.dubImportSrt
      .mockRejectedValueOnce(new Error('SRT import failed'))
      .mockResolvedValueOnce({
        segments: [{ id: 'srt', text: 'selected subtitle' }],
        stats: { imported: 1 },
      });
    const { result } = renderWorkflow();
    await act(async () => result.current.handleDubImportSrt(file));

    let failedAttempt;
    act(() => {
      failedAttempt = result.current.handleDubRetryTranscribe();
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].emit('error', { detail: 'transcription failed' }));
    await act(async () => failedAttempt);
    expect(dubApi.dubImportSrt).not.toHaveBeenCalled();

    let importFailure;
    act(() => {
      importFailure = result.current.handleDubRetryTranscribe();
    });
    await waitFor(() => expect(streams).toHaveLength(2));
    act(() => {
      streams[1].emit('final', { segments: [{ id: 'asr', text: 'generated' }] });
      streams[1].emit('done');
    });
    await act(async () => importFailure);

    expect(dubApi.dubImportSrt).toHaveBeenCalledOnce();
    expect(useAppStore.getState().dubError).toBe('SRT import failed');
    expect(useAppStore.getState().dubStep).toBe('editing');

    let successfulRetry;
    act(() => {
      successfulRetry = result.current.handleDubRetryTranscribe();
    });
    await waitFor(() => expect(streams).toHaveLength(3));
    act(() => {
      streams[2].emit('final', { segments: [{ id: 'asr', text: 'generated again' }] });
      streams[2].emit('done');
    });
    await act(async () => successfulRetry);

    expect(dubApi.dubImportSrt).toHaveBeenLastCalledWith('job-retry', file, {
      signal: expect.any(AbortSignal),
    });
    expect(dubApi.dubImportSrt).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().dubSegments[0].text).toBe('selected subtitle');
  });

  it('aborts a deferred import without applying its result', async () => {
    const file = new File(['subtitle'], 'abort.srt');
    dubApi.dubUpload.mockResolvedValue({ job_id: 'job-abort', task_id: 'prep-abort' });
    dubApi.dubImportSrt.mockImplementation(
      (_jobId, _file, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );
    const { result } = renderWorkflow();
    let upload;
    act(() => {
      upload = result.current.handleDubUpload(new File(['video'], 'source.mp4'));
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].emit('message', { type: 'ready' }));
    await waitFor(() => expect(useAppStore.getState().dubStep).toBe('transcribing'));
    await act(async () => result.current.handleDubImportSrt(file));
    await waitFor(() => expect(streams).toHaveLength(2));
    act(() => {
      streams[1].emit('final', { segments: [{ id: 'asr', text: 'generated' }] });
      streams[1].emit('done');
    });
    await waitFor(() => expect(dubApi.dubImportSrt).toHaveBeenCalledOnce());

    await act(async () => result.current.handleDubAbort());
    await act(async () => upload);

    expect(useAppStore.getState().dubSegments[0].text).toBe('generated');
    expect(useAppStore.getState().dubStep).toBe('idle');
  });

  it('ignores a completed import after another job replaces it', async () => {
    useAppStore.setState({ dubJobId: 'job-old', dubStep: 'editing', dubSegments: [] });
    let resolveImport;
    dubApi.dubImportSrt.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );
    const { result } = renderWorkflow();
    let importOperation;
    act(() => {
      importOperation = result.current.handleDubImportSrt(new File(['subtitle'], 'old.srt'));
    });
    await waitFor(() => expect(dubApi.dubImportSrt).toHaveBeenCalledOnce());
    act(() => useAppStore.setState({ dubJobId: 'job-new', dubSegments: [] }));
    resolveImport({ segments: [{ id: 'stale', text: 'stale subtitle' }] });
    await act(async () => importOperation);

    expect(useAppStore.getState().dubJobId).toBe('job-new');
    expect(useAppStore.getState().dubSegments).toEqual([]);
  });
});
