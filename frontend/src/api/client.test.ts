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
    // #1164: the detail is now structured diagnostics — the transport cause
    // is preserved, plus mode/last-contact for the bug-report prefill.
    expect(String(err.detail.transport)).toMatch(/Failed to fetch/);
    expect(err.detail).toMatchObject({ mode: 'dev', attempts: 4 });
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

describe('apiFetch 404 from a non-OmniVoice server (#1385)', () => {
  // A rehosted UI (static host, reverse proxy) whose API requests land on the
  // wrong host gets that host's 404 page back. Echoing it ("NOT_FOUND
  // bom1::…") is useless — the error must say where requests are going.
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stub404 = (body: string) =>
    vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => body,
      }),
    ) as any;

  const thrownBy = async (body: string) => {
    globalThis.fetch = stub404(body);
    const { apiFetch } = await import('./client');
    try {
      await apiFetch('/generate');
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected apiFetch to throw');
  };

  it('names the misrouted host instead of echoing its 404 page', async () => {
    const err = await thrownBy(
      'The page could not be found\n\nNOT_FOUND\n\nbom1::2lhsl-1786000655272',
    );
    expect(err.message).toMatch(/not an OmniVoice backend/);
    expect(err.message).toMatch(/Backend URL in Settings/);
    expect(err.message).not.toMatch(/bom1/);
  });

  it("keeps the plain message for the backend's own JSON 404", async () => {
    const err = await thrownBy(JSON.stringify({ detail: 'Voice not found' }));
    expect(err.message).toMatch(/404 Not Found: Voice not found/);
    expect(err.message).not.toMatch(/not an OmniVoice backend/);
  });

  it('treats Starlette StaticFiles\' plain-text "Not Found" as the backend speaking', async () => {
    // Mounted StaticFiles apps answer text/plain "Not Found" — the one
    // non-JSON 404 the backend itself produces. Not a routing problem.
    const err = await thrownBy('Not Found');
    expect(err.message).not.toMatch(/not an OmniVoice backend/);
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
