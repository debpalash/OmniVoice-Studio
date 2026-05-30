import { describe, it, expect } from 'vitest';
import { _resolveApiBase } from './client';

describe('_resolveApiBase', () => {
  it('served (non-Tauri, non-dev) → SAME ORIGIN (fixes remote LAN-share CORS)', () => {
    // A device opening the share URL: SPA served from :5050 must talk to :5050,
    // not a hardcoded :3900 (cross-origin + loopback-only).
    const win = { location: { origin: 'http://100.64.0.48:5050', hostname: '100.64.0.48' } };
    expect(_resolveApiBase({ DEV: false }, win)).toBe('http://100.64.0.48:5050');
  });

  it('Tauri webview → local sidecar (127.0.0.1)', () => {
    const win = { __TAURI__: {}, location: { origin: 'tauri://localhost', hostname: 'localhost' } };
    expect(_resolveApiBase({}, win)).toBe('http://127.0.0.1:3900');
  });

  it('vite dev → backend on :3900 (SPA :3901 → API :3900, CORS-allowed)', () => {
    const win = { location: { origin: 'http://localhost:3901', hostname: 'localhost' } };
    expect(_resolveApiBase({ DEV: true }, win)).toBe('http://localhost:3900');
  });

  it('VITE_API_URL overrides everything', () => {
    const win = { __TAURI__: {}, location: { origin: 'http://x', hostname: 'x' } };
    expect(_resolveApiBase({ VITE_API_URL: 'http://10.0.0.5:9' }, win)).toBe('http://10.0.0.5:9');
  });

  it('no window (SSR) → loopback', () => {
    expect(_resolveApiBase({}, undefined)).toBe('http://127.0.0.1:3900');
  });

  it('honors VITE_API_PORT', () => {
    const win = { __TAURI__: {}, location: { origin: 'x', hostname: 'x' } };
    expect(_resolveApiBase({ VITE_API_PORT: '4000' }, win)).toBe('http://127.0.0.1:4000');
  });
});
