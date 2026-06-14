import { isChapterLine, chapterTitle } from './storyExport';
import { effectiveProfile } from './storyCast';
import { parseChapterBody } from './longformParser';

/**
 * Compile the Stories Editor's cast + ordered lines into the chapter/span plan
 * the shared `/longform/render` endpoint consumes — the bridge that lets a
 * multi-voice story render on the same server-side pipeline as an audiobook
 * (resume, loudness, cover, chapter markers).
 *
 * The track→canonical adapter (#27): per-track cast voice + speed are resolved
 * here, then the track's text runs through the ONE canonical voice→pause→SSML
 * layering (`parseChapterBody`) — the same code the Python parser uses. The
 * adapter, not the canonical parser, owns the two track-shaped concerns:
 *  - a `#`-line *inside* a track's text must NOT re-chapter (we call
 *    parseChapterBody, which never chapter-splits, not parseScriptToSpans);
 *  - a track's *leading* pause folds into the previous track's last span
 *    (cross-track fold) — but a mid-track silent span (from `[voice:x][pause]`)
 *    is kept, matching the server's single-blob behavior.
 *
 * @returns Array<{ title, spans: [{ voice_id, text, pause_ms_after, speed }] }>
 */
export function storyToSpans(tracks, cast) {
  const chapters = [];
  let cur = { title: '', spans: [] };
  const flush = () => { if (cur.spans.length) chapters.push(cur); };

  for (const tk of tracks || []) {
    const text = tk.text || '';
    if (isChapterLine(text)) {
      flush();
      cur = { title: chapterTitle(text), spans: [] };
      continue;
    }
    const voiceId = effectiveProfile(tk, cast) || null;
    const speed = tk.speed || null;  // falsy 0 → null (engine default), per spec
    const spans = parseChapterBody(text, { defaultVoice: voiceId, defaultSpeed: speed });
    spans.forEach((s, i) => {
      const prev = cur.spans[cur.spans.length - 1];
      // Cross-track fold: a track that *leads* with a pause merges that silence
      // onto the previous span instead of emitting a standalone silent span.
      if (i === 0 && s.text === '' && s.pause_ms_after > 0 && prev) {
        prev.pause_ms_after += s.pause_ms_after;
      } else {
        cur.spans.push(s);
      }
    });
  }
  flush();
  return chapters;
}
