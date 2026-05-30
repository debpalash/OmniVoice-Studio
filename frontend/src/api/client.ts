// Backend base URL.
//   • VITE_API_URL                → explicit override (any deploy).
//   • Tauri webview               → the local sidecar (127.0.0.1:<port>).
//   • Vite dev server (import.meta.env.DEV) → backend on :<port> (the dev
//     SPA runs on :3901 and the backend on :3900; CORS allows the dev origin).
//   • Anything else (served BY the backend itself — the LAN-share listener,
//     Docker, or a prod build) → SAME ORIGIN. That server serves both the SPA
//     and the API, so a remote device on http://<host>:<share-port> must hit
//     that same origin — NOT a hardcoded :3900, which is cross-origin (CORS)
//     and loopback-only/unreachable from another machine.
const viteEnv = import.meta.env ?? {};
// Pure + exported for unit testing — takes env + window so tests don't need to
// re-import the module or stub import.meta.env.
export function _resolveApiBase(env: any, win: any): string {
  const port = env?.VITE_API_PORT || '3900';
  if (env?.VITE_API_URL) return env.VITE_API_URL;
  if (!win) return `http://127.0.0.1:${port}`;
  if (win.__TAURI__) return `http://127.0.0.1:${port}`;
  if (env?.DEV) return `http://${win.location.hostname}:${port}`;
  return win.location.origin;
}
export const API = _resolveApiBase(viteEnv, typeof window !== 'undefined' ? window : undefined);

// Capture a QR-supplied PIN once on load. When LAN sharing is on, the host's
// QR code links to `http://<lan-ip>:<port>/?pin=<pin>`; stash it in
// sessionStorage so apiFetch attaches it to every request automatically.
if (typeof window !== 'undefined') {
  try {
    const p = new URL(window.location.href).searchParams.get('pin');
    if (p) sessionStorage.setItem('ov_pin', p);
  } catch { /* noop */ }
}

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
  const pin = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ov_pin') : null;
  // Only modify the request when a PIN is set, so the default call shape
  // (e.g. FormData posts with no headers / no Content-Type override) is
  // preserved exactly.
  const finalOpts: RequestInit = pin
    ? { ...opts, headers: { ...(opts.headers as Record<string, string> || {}), 'X-OmniVoice-Pin': pin } }
    : opts;
  const res = await fetch(apiUrl(path), finalOpts);
  if (!res.ok) {
    // 401 from the LAN PIN middleware on a remote device → surface the gate.
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('ov:pin-required'));
    }
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
