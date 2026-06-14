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

export interface AudiobookPreview {
  output: string;       // path under OUTPUTS_DIR, served via /audio
  duration_s: number;
  cached: boolean;
  title: string;
}

/** Render a single chapter to audition it (also warms the resume cache). */
export async function audiobookPreviewChapter(
  body: { text: string; chapter_index: number; default_voice?: string | null; lexicon?: Record<string, string> | null },
): Promise<AudiobookPreview> {
  const res = await apiFetch('/audiobook/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Global tags embedded in the output file (player-visible). */
export interface AudiobookMetadata {
  title?: string;
  author?: string;
  narrator?: string;
  year?: string;
  genre?: string;
  description?: string;
}

export interface AudiobookGenerateBody {
  text: string;
  default_voice?: string | null;
  bitrate?: string;
  format?: 'm4b' | 'mp3';
  loudness?: 'off' | 'acx' | 'podcast' | null;
  cover_path?: string | null;
  metadata?: AudiobookMetadata | null;
  lexicon?: Record<string, string> | null;
}

/**
 * Start the synth job. Returns the raw streaming Response; the caller reads
 * `response.body` with a reader + the sseParse helpers. (apiFetch throws on a
 * non-2xx status, so a returned Response is always a live stream.)
 */
export async function audiobookGenerate(body: AudiobookGenerateBody): Promise<Response> {
  return apiFetch('/audiobook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Upload a cover image; returns the server-side path to pass as `cover_path`. */
export async function audiobookUploadCover(file: File): Promise<{ path: string }> {
  const form = new FormData();
  form.append('cover', file);
  const res = await apiFetch('/audiobook/cover', { method: 'POST', body: form });
  return res.json();
}

/** Import a .txt/.md/.epub/.pdf into a chapter-delimited script. */
export async function audiobookImport(file: File): Promise<{ text: string; chapters: number }> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch('/audiobook/import', { method: 'POST', body: form });
  return res.json();
}

export interface LongformRenderBody {
  chapters: Array<{ title?: string; spans: Array<{ voice_id: string | null; text: string; pause_ms_after: number; speed?: number | null }> }>;
  default_voice?: string | null;
  bitrate?: string;
  format?: 'm4b' | 'mp3';
  loudness?: 'off' | 'acx' | 'podcast' | null;
  cover_path?: string | null;
  metadata?: AudiobookMetadata | null;
}

/**
 * Render a pre-built chapter/span plan through the shared chapterized renderer
 * (the convergence endpoint Stories posts to). Returns the raw SSE stream
 * Response — read `response.body` with the sseParse helpers, same as
 * `audiobookGenerate`.
 */
export async function longformRender(body: LongformRenderBody): Promise<Response> {
  return apiFetch('/longform/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
