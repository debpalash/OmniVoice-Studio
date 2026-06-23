import { describe, it, expect } from 'vitest';
import { isExpiredDubJobError } from '../hooks/useDubWorkflow.js';

describe('isExpiredDubJobError (#660 — stale dub session)', () => {
  it('matches the backend dub_core preflight message', () => {
    expect(isExpiredDubJobError(new Error(
      'Job not found. It may have been cleaned up or was never created.'
    ))).toBe(true);
  });

  it('matches the dub_generate expired-session message', () => {
    expect(isExpiredDubJobError(new Error(
      'This dub session has expired or was never created. Re-upload the video to start a new one.'
    ))).toBe(true);
  });

  it('matches a bare 404 "Job not found"', () => {
    expect(isExpiredDubJobError(new Error('Job not found'))).toBe(true);
  });

  it('does NOT match unrelated transcription failures (those stay reportable)', () => {
    expect(isExpiredDubJobError(new Error(
      'Transcribe stream dropped before emitting any segments.'
    ))).toBe(false);
    expect(isExpiredDubJobError(new Error('CUDA out of memory'))).toBe(false);
    expect(isExpiredDubJobError(new Error('aborted'))).toBe(false);
  });

  it('is null/shape safe', () => {
    expect(isExpiredDubJobError(null)).toBe(false);
    expect(isExpiredDubJobError(undefined)).toBe(false);
    expect(isExpiredDubJobError({})).toBe(false);
  });
});
