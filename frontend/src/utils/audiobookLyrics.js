/**
 * Synced-lyrics timing for the audiobook player — pure, testable text→cue
 * functions, no React and no network. The player highlights the word under
 * `audio.currentTime`, so everything here reduces to: which words exist per
 * chapter, and what `[start, end]` window each one owns inside the final file.
 *
 * Timing sources, in order (mirrors backend/services/karaoke_ass.py):
 *
 * 1. Per-chapter durations the render stream already emits (`chapter` SSE
 *    events carry `duration_s`) — no new backend work, no ASR pass. Words
 *    inside a chapter are even-split across its span, exactly like the
 *    karaoke burn-in's old-job fallback.
 * 2. When those durations are gone (a reload — the output filename persists
 *    in the store but the stream events don't), the whole book's words are
 *    even-split over the audio element's own duration, chapter spans falling
 *    out proportionally by word count.
 *
 * The chapter split MIRRORS the canonical grammar in
 * `backend/services/longform_parser.py` (H1 headings; intro text before the
 * first heading is its own chapter; a chapter is dropped iff it produces no
 * spoken text and no pause). The golden-corpus parser stays the source of
 * truth for rendering — this only needs the same chapter COUNT and order so
 * cue indices line up with the stream's chapter list, and any drift (e.g. the
 * script was edited after the render) is caught by the count check in
 * {@link buildLyricsTimeline}, which then degrades to the proportional split.
 */

// H1 chapter heading (mirrors _HEADING_RE): `# <non-space>…`, multiline.
const HEADING_RE = /^[ \t]*#[ \t]+(\S.*)$/gm;
// [voice:NAME] — content excludes BOTH brackets (mirrors _VOICE_RE).
const VOICE_RE = /\[voice:[^\][]*\]/gi;
// [pause] / [pause 500ms] / [pause 1.5s] (mirrors parse_pause_markers' shape).
const PAUSE_RE = /\[\s*pause(?:\s+\d+(?:\.\d+)?(?:\s*(?:ms|s))?)?\s*\]/gi;
// SSML-lite control tags — delivery modifiers, never spoken.
const SSML_RE = /\[\/?(?:slow|fast|emphasis|spell)\]/gi;

const WS = /\s+/;

const fresh = (re) => new RegExp(re.source, re.flags);

/**
 * Uniformly distribute a text's whitespace tokens over `[start, end]` —
 * a direct port of `karaoke_ass.even_split_words`. Returns
 * `[{ text, start, end }]`; empty for blank text.
 */
export function evenSplitWords(text, start, end) {
  const tokens = String(text || '')
    .trim()
    .split(WS)
    .filter(Boolean);
  if (!tokens.length) return [];
  const s = Number(start) || 0;
  const dur = Math.max(0, (Number(end) || 0) - s) / tokens.length;
  return tokens.map((tok, i) => ({ text: tok, start: s + i * dur, end: s + (i + 1) * dur }));
}

/**
 * Split a script into the chapters the backend parser would render, each with
 * its display tokens: `[{ title, tokens }]`. Control tokens (voice / pause /
 * SSML-lite) are stripped — they shape delivery, nobody hears them — while
 * reaction tags (`[laughs]`…) stay: the engine performs those, so they get a
 * highlight window like any word. Returns `[]` for a blank script.
 */
