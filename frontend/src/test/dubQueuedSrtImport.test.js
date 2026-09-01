import { describe, expect, it } from 'vitest';

import { shouldQueueSrtImport } from '../hooks/useDubWorkflow';
import workflowSource from '../hooks/useDubWorkflow?raw';

describe('SRT import during source-speaker analysis', () => {
  it('queues during preparation and transcription, then applies after analysis', () => {
    expect(shouldQueueSrtImport('uploading')).toBe(true);
    expect(shouldQueueSrtImport('transcribing')).toBe(true);
    expect(shouldQueueSrtImport('transcribing', true)).toBe(false);
    expect(shouldQueueSrtImport('editing')).toBe(false);
  });

  it('applies the queued file after both upload and URL transcription paths finish', () => {
    expect(workflowSource.match(/await importSrtRef\.current\?\./g)).toHaveLength(2);
    for (const [handler, nextHandler] of [
      ['handleDubUpload', 'handleDubIngestUrl'],
      ['handleDubIngestUrl', 'handleDubAbort'],
    ]) {
      const start = workflowSource.indexOf(`const ${handler} =`);
      const end = workflowSource.indexOf(`const ${nextHandler} =`, start + 20);
      const body = workflowSource.slice(start, end);
      expect(body.indexOf('await _waitForTranscribe')).toBeGreaterThan(-1);
      expect(body.indexOf('await importSrtRef.current')).toBeGreaterThan(
        body.indexOf('await _waitForTranscribe'),
      );
    }
  });
});
