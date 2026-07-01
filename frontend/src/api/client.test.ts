import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
