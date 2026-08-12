// Model Catalogue workspace — pane switching, deep-link hand-off, persistence.
//
// The two panes are mounted stand-ins for the real EnginesTab / ModelStoreTab
// (both of which have their own suites and both of which hit the network); this
// suite is about the workspace shell around them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../components/settings/EnginesTab', () => ({
  default: () => <div data-testid="stub-engines" />,
}));
vi.mock('../components/settings/ModelStoreTab', () => ({
  default: ({ modelBadge }) => <div data-testid="stub-models">{modelBadge}</div>,
}));
vi.mock('../api/hooks', () => ({
  useSystemInfo: () => ({ data: { has_hf_token: false } }),
  useModelStatus: () => ({ data: { status: 'ready' } }),
}));

import { useAppStore } from '../store';
import ModelCatalogue from './ModelCatalogue';

describe('ModelCatalogue', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => {
      useAppStore.setState({ mode: 'catalogue', pendingCatalogueTab: null });
    });
  });

  it('opens on the Engines pane and switches to Models', () => {
    render(<ModelCatalogue />);
    expect(screen.getByTestId('stub-engines')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-models')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Models' }));
    expect(screen.getByTestId('stub-models')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-engines')).toBeNull();
  });

  it('remembers the pane across visits', () => {
    const first = render(<ModelCatalogue />);
    fireEvent.click(screen.getByRole('radio', { name: 'Models' }));
    first.unmount();

    render(<ModelCatalogue />);
    expect(screen.getByTestId('stub-models')).toBeInTheDocument();
  });

  it('honours a pending deep-link pane on first paint and clears it', () => {
    act(() => {
      useAppStore.setState({ pendingCatalogueTab: 'models' });
    });
    render(<ModelCatalogue />);
    expect(screen.getByTestId('stub-models')).toBeInTheDocument();
    expect(useAppStore.getState().pendingCatalogueTab).toBeNull();
  });

  it('switches pane when a deep-link arrives while already mounted', () => {
    render(<ModelCatalogue />);
    expect(screen.getByTestId('stub-engines')).toBeInTheDocument();

    act(() => {
      useAppStore.getState().openCatalogue('models');
    });
    expect(screen.getByTestId('stub-models')).toBeInTheDocument();
    expect(useAppStore.getState().pendingCatalogueTab).toBeNull();
  });

  it('passes the loaded-model badge down to the model store pane', () => {
    act(() => {
      useAppStore.setState({ pendingCatalogueTab: 'models' });
    });
    render(<ModelCatalogue />);
    // 'ready' status → the ready badge renders inside the models pane.
    expect(screen.getByTestId('stub-models').textContent).toBeTruthy();
  });
});

describe('openCatalogue', () => {
  it('navigates to the catalogue workspace on the requested pane', () => {
    act(() => {
      useAppStore.setState({ mode: 'settings', pendingCatalogueTab: null });
      useAppStore.getState().openCatalogue('models');
    });
    expect(useAppStore.getState().mode).toBe('catalogue');
    expect(useAppStore.getState().pendingCatalogueTab).toBe('models');
  });

  it('defaults to the engines pane', () => {
    act(() => {
      useAppStore.setState({ pendingCatalogueTab: null });
      useAppStore.getState().openCatalogue();
    });
    expect(useAppStore.getState().pendingCatalogueTab).toBe('engines');
  });
});
