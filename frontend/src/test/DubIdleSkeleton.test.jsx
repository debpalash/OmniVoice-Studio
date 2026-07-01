import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

import IdleSkeleton from '../components/dub/IdleSkeleton';

// Regression guard for the Dub "transcribe-idle-desync" bug: on the
// URL-ingest (and restored-job) path there is no local `dubVideoFile`, so the
// waveform-overlay branch never runs. Before the fix, the no-file path handled
// only `uploading` and otherwise fell through to the idle dropzone — meaning
// while the pipeline was actively transcribing, the stepper showed
// Transcribe (active) but the main pane still showed the "Drop video here"
// dropzone + paste-URL input + "Pull YouTube captions" checkbox. The main
// view must instead reflect the pipeline stage on every ingest path.

const DROP_HINT = 'Drop video or audio here';
const URL_PLACEHOLDER = '…or paste YouTube / video URL';
const TRANSCRIBING = 'Transcribing with Whisper…';

function baseProps(overrides = {}) {
  const noop = vi.fn();
  return {
    t: i18n.t,
    dubVideoFile: null, // URL-ingest / restored job: no local File
    activeProjectName: '',
    dubFilename: '',
    dubError: '',
    dubJobId: null,
    dubStep: 'idle',
    dubFailure: null,
    handleDubRetryTranscribe: noop,
    handleDubImportSrt: noop,
    dubLocalBlobUrl: null,
    dubPrepStage: null,
    dubPrepProgress: { percent: null, speedBps: null, etaS: null, stageStartedAt: null },
    handleDubAbort: noop,
    transcribeElapsed: 7,
    dubDuration: 60,
    dubNumSpeakers: null,
    setDubNumSpeakers: noop,
    handleDubUpload: noop,
    demoDismissed: true, // skip DubbingDemo (network manifest) in the idle branch
    dismissDubDemo: noop,
    setDubVideoFile: noop,
    setDubInputType: noop,
    setDubStep: noop,
    fileToMediaUrl: noop,
    setDubLocalBlobUrl: noop,
    ingestUrl: '',
    setIngestUrl: noop,
    onIngestUrl: noop,
    fetchYtSubs: false,
    setFetchYtSubs: noop,
    dubLangCode: 'en',
    setDubLangCode: noop,
    setDubLang: noop,
    landingAdvOpen: false,
    setLandingAdvOpen: noop,
    dubInstruct: '',
    setDubInstruct: noop,
    ...overrides,
  };
}

function renderIdle(overrides) {
  return render(
    <I18nextProvider i18n={i18n}>
      <IdleSkeleton {...baseProps(overrides)} />
    </I18nextProvider>,
  );
}

describe('IdleSkeleton — pipeline-stage vs idle dropzone', () => {
  it('shows the idle dropzone only when the pipeline is truly idle (no job)', () => {
    const { container } = renderIdle({ dubStep: 'idle', dubJobId: null });
    expect(container.querySelector('.dub-idle-drop')).not.toBeNull();
    expect(screen.getByText(DROP_HINT)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toBeInTheDocument();
  });

  it('does NOT show the idle dropzone while transcribing a URL-ingested job', () => {
    const { container } = renderIdle({ dubStep: 'transcribing', dubJobId: 'job-url-1' });
    // The desync: dropzone + paste-URL input must be gone during transcribe.
    expect(container.querySelector('.dub-idle-drop')).toBeNull();
    expect(screen.queryByText(DROP_HINT)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(URL_PLACEHOLDER)).not.toBeInTheDocument();
    // …and the transcribe progress view is shown instead.
    expect(screen.getByText(TRANSCRIBING)).toBeInTheDocument();
  });

  it('does NOT show the idle dropzone while preparing a URL-ingested job', () => {
    const { container } = renderIdle({
      dubStep: 'uploading',
      dubJobId: 'job-url-2',
      dubPrepStage: 'download',
    });
    expect(container.querySelector('.dub-idle-drop')).toBeNull();
    expect(screen.queryByPlaceholderText(URL_PLACEHOLDER)).not.toBeInTheDocument();
  });

  it('never falls back to the dropzone for a non-idle no-file step (e.g. stopping)', () => {
    const { container } = renderIdle({ dubStep: 'stopping', dubJobId: 'job-url-3' });
    expect(container.querySelector('.dub-idle-drop')).toBeNull();
    expect(screen.queryByPlaceholderText(URL_PLACEHOLDER)).not.toBeInTheDocument();
  });
});
