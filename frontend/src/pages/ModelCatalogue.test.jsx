// Model Catalogue workspace — pane switching, deep-link hand-off, persistence.
//
// The two panes are mounted stand-ins for the real EnginesTab / ModelStoreTab
// (both of which have their own suites and both of which hit the network); this
// suite is about the workspace shell around them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../components/settings/EnginesTab', () => ({
  default: ({ initialFamily, catalogueLayout }) => (
    <div data-testid="stub-engines" data-catalogue-layout={catalogueLayout || undefined}>
      {initialFamily}
    </div>
  ),
}));
vi.mock('../components/settings/ModelStoreTab', () => ({
  default: ({ modelBadge, catalogueLayout }) => (
    <div data-testid="stub-models" data-catalogue-layout={catalogueLayout || undefined}>
      {modelBadge}
    </div>
  ),
}));
vi.mock('../api/hooks', () => ({
  useSystemInfo: () => ({ data: { has_hf_token: false } }),
  useModelStatus: () => ({ data: { status: 'ready' } }),
}));

import { useAppStore } from '../store';
import ModelCatalogue from './ModelCatalogue';

// Radix Tabs activate on POINTER DOWN, not click — a bare fireEvent.click
// leaves the pane unchanged and reads as a broken switcher. Drive the tab the
// way a pointer does.
const clickTab = (name) => {
  const tab = screen.getByRole('tab', { name });
  fireEvent.pointerDown(tab, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
};

describe('ModelCatalogue', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => {
      useAppStore.setState({
        mode: 'catalogue',
        pendingCatalogueTab: null,
        pendingCatalogueFamily: null,
      });
    });
  });

  it('opens on the Engines pane and switches to Models', () => {
    render(<ModelCatalogue />);
    expect(screen.getByTestId('stub-engines')).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Engines' })).toBeInTheDocument();
    expect(screen.getByTestId('stub-engines')).toHaveAttribute('data-catalogue-layout', 'true');
    expect(screen.queryByTestId('stub-models')).toBeNull();

    clickTab('Models');
    expect(screen.getByTestId('stub-models')).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Models' })).toBeInTheDocument();
    expect(screen.getByTestId('stub-models')).toHaveAttribute('data-catalogue-layout', 'true');
    expect(screen.queryByTestId('stub-engines')).toBeNull();
  });

  it('uses the wide workspace shell for data-heavy catalogue panes', () => {
    render(<ModelCatalogue />);
    expect(screen.getByTestId('model-catalogue').firstElementChild).toHaveClass('max-w-[1500px]');
  });

  it('associates each tab with its labelled panel', () => {
    render(<ModelCatalogue />);
    const enginesTab = screen.getByRole('tab', { name: 'Engines' });
    const enginesPanel = screen.getByRole('tabpanel', { name: 'Engines' });
    expect(enginesTab).toHaveAttribute('aria-controls', enginesPanel.id);
    expect(enginesPanel).toHaveAttribute('aria-labelledby', enginesTab.id);

    const modelsTab = screen.getByRole('tab', { name: 'Models' });
    clickTab('Models');
    const modelsPanel = screen.getByRole('tabpanel', { name: 'Models' });
    expect(modelsTab).toHaveAttribute('aria-controls', modelsPanel.id);
    expect(modelsPanel).toHaveAttribute('aria-labelledby', modelsTab.id);
  });

  it('remembers the pane across visits', () => {
    const first = render(<ModelCatalogue />);
    clickTab('Models');
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

  it('honours an engine-family deep link and clears it after hand-off', () => {
    act(() => {
      useAppStore.getState().openCatalogue({ pane: 'engines', family: 'asr' });
    });
    render(<ModelCatalogue />);
    expect(screen.getByTestId('stub-engines')).toHaveTextContent('asr');
    expect(useAppStore.getState().pendingCatalogueFamily).toBeNull();
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

  it('accepts an object deep link with a family', () => {
    act(() => {
      useAppStore.getState().openCatalogue({ pane: 'engines', family: 'llm' });
    });
    expect(useAppStore.getState().pendingCatalogueTab).toBe('engines');
    expect(useAppStore.getState().pendingCatalogueFamily).toBe('llm');
  });
});
