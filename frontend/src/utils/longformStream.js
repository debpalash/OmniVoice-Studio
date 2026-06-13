/**
 * Shared consumer for the longform render SSE stream (Stories + Audiobook).
 *
 * Both editors compile to a chapter/span plan and stream progress from the same
 * server-side renderer (`_render_longform_sse`), emitting the same event shapes:
 *   { type: 'started', chapters }
 *   { type: 'chapter' | 'chapter_error', index, total, title }
 *   { type: 'assembling' }
 *   { type: 'done', output, cached_chapters?, failed_chapters? }
 *   { type: 'error', error }
 *
 * This factors out the identical read/decode/split/parse loop that lived in
 * both StoriesEditor and AudiobookTab — so a protocol change lives in one place
 * and each editor only supplies its own per-event state handling.
 */
import { splitSSEBuffer, parseSSELine } from './sseParse';

/**
 * Read `res.body` as an SSE stream and invoke `onEvent(evt)` for every parsed
 * event. Returns when the stream ends or `isAborted()` becomes true.
 *
 * @param {Response} res        fetch Response whose body is the SSE stream
 * @param {(evt: object) => void} onEvent  called once per parsed event
 * @param {{ isAborted?: () => boolean }} [opts]
 */
export async function consumeLongformStream(res, onEvent, { isAborted } = {}) {
  if (!res || !res.body) throw new Error('no response stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    if (isAborted && isAborted()) break;
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { lines, rest } = splitSSEBuffer(buffer);
    buffer = rest;
    for (const line of lines) {
      const evt = parseSSELine(line);
      if (evt) onEvent(evt);
    }
  }
}
