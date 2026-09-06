/**
 * macOS runs the window with decorations:false + titleBarStyle:"Overlay"
 * (tauri.conf.json, applied on every platform) so the OS draws the native
 * traffic-light cluster on top of the web content instead of reserving its
 * own row. Windows/Linux draw nothing there — decorations:false just hides
 * chrome, no controls get overlaid.
 *
 * The header's left block (status dot + kicker) had no inset for that zone
 * at all, so on macOS the traffic lights sat on top of it (#1860). The tabs
 * navStyle already reserves a flat 64px from the window edge for the same
 * cluster (`.header-area--tabs` in index.css) — this pins the rail/breadcrumb
 * mode to the same total, on macOS only, and confirms Windows/Linux are
 * untouched.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import Header from '../components/Header';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }),
}));

function setPlatform(value) {
  Object.defineProperty(navigator, 'platform', { value, configurable: true });
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

function renderHeader() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Header mode="dub" setMode={() => {}} modelStatus="idle" />
    </QueryClientProvider>,
  );
}

describe('Header left block — macOS traffic-light inset', () => {
  it('gets the mac inset class on macOS', () => {
    setPlatform('MacIntel');
    const { container } = renderHeader();
    expect(container.querySelector('.header-area__left--mac-inset')).not.toBeNull();
  });

  it('does not get the inset on Windows', () => {
    setPlatform('Win32');
    const { container } = renderHeader();
    expect(container.querySelector('.header-area__left--mac-inset')).toBeNull();
  });

  it('does not get the inset on Linux', () => {
    setPlatform('Linux x86_64');
    const { container } = renderHeader();
    expect(container.querySelector('.header-area__left--mac-inset')).toBeNull();
  });
});
