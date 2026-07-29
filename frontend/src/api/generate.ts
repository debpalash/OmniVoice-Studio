import { API, apiUrl, apiFetch, apiJson } from './client';
import { useAppStore } from '../store';
import { warnIfEngineUnderProvisioned } from '../utils/generatePreflight';
<<<<<<< HEAD
=======

/**
 * Hold the in-flight count for the duration of `fn`.
 *
 * Safe to nest, and streaming relies on that: generateSpeech releases its
 * claim when the Response resolves — i.e. when the HEADERS arrive — but a
 * streaming synth reads the body for as long as it takes to generate. Wrapping
 * the whole stream in an outer claim keeps the count above zero throughout;
 * the inner one just bumps it to 2 and back. This only works because the store
 * tracks a COUNT, not a boolean (Greptile P1, #1288).
 */
export async function withTtsInflight<T>(fn: () => Promise<T>): Promise<T> {
  useAppStore.getState().addTtsInflight?.(1);
  try {
    return await fn();
  } finally {
    useAppStore.getState().addTtsInflight?.(-1);
  }
}
>>>>>>> main

export async function generateSpeech(
  formData: FormData,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Response> {
  // Count this synth as in flight for as long as it runs. Installing an update
  // relaunches the process, so the updater has to know a synth is running
  // (utils/appBusy) — and the guard belongs HERE, at the one call every synth
  // path shares: the Generate tab, voice previews, the compare modal, the
  // stories editor and profile previews all reach /generate through this
  // function. Tracking it in any single caller would leave the others able to
  // be silently discarded, and a new caller would have to remember to opt in.
  //
  // A count rather than a flag because these overlap: a boolean would be
  // cleared by whichever request settled first while the rest were still
  // running. `finally` so an abort or a network error releases it too.
  useAppStore.getState().addTtsInflight?.(1);
  // Same chokepoint argument as the in-flight count: every synth path reaches
  // /generate through here, so the under-provisioned-hardware warning fires
  // whether or not the user ever re-picked an engine. Intentionally not
  // awaited — the toast must not delay the request it is warning about.
  void warnIfEngineUnderProvisioned();
  try {
    // Returns the full Response so callers can stream the WAV blob + read headers.
    return await apiFetch('/generate', { method: 'POST', body: formData, signal });
  } finally {
    useAppStore.getState().addTtsInflight?.(-1);
  }
}

export async function listHistory(): Promise<unknown> {
  return apiJson('/history');
}

export async function clearHistory(): Promise<Response> {
  return apiFetch('/history', { method: 'DELETE' });
}

export async function setHistoryStarred(id: string, starred: boolean): Promise<unknown> {
  return apiJson(`/history/${id}/starred`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ starred }),
  });
}

export function audioUrl(filename: string): string {
  return `${API}/audio/${filename}`;
}

export function audioUrlWithCacheBust(filename: string): string {
  return `${apiUrl('/audio/' + filename)}?t=${Date.now()}`;
}
