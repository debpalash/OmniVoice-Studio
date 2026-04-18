import { API, apiUrl, apiJson, apiPost, apiFetch } from './client';

export async function dubUpload(file, jobId, { signal } = {}) {
  const fd = new FormData();
  fd.append('video', file);
  fd.append('job_id', jobId);
  return apiPost('/dub/upload', fd, { signal });
}

export function transcribeStreamUrl(jobId) {
  return `${API}/dub/transcribe-stream/${jobId}`;
}

export async function dubAbort(jobId) {
  try { await apiFetch(`/dub/abort/${jobId}`, { method: 'POST' }); } catch {}
}

export async function dubCleanupSegments(jobId) {
  return apiPost(`/dub/cleanup-segments/${jobId}`);
}

export async function dubTranslate(body) {
  return apiPost('/dub/translate', body);
}

export async function dubGenerate(jobId, body) {
  return apiPost(`/dub/generate/${jobId}`, body);
}

export function tasksStreamUrl(taskId) {
  return apiUrl(`/tasks/stream/${taskId}`);
}

export async function tasksCancel(taskId) {
  return apiFetch(`/tasks/cancel/${taskId}`, { method: 'POST' });
}

export async function listDubHistory() {
  return apiJson('/dub/history');
}

export async function clearDubHistory() {
  return apiFetch('/dub/history', { method: 'DELETE' });
}
