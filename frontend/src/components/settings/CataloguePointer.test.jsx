import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { useAppStore } from '../../store';
import CataloguePointer from './CataloguePointer';

describe('CataloguePointer', () => {
  beforeEach(() => {
    act(() => {
      useAppStore.setState({ mode: 'settings', pendingCatalogueTab: null });
    });
  });

  it('sends the Engines category to the catalogue engines pane', () => {
    render(<CataloguePointer area="engines" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Engines' }));
    expect(useAppStore.getState().mode).toBe('catalogue');
    expect(useAppStore.getState().pendingCatalogueTab).toBe('engines');
  });

  it('sends the Models category to the catalogue models pane', () => {
    render(<CataloguePointer area="models" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Models' }));
    expect(useAppStore.getState().mode).toBe('catalogue');
    expect(useAppStore.getState().pendingCatalogueTab).toBe('models');
  });
});
