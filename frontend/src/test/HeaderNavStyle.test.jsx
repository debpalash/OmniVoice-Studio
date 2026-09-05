/**
 * Header ↔ navigation style seam.
 *
 * The titlebar tabs render INSIDE the header row, taking the space the
 * breadcrumb + wordmark normally hold. That swap is the one place the two
 * navigation skins can collide: leave the breadcrumb in and the bar says
 * where you are twice; leave the tabs out in tabs mode and the app has no
 * navigation at all (the rail isn't rendered either).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import Header from '../components/Header';

const windowActions = vi.hoisted(() => ({
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowActions }));

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

function renderHeader(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['sysinfo'], {});
  return render(
    <QueryClientProvider client={qc}>
      <Header mode="dub" setMode={() => {}} modelStatus="idle" {...props} />
    </QueryClientProvider>,
  );
}

describe('Header — rail mode (default)', () => {
  it('opens combined engine and memory controls from the global shortcut', () => {
    renderHeader({ onFlushMemory: vi.fn() });
    fireEvent(window, new Event('engine-quick-switch'));
    expect(screen.getByRole('dialog', { name: 'Engines' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Flush caches/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Speech' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Transcription' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole('tab', { name: 'Transcription' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('button', { name: /Unload all/ }).closest('details'),
    ).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Memory management'));
    expect(screen.getByRole('button', { name: /Unload all/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Engines' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Engines' })).toHaveFocus();
  });
  it('keeps the breadcrumb and wordmark, and renders no tab strip', () => {
    const { container } = renderHeader({});
    expect(container.querySelector('.tabstrip')).toBeNull();
    expect(container.querySelector('.header-area--tabs')).toBeNull();
    expect(screen.queryByTestId('titletab-dub')).toBeNull();
    // Breadcrumb (current view) + centred wordmark both stay.
    expect(container.textContent).toMatch(/VoiceStudio/);
    expect(screen.getByTestId('voice-studio-logo')).toBeInTheDocument();
    expect(container.textContent).toMatch(/Dub/);
  });

  it('uses the app header for native window controls', async () => {
    window.__TAURI_INTERNALS__ = {};
    renderHeader({});

    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }));
    await waitFor(() => expect(windowActions.minimize).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Maximize or restore window' }));
    await waitFor(() => expect(windowActions.toggleMaximize).toHaveBeenCalledOnce());
    expect(screen.getByTestId('window-controls')).toBeInTheDocument();
  });
});

describe('Header — titlebar tabs mode', () => {
  it('renders the tab strip in the title bar instead of the breadcrumb', () => {
    const { container } = renderHeader({ navStyle: 'tabs' });
    expect(container.querySelector('.header-area--tabs')).not.toBeNull();
    expect(container.querySelector('.tabstrip')).not.toBeNull();
    expect(screen.getByTestId('titletab-dub')).toHaveClass('is-active');
  });

  it('drops the centred wordmark — the tabs need that room', () => {
    const { container } = renderHeader({ navStyle: 'tabs' });
    expect(container.textContent).not.toMatch(/VoiceStudio/);
    expect(screen.queryByTestId('voice-studio-logo')).toBeNull();
  });
});
