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
// Remote-backend settings (Wave 2.3): user-configured in Settings → Sharing.
// localStorage so the choice survives restarts; read once at module load —
// the Settings panel reloads the app on save.
export const LS_BACKEND_URL = 'ov_backend_url';
export const LS_API_KEY = 'ov_api_key';
// Pure + exported for unit testing — takes env + window so tests don't need to
// re-import the module or stub import.meta.env.
export function _resolveApiBase(env: any, win: any): string {
  const port = env?.VITE_API_PORT || '3900';
  // Explicit override, in precedence order:
  //   1. localStorage ov_backend_url — the user's explicit "Remote backend"
  //      setting (Wave 2.3). Beats everything: it's the one override a
  //      desktop user sets on purpose, per machine.
  //   2. window.__OMNIVOICE_API_BASE__ — RUNTIME global the backend injects
  //      into index.html from OMNIVOICE_PUBLIC_API_BASE. The only override that
  //      works on a prebuilt Docker image (VITE_* is inlined at build time).
  //   3. VITE_OMNIVOICE_API — the build-time var documented for Docker/proxy
  //      deploys and used by utils/apiBase.ts.
  //   4. VITE_API_URL — legacy alias.
  let stored = '';
  try {
    stored = (win && win.localStorage && win.localStorage.getItem(LS_BACKEND_URL)) || '';
  } catch {
    /* storage unavailable (privacy mode) */
  }
  const runtime =
    win && typeof win.__OMNIVOICE_API_BASE__ === 'string' ? win.__OMNIVOICE_API_BASE__ : '';
  const override = stored || runtime || env?.VITE_OMNIVOICE_API || env?.VITE_API_URL;
  if (override) return String(override).replace(/\/+$/, '');
  if (!win) return `http://127.0.0.1:${port}`;
  if (win.__TAURI__ || win.__TAURI_INTERNALS__) return `http://127.0.0.1:${port}`;
  if (env?.DEV) return `http://${win.location.hostname}:${port}`;
  return win.location.origin;
}
export const API = _resolveApiBase(viteEnv, typeof window !== 'undefined' ? window : undefined);

function _apiKey(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(LS_API_KEY) : null;
  } catch {
    return null;
  }
}

/** Build a ws:// or wss:// URL for a backend WebSocket endpoint.
 *
 * Scheme derives from the API base itself (NOT window.location — a Tauri
 * webview pointing at an https remote must still get wss), and the remote
 * API key rides as ?api_key= because browser WebSockets can't set headers. */
export function wsUrl(path: string): string {
  const base = API.replace(/^http/, 'ws').replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const key = _apiKey();
  if (!key) return url;
  return `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`;
}

// Capture a QR-supplied PIN once on load. When LAN sharing is on, the host's
// QR code links to `http://<lan-ip>:<port>/?pin=<pin>`; stash it in
// sessionStorage so apiFetch attaches it to every request automatically.
if (typeof window !== 'undefined') {
  try {
    const p = new URL(window.location.href).searchParams.get('pin');
    if (p) sessionStorage.setItem('ov_pin', p);
  } catch {
    /* noop */
  }
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

// Backoff (ms) for retrying a *transport-level* failure — the backend briefly
// down while the auto-restart supervisor brings it back (#567/#570/#571). One
// short cascade (~2.9 s total) so a restart window becomes invisible, yet a
// genuinely-down backend still surfaces the actionable error promptly.
const TRANSPORT_RETRY_BACKOFF_MS = [400, 900, 1600];

export async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const pin = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('ov_pin') : null;
  const key = _apiKey();
  // Only modify the request when a PIN/API key is set, so the default call
  // shape (e.g. FormData posts with no headers / no Content-Type override)
  // is preserved exactly.
  const extra: Record<string, string> = {};
  if (pin) extra['X-OmniVoice-Pin'] = pin;
  if (key) extra['Authorization'] = `Bearer ${key}`;
  const finalOpts: RequestInit = Object.keys(extra).length
    ? { ...opts, headers: { ...(opts.headers as Record<string, string>), ...extra } }
    : opts;
  const signal = finalOpts.signal as AbortSignal | null | undefined;
  let lastDetail = '';
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let res: Response;
    try {
      res = await fetch(apiUrl(path), finalOpts);
    } catch (e) {
      // A thrown fetch (TypeError "Failed to fetch" / "NetworkError") means the
      // request never reached the backend — it's still starting up, crashed, or
      // the dev server dropped. The auto-restart supervisor revives it within a
      // few seconds, so retry a bounded few times with backoff before surfacing
      // the actionable ApiError, making a brief restart window invisible
      // (issues #438/#454/#466/#567). Never retry a deliberate abort. status:0
      // lets callers distinguish a transport failure from an HTTP error.
      if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e;
      lastDetail = String((e as Error)?.message || e);
      if (attempt < TRANSPORT_RETRY_BACKOFF_MS.length) {
        await new Promise((r) => setTimeout(r, TRANSPORT_RETRY_BACKOFF_MS[attempt]));
        continue;
      }
      throw new ApiError(
        "Can't reach the local OmniVoice backend — it may still be starting up, or it stopped. " +
          'Wait a few seconds and try again; if it persists, restart the app (or check Settings → Logs → Backend).',
        { status: 0, detail: lastDetail },
      );
    }
    if (!res.ok) {
      // 401 from the LAN PIN middleware on a remote device → surface the gate.
      // An HTTP error means the backend *did* respond — never retry it.
      if (res.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('ov:pin-required'));
      }
      const detail = await readError(res);
      throw new ApiError(`${res.status} ${res.statusText}: ${detail}`, {
        status: res.status,
        detail,
      });
    }
    return res;
  }
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
    init.headers = {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    };
    init.body = JSON.stringify(body);
  }
  return apiJson<T>(path, init);
}

export async function apiDelete(path: string, opts: RequestInit = {}): Promise<Response> {
  return apiFetch(path, { method: 'DELETE', ...opts });
}
