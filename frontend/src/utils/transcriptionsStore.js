/**
 * Single source of truth for the dictation-history localStorage store (#23).
 * Relocates the key/event consts + the reader that were duplicated across
 * Transcriptions.jsx and Projects.jsx. No version/rename/rewrite — the storage
 * contract (key, entry shape, 200-cap) is unchanged; this only de-dups the read.
 */
export const TRANSCRIPTIONS_KEY = 'omni_transcriptions';
export const TRANSCRIPTION_EVENT = 'omni:transcription-added';

/**
 * Read the transcription history. Never throws; always returns an array
 * (newest-first, as written). [] on absent/empty/malformed/non-array/blocked.
 * @returns {Array<object>}
 */
export function loadTranscriptions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TRANSCRIPTIONS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
