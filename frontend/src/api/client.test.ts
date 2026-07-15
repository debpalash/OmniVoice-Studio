import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _parseDeepLinkCredentials } from './client';

describe('apiFetch PIN header', () => {
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    sessionStorage.clear();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    sessionStorage.clear();
  });

  it('attaches X-OmniVoice-Pin when present in sessionStorage', async () => {
    sessionStorage.setItem('ov_pin', '424242');
    const seen: any = {};
    globalThis.fetch = vi.fn((_url, opts) => {
      Object.assign(seen, opts);
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as any;
    const { apiFetch } = await import('./client');
    await apiFetch('/system/info');
    expect((seen.headers || {})['X-OmniVoice-Pin']).toBe('424242');
  });

  it('omits the header when no pin', async () => {
    const seen: any = {};
    globalThis.fetch = vi.fn((_url, opts) => {
      Object.assign(seen, opts);
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as any;
    const { apiFetch } = await import('./client');
    await apiFetch('/system/info');
    expect((seen.headers || {})['X-OmniVoice-Pin']).toBeUndefined();
  });

  it('turns a thrown fetch into an actionable ApiError (backend unreachable)', async () => {
    // Backend down / still starting → fetch() rejects with a TypeError.
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as any;
    const { apiFetch, ApiError } = await import('./client');
    let err: any;
    try {
      await apiFetch('/system/info');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0); // transport failure, not HTTP
    expect(String(err.message)).toMatch(/reach the local OmniVoice backend/i);
    expect(String(err.detail)).toMatch(/Failed to fetch/);
  });
});

describe('apiFetch 401 routing', () => {
  // The backend has two 401-returning middlewares distinguished only by their
  // `detail` body: "API key required" (BearerKeyMiddleware) vs "PIN required"
  // (NetworkAccessMiddleware). apiFetch reads the detail and dispatches a single
  // `ov:auth-required` CustomEvent whose `detail.mode` tells the gate which form.
  let realFetch: typeof globalThis.fetch;
  let dispatch: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    sessionStorage.clear();
    localStorage.clear();
    dispatch = vi.spyOn(window, 'dispatchEvent');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    sessionStorage.clear();
    localStorage.clear();
    dispatch.mockRestore();
  });

  const stub401 = (detail: string) =>
    vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => JSON.stringify({ detail }),
      }),
    ) as any;

  const authEvent = () =>
    dispatch.mock.calls.map((c) => c[0]).find((e) => (e as Event).type === 'ov:auth-required');

  it('dispatches ov:auth-required {mode:"apikey"} on an "API key required" 401', async () => {
    globalThis.fetch = stub401('API key required');
    const { apiFetch } = await import('./client');
    try {
      await apiFetch('/system/info');
    } catch {
      /* ApiError expected */
    }
    expect(authEvent()).toBeTruthy();
    expect((authEvent() as any).detail.mode).toBe('apikey');
  });

  it('dispatches ov:auth-required {mode:"pin"} on a "PIN required" 401', async () => {
    globalThis.fetch = stub401('PIN required');
    const { apiFetch } = await import('./client');
    try {
      await apiFetch('/system/info');
    } catch {
      /* ApiError expected */
    }
    expect(authEvent()).toBeTruthy();
    expect((authEvent() as any).detail.mode).toBe('pin');
  });
});

describe('_parseDeepLinkCredentials', () => {
  it('reads the API key from the fragment (not the query) and scrubs it', () => {
    const r = _parseDeepLinkCredentials('https://h:3900/#api_key=SECRET');
    expect(r.apiKey).toBe('SECRET');
    expect(r.pin).toBeNull();
    expect(r.scrubbed).toBe(true);
    expect(r.cleanUrl).toBe('/');
  });

  it('reads the PIN from the query and scrubs it', () => {
    const r = _parseDeepLinkCredentials('https://h/?pin=1234');
    expect(r.pin).toBe('1234');
    expect(r.apiKey).toBeNull();
    expect(r.cleanUrl).toBe('/');
  });

  it('scrubs a legacy ?api_key= from the query WITHOUT reading it (no leak)', () => {
    const r = _parseDeepLinkCredentials('https://h/?api_key=LEGACY');
    expect(r.apiKey).toBeNull();
    expect(r.scrubbed).toBe(true);
    expect(r.cleanUrl).toBe('/');
  });

  it('preserves other query state and a bare #settings fragment when no api_key is consumed', () => {
    const r = _parseDeepLinkCredentials('https://h/?pin=1&lang=fr#settings');
    expect(r.pin).toBe('1');
    expect(r.apiKey).toBeNull();
    expect(r.cleanUrl).toBe('/?lang=fr#settings');
  });

  it('preserves other fragment params alongside api_key', () => {
    const r = _parseDeepLinkCredentials('https://h/#api_key=S&theme=dark');
    expect(r.apiKey).toBe('S');
    expect(r.cleanUrl).toBe('/#theme=dark');
  });

  it('reports scrubbed=false and leaves the URL intact when no credential is present', () => {
    const r = _parseDeepLinkCredentials('https://h/path?page=2#top');
    expect(r.pin).toBeNull();
    expect(r.apiKey).toBeNull();
    expect(r.scrubbed).toBe(false);
    expect(r.cleanUrl).toBe('/path?page=2#top');
  });
});
