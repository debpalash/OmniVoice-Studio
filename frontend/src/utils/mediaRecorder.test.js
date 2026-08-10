import { describe, expect, it, vi } from 'vitest';

import { createSupportedMediaRecorder } from './mediaRecorder';

describe('createSupportedMediaRecorder', () => {
  it('uses an Ogg container when WebKit rejects WebM', () => {
    class OggRecorder {
      static isTypeSupported(type) {
        return type === 'audio/ogg';
      }

      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType;
      }
    }

    expect(createSupportedMediaRecorder({}, OggRecorder)).toMatchObject({
      mimeType: 'audio/ogg',
      extension: 'ogg',
    });
  });

  it('tries another container when a claimed codec fails construction', () => {
    const constructions = [];
    class WebKitRecorder {
      static isTypeSupported(type) {
        return type === 'audio/webm;codecs=opus' || type === 'audio/mp4';
      }

      constructor(_stream, options = {}) {
        constructions.push(options.mimeType || 'default');
        if (options.mimeType?.startsWith('audio/webm')) {
          throw new DOMException('unsupported', 'NotSupportedError');
        }
        this.mimeType = options.mimeType;
      }
    }

    expect(createSupportedMediaRecorder({}, WebKitRecorder)).toMatchObject({
      mimeType: 'audio/mp4',
      extension: 'm4a',
    });
    expect(constructions).toEqual(['audio/webm;codecs=opus', 'audio/mp4']);
  });

  it('returns null when MediaRecorder is absent or unusable', () => {
    expect(createSupportedMediaRecorder({}, undefined)).toBeNull();

    const Unsupported = vi.fn(() => {
      throw new DOMException('MediaRecorder is unsupported on this platform', 'NotSupportedError');
    });
    Unsupported.isTypeSupported = () => false;
    expect(createSupportedMediaRecorder({}, Unsupported)).toBeNull();
  });
});