export function scriptChapters(script) {
  const norm = String(script || '').replace(/\r\n?/g, '\n');
  if (!norm.trim()) return [];
  const heads = [];
  const re = fresh(HEADING_RE);
  let m;
  while ((m = re.exec(norm)) !== null) {
    heads.push({ start: m.index, end: m.index + m[0].length, title: (m[1] || '').trim() });
    if (re.lastIndex === m.index) re.lastIndex++; // zero-width guard
  }
  const raw = [];
  if (!heads.length) {
    raw.push({ title: '', body: norm });
  } else {
    const intro = norm.slice(0, heads[0].start);
    if (intro.trim()) raw.push({ title: '', body: intro });
    for (let i = 0; i < heads.length; i++) {
      const bodyEnd = i + 1 < heads.length ? heads[i + 1].start : norm.length;
      raw.push({ title: heads[i].title, body: norm.slice(heads[i].end, bodyEnd) });
    }
  }
  const out = [];
  for (const { title, body } of raw) {
    const hasPause = fresh(PAUSE_RE).test(body);
    const spoken = body
      .replace(fresh(VOICE_RE), ' ')
      .replace(fresh(PAUSE_RE), ' ')
      .replace(fresh(SSML_RE), ' ');
    const tokens = spoken.split(WS).filter(Boolean);
    // Parser drop rule: a chapter survives iff any span survives — i.e. it
    // says something OR carries a pause (pause-only chapters render silence).
    if (tokens.length || hasPause) out.push({ title, tokens });
  }
  return out;
}

/**
 * Build the full highlight timeline for a rendered book.
 *
 * @param {string} script     the script the render was created from
 * @param {object} opts
 * @param {Array}  [opts.chapters]  the tab's per-chapter stream state, aligned
 *   with the backend plan: `{ title, status, duration_s }` where status is
 *   done | cached | failed. Failed chapters are absent from the muxed audio,
 *   so they get no cue and no time.
 * @param {number} [opts.duration]  the audio element's total duration — the
 *   proportional fallback used when stream timings are absent or don't line
 *   up with the script (edited after the render, stopped mid-book, …).
 * @returns {{ chapters: Array<{title, start, end, wordStart, wordCount}>,
 *            words: Array<{text, start, end, chapterIndex}> }}
 */
export function buildLyricsTimeline(script, { chapters = null, duration = 0 } = {}) {
  const parsed = scriptChapters(script);
  const empty = { chapters: [], words: [] };
  if (!parsed.length) return empty;

  const timed =
    Array.isArray(chapters) &&
    chapters.length === parsed.length &&
    chapters.every((c) => c?.status === 'failed' || Number.isFinite(c?.duration_s));

  const outChapters = [];
  const words = [];
  if (timed) {
    let at = 0;
    for (let i = 0; i < parsed.length; i++) {
      if (chapters[i].status === 'failed') continue; // not in the audio
      const start = at;
      const end = at + Math.max(0, chapters[i].duration_s);
      pushChapter(outChapters, words, parsed[i], chapters[i].title, start, end);
      at = end;
    }
    return { chapters: outChapters, words };
  }

  const total = Number(duration) || 0;
  if (total <= 0) return empty;
  const totalTokens = parsed.reduce((n, c) => n + c.tokens.length, 0);
  if (!totalTokens) return empty;
  // Proportional even split: every word owns the same slice of the file, so
  // chapter spans fall out of their word counts. Wordless (pause-only)
  // chapters get a zero-width span — nothing to highlight there anyway.
  const per = total / totalTokens;
  let at = 0;
  for (const chapter of parsed) {
    const end = at + chapter.tokens.length * per;
    pushChapter(outChapters, words, chapter, '', at, end);
    at = end;
  }
  return { chapters: outChapters, words };
}

function pushChapter(outChapters, words, parsedChapter, streamTitle, start, end) {
  const wordStart = words.length;
  const split = evenSplitWords(parsedChapter.tokens.join(' '), start, end);
  const chapterIndex = outChapters.length;
  for (const w of split) words.push({ ...w, chapterIndex });
  outChapters.push({
    title: streamTitle || parsedChapter.title,
    start,
    end,
    wordStart,
    wordCount: split.length,
  });
}

/**
 * Index of the word under playback time `t`: the last word whose start is
 * ≤ `t` (binary search — cue lists run to tens of thousands of words), or -1
 * before the first word. Inside a pause the previous word stays lit, matching
 * the karaoke sweep's "gaps finish the previous word" behaviour.
 */
export function activeWordIndex(words, t) {
  if (!Array.isArray(words) || !words.length || !(t >= words[0].start)) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
