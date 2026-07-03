// ContactPage — render-level coverage for the "Get in touch" page: the
// friendly header, every guidance section (bug / feature / community /
// support / security), each channel pointing at the right URL, the in-app
// bug-report affordance, and the Support card routing to the donate page
// (never duplicating the Ko-fi/PayPal surface here). openExternal is mocked so
// no real browser/window navigation happens; the store is the real one.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('../api/external', () => ({ openExternal }));

import ContactPage from '../pages/ContactPage';
import { useAppStore } from '../store';

const REPO = 'https://github.com/debpalash/OmniVoice-Studio';

beforeEach(() => {
  openExternal.mockClear();
  useAppStore.getState().setMode?.('launchpad');
});

describe('ContactPage', () => {
  it('renders the friendly header and every guidance section', () => {
    render(<ContactPage onBack={() => {}} />);
    expect(screen.getByRole('heading', { name: /love to hear from you/i })).toBeInTheDocument();
    for (const name of [
      'Report a bug',
      'Request a feature or ask',
      'Get help & community',
      'Support the project',
      'Report a security issue',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });

  it('exposes the in-app bug-report affordance', () => {
    render(<ContactPage onBack={() => {}} />);
    expect(screen.getByRole('button', { name: /open bug reporter/i })).toBeInTheDocument();
  });

  it('points each external channel at the right URL', () => {
    render(<ContactPage onBack={() => {}} />);
    const href = (name) => screen.getByRole('link', { name }).getAttribute('href');
    expect(href('Open GitHub Issues')).toBe(`${REPO}/issues`);
    expect(href('Join the Discord')).toBe('https://discord.gg/bzQavDfVV9');
    expect(href('Report privately')).toBe(`${REPO}/security/advisories/new`);
    expect(href(/licensing/i)).toBe(`mailto:OmniVoice@palash.dev`);
    expect(href(/more about the project/i)).toBe('https://palash.dev');
  });

  it('opens external links via the shared opener and marks them noreferrer', () => {
    render(<ContactPage onBack={() => {}} />);
    const link = screen.getByRole('link', { name: 'Join the Discord' });
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith('https://discord.gg/bzQavDfVV9');
  });

  it('routes "Support the project" to the in-app Support page (no Ko-fi duplication)', () => {
    render(<ContactPage onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'See ways to support' }));
    expect(useAppStore.getState().mode).toBe('donate');
  });
});
