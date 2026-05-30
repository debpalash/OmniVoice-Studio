/**
 * parseScript — turn pasted prose or a screenplay into attributed lines.
 *
 * Two formats are recognised, paragraph by paragraph:
 *   1. Screenplay:  `NAME: dialogue`            → { speaker: NAME, text }
 *   2. Prose:       narration with "quoted" bits → narration goes to the
 *                   Narrator; each quote is attributed to a nearby dialogue
 *                   tag ("said the fox" / "the fox asked").
 *
 * Returns an ordered array of { speaker, text }. Pure + testable; the caller
 * maps speakers → cast members. Speaker "Narrator" is the default fallback.
 */

const TAG_VERBS =
  'said|asked|replied|answered|whispered|shouted|murmured|cried|added|continued|' +
  'muttered|exclaimed|called|yelled|laughed|sighed|began|growled|responded|declared';

/** Normalise a raw captured name → Title Case, drop a leading "the"/punctuation. */
export function normalizeSpeaker(raw) {
  let s = String(raw || '').trim().replace(/^the\s+/i, '').replace(/[.,!?:;"'“”]+$/g, '').trim();
  if (!s) return 'Narrator';
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function attributionName(before, after) {
  const V = TAG_VERBS;
  const tests = [
    new RegExp(`^[\\s,]*(?:${V})\\s+(?:the\\s+)?([A-Za-z][A-Za-z'-]*)`, 'i'),       // "," asked the fox
    new RegExp(`^[\\s,]*(?:the\\s+)?([A-Za-z][A-Za-z'-]*)\\s+(?:${V})`, 'i'),       // "," the owl said
  ].map((re) => after.match(re));
  const before2 = [
    new RegExp(`(?:the\\s+)?([A-Za-z][A-Za-z'-]*)\\s+(?:${V})\\s*[,:]?\\s*$`, 'i'), // The fox asked,
    new RegExp(`(?:${V})\\s+(?:the\\s+)?([A-Za-z][A-Za-z'-]*)\\s*[,:]?\\s*$`, 'i'), // asked the fox,
  ].map((re) => before.match(re));
  const hit = [...tests, ...before2].find(Boolean);
  return hit ? hit[1] : null;
}

export function parseScript(text) {
  const out = [];
  const src = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!src) return out;

  const paras = src
    .split(/\n\s*\n/)
    .flatMap((p) => p.split(/\n/))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const para of paras) {
    // 1. Screenplay "NAME: dialogue" (avoid matching URLs like http://…)
    const sp = para.match(/^([A-Za-z][A-Za-z0-9 ._'-]{0,30}):\s+(.+)$/);
    if (sp && !/^https?$/i.test(sp[1].trim())) {
      out.push({ speaker: normalizeSpeaker(sp[1]), text: sp[2].trim() });
      continue;
    }

    // 2. Prose with quoted dialogue (straight + curly double quotes)
    const quoteRe = /["“„]([^"“”„]+)["”]/g;
    let last = 0;
    let m;
    let found = false;
    const segs = [];
    while ((m = quoteRe.exec(para)) !== null) {
      found = true;
      const before = para.slice(last, m.index);
      const quote = (m[1] || '').trim();
      const after = para.slice(quoteRe.lastIndex);
      if (before.trim()) segs.push({ speaker: 'Narrator', text: before.trim() });
      const name = attributionName(before, after);
      if (quote) segs.push({ speaker: name ? normalizeSpeaker(name) : 'Narrator', text: quote });
      last = quoteRe.lastIndex;
    }
    if (!found) {
      out.push({ speaker: 'Narrator', text: para });
      continue;
    }
    const tail = para.slice(last).trim();
    if (tail) segs.push({ speaker: 'Narrator', text: tail });
    out.push(...segs.filter((s) => s.text));
  }
  return out;
}
