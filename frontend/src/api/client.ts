// Backend always listens on localhost:8000 — both in dev (Vite @ 5173 talking
// to a separate uvicorn) and in the built .app (Tauri webview @ tauri://localhost
// talking to the bundled frozen backend sidecar). Relative fetches against
// tauri://localhost don't reach the sidecar, so we hardcode the absolute host.
export const API = 'http://localhost:8000';

export class ApiError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, init: { status?: number; detail?: unknown } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = init.status;
    this.detail = init.detail;
  }
}

export function apiUrl(path?: string): string {
  if (!path) return API;
  return path.startsWith('http') ? path : `${API}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    return j.detail || j.error || text || res.statusText;
  } catch {
    return text || res.statusText;
  }
}

export async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const res = await fetch(apiUrl(path), opts);
  if (!res.ok) {
    const detail = await readError(res);
    throw new ApiError(`${res.status} ${res.statusText}: ${detail}`, { status: res.status, detail });
  }
  return res;
}

export async function apiJson<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, opts);
  return res.json() as Promise<T>;
}

export async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  opts: RequestInit = {},
): Promise<T> {
  const init: RequestInit = { method: 'POST', ...opts };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string> || {}) };
    init.body = JSON.stringify(body);
  }
  return apiJson<T>(path, init);
}

export async function apiDelete(path: string, opts: RequestInit = {}): Promise<Response> {
  return apiFetch(path, { method: 'DELETE', ...opts });
}
