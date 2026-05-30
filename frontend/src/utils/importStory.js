/**
 * Story import helpers — turn an uploaded file into plain text the editor can
 * auto-cast or split. Pure + testable; the component handles file reading.
 */

/** Strip SRT indices + timestamps, returning one cue's text per line. */
export function parseSrt(content) {
  const blocks = String(content || '').replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    const text = lines
      // Drop the cue index line (digits only) and the timestamp line. Use a
      // plain substring check for the SRT time arrow — a `/-->/` regex trips
      // CodeQL's js/bad-tag-filter (it mistakes it for HTML-comment filtering).
      .filter((l) => !/^\d+$/.test(l) && !l.includes('-->'))
      .join(' ')
      .trim();
    if (text) out.push(text);
  }
  return out.join('\n');
}

/** Convert an imported file's raw content → plain text, by extension. */
export function importToText(filename, content) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'srt') return parseSrt(content);
  // .txt and anything else: use as-is.
  return String(content || '');
}
