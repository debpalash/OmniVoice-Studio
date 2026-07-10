import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../i18n';
import ModelsTable from '../components/settings/models/ModelsTable';
import RecoBanner from '../components/settings/models/RecoBanner';

const t = i18n.t.bind(i18n);

// Minimal stubs — the empty state renders regardless of the virtualizer,
// which yields no items in jsdom anyway.
const stubTable = { getHeaderGroups: () => [] };
const stubVirtualizer = {
  getTotalSize: () => 0,
  getVirtualItems: () => [],
  measureElement: () => {},
};

function renderEmptyTable(props = {}) {
  return render(
    <ModelsTable
      table={stubTable}
      tableRows={[]}
      rowVirtualizer={stubVirtualizer}
      tableBodyRef={{ current: null }}
      getRowRuntime={() => ({})}
      t={t}
      {...props}
    />,
  );
}

describe('ModelsTable — actionable empty state', () => {
  it('invites the user back with "Clear filters" when nothing matches', () => {
    const onClearFilters = vi.fn();
    renderEmptyTable({ onClearFilters });
    expect(screen.getByText(t('models.no_matches'))).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('models-clear-filters'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('renders the plain empty message for legacy callers without the action', () => {
    renderEmptyTable();
    expect(screen.getByText(t('models.no_matches'))).toBeInTheDocument();
    expect(screen.queryByTestId('models-clear-filters')).not.toBeInTheDocument();
  });
});

// ── RecoBanner — free-disk context next to the download actions ────────────

const RECO = {
  all_installed: false,
  device: { label: 'Apple M2 (16 GB)' },
  total_gb: 12.1,
  download_gb_remaining: 9.5,
  models: [
    {
      repo_id: 'a/required',
      label: 'Required model',
      size_gb: 3.5,
      required: true,
      installed: false,
    },
    { repo_id: 'b/nice', label: 'Nice-to-have', size_gb: 6.0, required: false, installed: false },
  ],
};

function renderBanner(props = {}) {
  return render(
    <RecoBanner
      reco={RECO}
      t={t}
      installMutation={{ mutateAsync: vi.fn() }}
      installingReco={false}
      setInstallingReco={vi.fn()}
      onInstallRecommended={vi.fn()}
      {...props}
    />,
  );
}

describe('RecoBanner — disk context near the download actions', () => {
  it('shows how much space the download has when free-disk data exists', () => {
    renderBanner({ diskFreeGb: 42.5 });
    expect(screen.getByTestId('reco-disk-context')).toHaveTextContent(
      '42.5 GB free on the model disk',
    );
    // Plenty of room → no warning.
    expect(screen.queryByTestId('reco-low-disk')).not.toBeInTheDocument();
  });

  it('warns plainly BEFORE a doomed download when the bundle exceeds free space', () => {
    renderBanner({ diskFreeGb: 4.2 });
    const warn = screen.getByTestId('reco-low-disk');
    expect(warn).toHaveTextContent('needs ~9.5 GB but only 4.2 GB is free');
    // It names the way out, not just the problem.
    expect(warn).toHaveTextContent(/install just the required models/i);
  });

  it('renders no disk context when the data is unavailable (legacy payload)', () => {
    renderBanner();
    expect(screen.queryByTestId('reco-disk-context')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reco-low-disk')).not.toBeInTheDocument();
  });
});
