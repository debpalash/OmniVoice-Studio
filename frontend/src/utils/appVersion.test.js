import { describe, it, expect } from 'vitest';
import { resolveAboutVersion, APP_VERSION } from './appVersion';

describe('resolveAboutVersion (About → Version blank-in-web-build fix)', () => {
  it('prefers Tauri appVersion, then backend app_version, then the build constant', () => {
    expect(resolveAboutVersion('1.2.3', { app_version: '9.9.9' })).toBe('1.2.3');
    expect(resolveAboutVersion(null, { app_version: '9.9.9' })).toBe('9.9.9');
    expect(resolveAboutVersion('', { app_version: '9.9.9' })).toBe('9.9.9');
  });

  it('falls back to the build-time version and is NEVER blank/dash (web/Pinokio build)', () => {
    // Vite injects __APP_VERSION__ at build time (incl. under vitest), so the
    // constant is always a real version string.
    expect(APP_VERSION).toBeTruthy();
    expect(resolveAboutVersion(null, undefined)).toBe(APP_VERSION);
    expect(resolveAboutVersion(null, null)).toBe(APP_VERSION);
    expect(resolveAboutVersion(null, {})).toBe(APP_VERSION);
    expect(resolveAboutVersion(null, undefined)).not.toBe('');
    expect(resolveAboutVersion(null, undefined)).not.toBe('—');
  });
});
