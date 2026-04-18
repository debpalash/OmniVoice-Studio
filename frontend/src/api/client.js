export const API = import.meta.env.DEV ? 'http://localhost:8000' : '';

class ApiError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export function apiUrl(path) {
  if (!path) return API;
  return path.startsWith('http') ? path : `${API}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    return j.detail || j.error || text || res.statusText;
  } catch {
    return text || res.statusText;
  }
}

export async function apiFetch(path, opts = {}) {
  const res = await fetch(apiUrl(path), opts);
  if (!res.ok) {
    const detail = await readError(res);
    throw new ApiError(`${res.status} ${res.statusText}: ${detail}`, { status: res.status, detail });
  }
  return res;
}

export async function apiJson(path, opts = {}) {
  const res = await apiFetch(path, opts);
  return res.json();
}

export async function apiPost(path, body, opts = {}) {
  const init = { method: 'POST', ...opts };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    init.body = JSON.stringify(body);
  }
  return apiJson(path, init);
}

export async function apiDelete(path, opts = {}) {
  return apiFetch(path, { method: 'DELETE', ...opts });
}

export { ApiError };
