/**
 * Header ↔ navigation style seam.
 *
 * The titlebar tabs render INSIDE the header row, taking the space the
 * breadcrumb + wordmark normally hold. That swap is the one place the two
 * navigation skins can collide: leave the breadcrumb in and the bar says
 * where you are twice; leave the tabs out in tabs mode and the app has no
 * navigation at all (the rail isn't rendered either).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import Header from '../components/Header';

function renderHeader(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Header mode="dub" setMode={() => {}} modelStatus="idle" {...props} />
    </QueryClientProvider>,
  );
}

describe('Header — rail mode (default)', () => {
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
