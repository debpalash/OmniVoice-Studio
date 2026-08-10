import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyUiScale } from './uiScaleEngine';

describe('applyUiScale', () => {
  beforeEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete document.documentElement.dataset.uiScaleEngine;
  });

  it('uses native webview zoom in Tauri and only then disables CSS zoom', async () => {
    window.__TAURI_INTERNALS__ = {};
    const setZoom = vi.fn().mockResolvedValue(undefined);

    await expect(
      applyUiScale(0.85, async () => ({ getCurrentWebview: () => ({ setZoom }) })),
    ).resolves.toBe('native');

    expect(setZoom).toHaveBeenCalledWith(0.85);
    expect(document.documentElement.dataset.uiScaleEngine).toBe('native');
  });

  it('keeps the viewport-filling CSS path in a browser', async () => {
    const loadWebview = vi.fn();

    await expect(applyUiScale(1.15, loadWebview)).resolves.toBe('css');

    expect(loadWebview).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.uiScaleEngine).toBe('css');
  });

  it('keeps CSS zoom active when native zoom is unavailable', async () => {
    window.__TAURI_INTERNALS__ = {};

    await expect(
      applyUiScale(0.9, async () => {
        throw new Error('webview zoom unavailable');
      }),
    ).resolves.toBe('css');

    expect(document.documentElement.dataset.uiScaleEngine).toBe('css');
  });
});
