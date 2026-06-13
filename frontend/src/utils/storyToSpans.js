import { parseStoryText } from './storyTokens';
import { isChapterLine, chapterTitle } from './storyExport';
import { effectiveProfile } from './storyCast';

/**
 * Compile the Stories Editor's cast + ordered lines into the chapter/span plan
 * the shared `/longform/render` endpoint consumes — the bridge that lets a
 * multi-voice story render on the same server-side pipeline as an audiobook
 * (resume, loudness, cover, chapter markers).
 *
 * Rules:
 *  - a line starting with "# " opens a new chapter (its text is the title)
 *  - every spoken line resolves to its effective voice (per-line override →
 *    cast member's voice) and is split on inline `[voice:]`/`[pause]` markers
 *  - a `[pause]` folds into the previous span's trailing silence, or becomes a
 *    silent span if it leads a chapter
 *
 * @returns Array<{ title, spans: [{ voice_id, text, pause_ms_after }] }>
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
    const profileId = effectiveProfile(tk, cast) || null;
    for (const seg of parseStoryText(text, profileId)) {
      if (seg.type === 'pause') {
        const ms = Math.round(seg.seconds * 1000);
        const last = cur.spans[cur.spans.length - 1];
        if (last) last.pause_ms_after += ms;
        else cur.spans.push({ voice_id: profileId, text: '', pause_ms_after: ms });
      } else if (seg.text) {
        cur.spans.push({ voice_id: seg.profileId || null, text: seg.text, pause_ms_after: 0 });
      }
    }
  }
  flush();
  return chapters;
}
