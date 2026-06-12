import { apiFetch } from './client';

export interface AudiobookSpan {
  voice_id: string | null;
  text: string;
  pause_ms_after: number;
}
export interface AudiobookChapter {
  title: string;
  char_count: number;
  spans: AudiobookSpan[];
}
export interface AudiobookPlan {
  chapters: AudiobookChapter[];
  chapter_count: number;
  char_count: number;
}

/** Parse a script into a chapter/span plan (pure preview, no synthesis). */
export async function audiobookPlan(
  body: { text: string; default_voice?: string | null },
): Promise<AudiobookPlan> {
  const res = await apiFetch('/audiobook/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * Start the synth job. Returns the raw streaming Response; the caller reads
 * `response.body` with a reader + the sseParse helpers. (apiFetch throws on a
 * non-2xx status, so a returned Response is always a live stream.)
 */
export async function audiobookGenerate(
  body: { text: string; default_voice?: string | null; bitrate?: string },
): Promise<Response> {
  return apiFetch('/audiobook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
