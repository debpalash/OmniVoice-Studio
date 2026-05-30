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

  it('renders the font select with all FONT_OPTIONS', () => {
    render(<AppearancePanel />);
    const select = screen.getByTestId('appearance-font-select');
    expect(select).toBeInTheDocument();

    for (const opt of FONT_OPTIONS) {
      expect(screen.getByRole('option', { name: opt.label })).toBeInTheDocument();
    }
    // Defaults to the persisted 'default' font.
    expect(select.value).toBe('default');
  });

  it('selecting a non-default font updates the store and sets --font-sans', () => {
    render(<AppearancePanel />);
    const select = screen.getByTestId('appearance-font-select');

    fireEvent.change(select, { target: { value: 'serif' } });

    // Store reflects the selection.
    expect(useAppStore.getState().font).toBe('serif');
    // The select shows the new value.
    expect(select.value).toBe('serif');
    // The global font override is applied on the document root.
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toMatch(/Georgia/);
  });

  it('switching back to default removes the --font-sans override', () => {
    render(<AppearancePanel />);
    const select = screen.getByTestId('appearance-font-select');

    fireEvent.change(select, { target: { value: 'mono' } });
    expect(document.documentElement.style.getPropertyValue('--font-sans')).not.toBe('');

    fireEvent.change(select, { target: { value: 'default' } });
    expect(useAppStore.getState().font).toBe('default');
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('');
  });
});
