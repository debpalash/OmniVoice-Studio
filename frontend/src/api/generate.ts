import { API, apiUrl, apiFetch, apiJson } from './client';

export async function generateSpeech(
  formData: FormData,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Response> {
  // Returns the full Response so callers can stream the WAV blob + read headers.
  return apiFetch('/generate', { method: 'POST', body: formData, signal });
}

export async function listHistory(): Promise<unknown> {
  return apiJson('/history');
}

export async function clearHistory(): Promise<Response> {
  return apiFetch('/history', { method: 'DELETE' });
}

export function audioUrl(filename: string): string {
  return `${API}/audio/${filename}`;
}

export function audioUrlWithCacheBust(filename: string): string {
  return `${apiUrl('/audio/' + filename)}?t=${Date.now()}`;
}
