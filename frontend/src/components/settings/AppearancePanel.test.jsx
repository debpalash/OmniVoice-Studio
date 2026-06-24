import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import AppearancePanel from './AppearancePanel';
import { useAppStore, FONT_OPTIONS } from '../../store';

describe('AppearancePanel — global font selection', () => {
  beforeEach(() => {
    // Deterministic start: reset font to default and clear any DOM override.
    useAppStore.getState().setFont('default');
    document.documentElement.style.removeProperty('--font-sans');
  });

  it('renders the font grid with a tile for every FONT_OPTION', () => {
    render(<AppearancePanel />);
    const group = screen.getByRole('radiogroup', { name: 'Font' });
    expect(group).toBeInTheDocument();

    for (const opt of FONT_OPTIONS) {
      const tile = screen.getByTestId(`appearance-font-${opt.id}`);
      expect(tile).toBeInTheDocument();
    }
    // Defaults to the persisted 'default' font (its tile is checked).
    expect(screen.getByTestId('appearance-font-default')).toHaveAttribute('aria-checked', 'true');
  });

  it('selecting a non-default font updates the store and sets --font-sans', () => {
    render(<AppearancePanel />);

    fireEvent.click(screen.getByTestId('appearance-font-serif'));

    // Store reflects the selection.
    expect(useAppStore.getState().font).toBe('serif');
    // The serif tile shows as checked.
    expect(screen.getByTestId('appearance-font-serif')).toHaveAttribute('aria-checked', 'true');
    // The global font override is applied on the document root.
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toMatch(/Georgia/);
  });

  it('switching back to default removes the --font-sans override', () => {
    render(<AppearancePanel />);

    fireEvent.click(screen.getByTestId('appearance-font-mono'));
    expect(document.documentElement.style.getPropertyValue('--font-sans')).not.toBe('');

    fireEvent.click(screen.getByTestId('appearance-font-default'));
    expect(useAppStore.getState().font).toBe('default');
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('');
  });
});

describe('AppearancePanel — auto-play preview toggle (#666)', () => {
  it('defaults to ON (preserves existing auto-play behavior)', () => {
    expect(useAppStore.getState().autoPlayPreview).toBe(true);
    render(<AppearancePanel />);
    expect(screen.getByTestId('autoplay-preview')).toBeChecked();
  });

  it('toggling off updates the store so renders no longer auto-play', () => {
    render(<AppearancePanel />);
    fireEvent.click(screen.getByTestId('autoplay-preview'));
    expect(useAppStore.getState().autoPlayPreview).toBe(false);
    expect(screen.getByTestId('autoplay-preview')).not.toBeChecked();
    // restore default for other tests
    useAppStore.getState().setAutoPlayPreview(true);
  });
});
