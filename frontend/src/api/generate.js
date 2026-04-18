import { API, apiUrl, apiFetch, apiJson } from './client';

export async function generateSpeech(formData, { signal } = {}) {
  // Returns the full Response so callers can stream the WAV blob + read headers.
  const res = await apiFetch('/generate', { method: 'POST', body: formData, signal });
  return res;
}

export async function listHistory() {
  return apiJson('/history');
}

export async function clearHistory() {
  return apiFetch('/history', { method: 'DELETE' });
}

export function audioUrl(filename) {
  return `${API}/audio/${filename}`;
}

export function audioUrlWithCacheBust(filename) {
  return `${apiUrl('/audio/' + filename)}?t=${Date.now()}`;
}
