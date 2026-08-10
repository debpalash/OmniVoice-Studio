/**
 * Pick a microphone container the current WebView can actually encode.
 *
 * Chromium usually provides WebM/Opus; Safari and WebKitGTK commonly expose
 * MP4 or Ogg instead, and some WebKitGTK builds expose MediaRecorder while
 * rejecting every constructor. Callers must treat `null` as "use PCM".
 */
const AUDIO_TYPES = [
  ['audio/webm;codecs=opus', 'webm'],
  ['audio/webm', 'webm'],
  ['audio/ogg;codecs=opus', 'ogg'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
];

function extensionFor(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  return 'webm';
}

/**
 * @returns {{recorder: MediaRecorder, mimeType: string, extension: string}|null}
 */
export function createSupportedMediaRecorder(
  stream,
  Recorder = typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
) {
  if (typeof Recorder !== 'function') return null;

  const canProbe = typeof Recorder.isTypeSupported === 'function';
  for (const [mimeType, extension] of AUDIO_TYPES) {
    if (canProbe && !Recorder.isTypeSupported(mimeType)) continue;
    try {
      const recorder = new Recorder(stream, { mimeType });
      return {
        recorder,
        mimeType: recorder.mimeType || mimeType,
        extension,
      };
    } catch {
      // WebKitGTK may claim support but reject the constructor. Try the next
      // container, then the browser-selected default below.
    }
  }

  try {
    const recorder = new Recorder(stream);
    const mimeType = recorder.mimeType || 'audio/webm';
    return { recorder, mimeType, extension: extensionFor(mimeType) };
  } catch {
    return null;
  }
}
