import { API, apiUrl, apiJson, apiPost, apiFetch } from './client';
import type { DubHistoryResponse, DubTranslateResponse } from './types';

export async function dubUpload(
  file: File | Blob,
  jobId: string,
  { signal, inputType = 'video' }: { signal?: AbortSignal; inputType?: 'video' | 'audio' } = {},
): Promise<unknown> {
  const fd = new FormData();
  fd.append('video', file);
  fd.append('job_id', jobId);
  fd.append('input_type', inputType);  // #119: audio-only dubbing
  return apiPost('/dub/upload', fd, { signal });
}

export interface IngestUrlOptions {
  signal?: AbortSignal;
  /** Ask yt-dlp to also pull caption tracks (incl. YouTube auto-translations). */
  fetchSubs?: boolean;
  /** Limit caption fetch to specific lang codes; defaults to all available. */
  subLangs?: string[];
}

export async function dubIngestUrl(
  url: string,
  jobId: string,
  opts: IngestUrlOptions = {},
): Promise<unknown> {
  const { signal, fetchSubs, subLangs } = opts;
  return apiPost(
    '/dub/ingest-url',
    {
      url,
      job_id: jobId,
      fetch_subs: fetchSubs || undefined,
      sub_langs: subLangs && subLangs.length ? subLangs : undefined,
    },
    { signal },
  );
}

export function transcribeStreamUrl(jobId: string, numSpeakers?: number | null): string {
  const base = `${API}/dub/transcribe-stream/${jobId}`;
  // Optional pyannote speaker-count hint (#274). Only appended when a positive
  // integer; otherwise the backend auto-detects.
  if (numSpeakers && Number.isFinite(numSpeakers) && numSpeakers > 0) {
    return `${base}?num_speakers=${Math.floor(numSpeakers)}`;
  }
  return base;
}

export async function dubAbort(jobId: string): Promise<void> {
  try { await apiFetch(`/dub/abort/${jobId}`, { method: 'POST' }); } catch { /* best-effort */ }
}

export async function dubCleanupSegments(jobId: string): Promise<unknown> {
  return apiPost(`/dub/cleanup-segments/${jobId}`);
}

export interface DubImportSrtResponse {
  segments: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    text_original: string;
    speaker_id: string;
  }>;
  stats: {
    imported: number;
    skipped_malformed: number;
    dropped_overlap: number;
    clamped_to_duration: number;
  };
}

export async function dubImportSrt(jobId: string, file: File | Blob): Promise<DubImportSrtResponse> {
  const fd = new FormData();
  fd.append('file', file);
  return apiPost<DubImportSrtResponse>(`/dub/import-srt/${jobId}`, fd);
}

export async function dubTranslate(body: Record<string, unknown>): Promise<DubTranslateResponse> {
  return apiPost<DubTranslateResponse>('/dub/translate', body);
}

export async function dubGenerate(jobId: string, body: Record<string, unknown>): Promise<unknown> {
  return apiPost(`/dub/generate/${jobId}`, body);
}

export function tasksStreamUrl(taskId: string): string {
  return apiUrl(`/tasks/stream/${taskId}`);
}

export async function tasksCancel(taskId: string): Promise<Response> {
  return apiFetch(`/tasks/cancel/${taskId}`, { method: 'POST' });
}

export async function listDubHistory(): Promise<DubHistoryResponse> {
  return apiJson<DubHistoryResponse>('/dub/history');
}

export async function clearDubHistory(): Promise<Response> {
  return apiFetch('/dub/history', { method: 'DELETE' });
}
