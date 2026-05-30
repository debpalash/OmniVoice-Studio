/**
 * Story-track text tokenizer.
 *
 * A Stories track is plain text plus two kinds of inline markers:
 *
 *   [pause 0.5s]            — emit `seconds` of silence
 *   [voice:<profile-id>]    — switch the active voice to `<profile-id>`
 *   [voice:default]         — revert to the track's default voice
 *
 * Markers are flat, never nested; the active voice persists until the next
 * voice marker or the end of the track. `parseStoryText` walks the text and
 * emits a sequence of events the preview/export pipeline can consume:
 *
 *   { type: 'chunk', text, profileId }   — speak `text` in `profileId`
 *   { type: 'pause', seconds }           — insert silence
 *
 * Whitespace-only chunks between markers are dropped so they don't introduce
 * audible "uhs" from the TTS model.
 */

// Single pattern that matches either token; the alternation captures the
// payload in group 1 (pause seconds) or group 2 (voice id).
const TOKEN_RE = /\[(?:pause\s+(\d+(?:\.\d+)?)\s*s?|voice:\s*([^\]]+))\]/gi;

export function parseStoryText(text, defaultProfileId = null) {
  const out = [];
  if (!text) return out;
  let currentProfile = defaultProfileId;
  let cursor = 0;
  // Use a fresh regex per call so concurrent callers don't share lastIndex state.
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      const chunk = text.slice(cursor, match.index).trim();
      if (chunk) out.push({ type: 'chunk', text: chunk, profileId: currentProfile });
    }
    if (match[1] != null) {
      const seconds = parseFloat(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        out.push({ type: 'pause', seconds });
      }
    } else if (match[2] != null) {
      const id = match[2].trim();
      currentProfile = (id === 'default' || id === '') ? defaultProfileId : id;
    }
    cursor = re.lastIndex;
  }
  if (cursor < text.length) {
    const tail = text.slice(cursor).trim();
    if (tail) out.push({ type: 'chunk', text: tail, profileId: currentProfile });
  }
  return out;
}

/** True if `text` contains any inline marker we need to special-case for preview. */
export function hasStoryMarkers(text) {
  return /\[(?:pause\s+\d|voice:)/i.test(text || '');
}

/**
 * Wrap a selection with an inline voice switch.
 * - With a non-empty selection: `before [voice:X]selected[voice:default] after`
 * - With a collapsed caret: inserts `[voice:X]` at the caret (caller-controlled).
 *
 * Returns the new text — the caller is responsible for state updates.
 */
export function applyInlineVoice(text, selectionStart, selectionEnd, voiceId) {
  const s = Math.max(0, Math.min(selectionStart ?? 0, text.length));
  const e = Math.max(s, Math.min(selectionEnd ?? s, text.length));
  const before = text.slice(0, s);
  const middle = text.slice(s, e);
  const after = text.slice(e);
  if (!middle) {
    return `${before}[voice:${voiceId}]${after}`;
  }
  return `${before}[voice:${voiceId}]${middle}[voice:default]${after}`;
}

/**
 * Insert `token` (e.g. `[pause 0.5s]` or `[laughter]`) at `caret`, padding with
 * spaces so it survives a re-split and never glues onto a word. With a null/
 * out-of-range caret it appends to the end. Pure — the caller updates state.
 */
export function insertToken(text, caret, token) {
  const t = String(text || '');
  if (caret == null || caret < 0 || caret > t.length) {
    const sep = t.length && !/\s$/.test(t) ? ' ' : '';
    return `${t}${sep}${token}`;
  }
  const before = t.slice(0, caret);
  const after = t.slice(caret);
  const left = before.length && !/\s$/.test(before) ? `${before} ` : before;
  const right = after.length && !/^\s/.test(after) ? ` ${after}` : after;
  return `${left}${token}${right}`;
}
