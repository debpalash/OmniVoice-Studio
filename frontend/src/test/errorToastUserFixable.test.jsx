// #1188: backend errors carrying a machine-readable "[code]" marker are
// user-fixable input problems, not bugs. toastErrorWithReport must map the
// [clone_ref_unusable] marker (emitted by omnivoice/utils/audio.py when a
// clone reference clip has genuinely no audio) to the localized guidance in
// tts_errors.ref_audio_unusable — a plain toast, no "Report this bug" action.
// Pins both halves of the cross-layer contract: the marker string and the
// i18n key existing in every locale.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { toastMock, toastErrorMock } = vi.hoisted(() => {
  const error = vi.fn();
  const mock = Object.assign(vi.fn(), { error, dismiss: vi.fn() });
  return { toastMock: mock, toastErrorMock: error };
});
vi.mock('react-hot-toast', () => ({ default: toastMock, toast: toastMock }));
vi.mock('i18next', () => ({ default: { t: (k) => `t:${k}` } }));
vi.mock('../api/external', () => ({ openExternal: vi.fn() }));
vi.mock('../utils/bugReport', () => ({ buildBugReportUrl: vi.fn() }));

import { toastErrorWithReport } from '../utils/errorToast';

const BACKEND_ERROR =
  '400 Bad Request: [clone_ref_unusable] Reference audio has no usable sound — ' +
  'the clip is empty or completely silent, so there is no voice to clone.';

describe('toastErrorWithReport user-fixable marker mapping (#1188)', () => {
  beforeEach(() => {
    toastErrorMock.mockClear();
  });

  it('shows the localized guidance for [clone_ref_unusable] instead of the raw detail', () => {
    toastErrorWithReport(`Error: ${BACKEND_ERROR}`, new Error(BACKEND_ERROR));
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('t:tts_errors.ref_audio_unusable', {
      duration: 8000,
    });
  });

  it('matches the marker even when only the message string carries it', () => {
    toastErrorWithReport(`Error: ${BACKEND_ERROR}`, undefined);
    expect(toastErrorMock).toHaveBeenCalledWith('t:tts_errors.ref_audio_unusable', {
      duration: 8000,
    });
  });

  it('unmarked errors keep the Report-action toast (JSX renderer, not a plain string)', () => {
    toastErrorWithReport('Error: something exploded', new Error('something exploded'));
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(typeof toastErrorMock.mock.calls[0][0]).toBe('function');
  });

  it('tts_errors.ref_audio_unusable exists (non-empty) in every locale', () => {
    const localesDir = path.resolve(__dirname, '../i18n/locales');
    const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(21);
    for (const f of files) {
      const locale = JSON.parse(fs.readFileSync(path.join(localesDir, f), 'utf8'));
      expect(locale.tts_errors?.ref_audio_unusable, `${f} missing the key`).toBeTruthy();
    }
  });
});

// #1276: a 503 is "not now, try again" — a shutting-down or still-warming
// backend. Quitting the app with a generate queued used to answer 500 and
// offer to file a GitHub issue for what is a normal lifecycle event. The
// backend now answers 503 with an actionable detail; the toast must show it
// without the Report action.
describe('toastErrorWithReport transient-status handling (#1276)', () => {
  beforeEach(() => {
    toastErrorMock.mockClear();
  });

  const shuttingDown = () => {
    const e = new Error(
      "OmniVoice is shutting down, so it didn't start loading the model. " +
        'Reopen the app and try again.',
    );
    e.name = 'ApiError';
    e.status = 503;
    return e;
  };

  it('shows a plain toast for a 503, with no Report action', () => {
    const err = shuttingDown();
    toastErrorWithReport(err.message, err);

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const [body, opts] = toastErrorMock.mock.calls[0];
    // A plain string, not the JSX render-prop that carries the Report button.
    expect(typeof body).toBe('string');
    expect(body).toContain('Reopen the app');
    expect(opts).toEqual({ duration: 8000 });
  });

  it('still offers Report for a genuine 500', () => {
    const err = new Error('500 Internal Server Error: something actually broke');
    err.name = 'ApiError';
    err.status = 500;
    toastErrorWithReport(err.message, err);

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    // The reportable path passes a render function, not a string.
    expect(typeof toastErrorMock.mock.calls[0][0]).toBe('function');
  });

  it('still offers Report when there is no status at all', () => {
    toastErrorWithReport('Something broke', new Error('Something broke'));
    expect(typeof toastErrorMock.mock.calls[0][0]).toBe('function');
  });
});
