import { API, apiUrl, apiJson, apiPost, apiFetch } from './client';
import type { DubHistoryResponse, DubTranslateResponse } from './types';

export async function dubUpload(
  file: File | Blob,
  jobId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<unknown> {
  const fd = new FormData();
  fd.append('video', file);
  fd.append('job_id', jobId);
  return apiPost('/dub/upload', fd, { signal });
}

export async function dubIngestUrl(
  url: string,
  jobId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<unknown> {
  return apiPost('/dub/ingest-url', { url, job_id: jobId }, { signal });
}

export function transcribeStreamUrl(jobId: string): string {
  return `${API}/dub/transcribe-stream/${jobId}`;
}

export async function dubAbort(jobId: string): Promise<void> {
  try { await apiFetch(`/dub/abort/${jobId}`, { method: 'POST' }); } catch { /* best-effort */ }
}

export async function dubCleanupSegments(jobId: string): Promise<unknown> {
  return apiPost(`/dub/cleanup-segments/${jobId}`);
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
