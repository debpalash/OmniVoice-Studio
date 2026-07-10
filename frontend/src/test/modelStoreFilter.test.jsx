import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

// ── Feature: search/filter over the models table + actionable empty state ──
// The toolbar search drives TanStack's global filter across repo_id, label,
// note and role; the role Segmented drives a column filter. When nothing
// matches, the empty state offers "Clear filters" instead of a dead end.

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

const refetch = vi.fn();
const MODELS = [
  {
    repo_id: 'openbmb/VoxCPM2',
    label: 'VoxCPM2',
    role: 'tts',
    size_gb: 3.4,
    installed: true,
    note: 'voice design',
  },
  {
    repo_id: 'Systran/faster-whisper-large-v3',
    label: 'Faster-Whisper large-v3',
    role: 'asr',
    size_gb: 2.9,
    installed: false,
  },
  {
    repo_id: 'pyannote/speaker-diarization-3.1',
    label: 'Speaker diarization',
    role: 'diarisation',
    size_gb: 0.3,
    installed: true,
  },
];

vi.mock('../api/hooks', () => ({
  useModels: () => ({
    data: {
      models: MODELS,
      total_installed_bytes: 0,
      disk_free_gb: 42.5,
      hf_cache_dir: '/home/u/.cache/huggingface',
    },
    isLoading: false,
    refetch,
  }),
  useRecommendations: () => ({ data: null, refetch }),
  useInstallModel: () => ({ mutateAsync: vi.fn() }),
  useDeleteModel: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../api/setup', () => ({
  setupDownloadStreamUrl: () => 'http://localhost/stream',
  cancelInstallModel: vi.fn(),
}));
vi.mock('../api/system', () => ({
  listLoadedModels: vi.fn().mockResolvedValue({ models: [], count: 0 }),
  unloadLoadedModel: vi.fn(),
}));
vi.mock('../api/external', () => ({ openExternal: vi.fn() }));
vi.mock('../components/settings/models/RecoBanner', () => ({ default: () => null }));
// Surface the FILTERED row set (and the empty-state action) without the
// virtualizer, which yields no rows in jsdom. The filter itself — TanStack
// global/column filter state driven by the real toolbar — stays real.
vi.mock('../components/settings/models/ModelsTable', () => ({
  default: ({ tableRows, t, onClearFilters }) => (
    <div data-testid="mock-table">
      {tableRows.map((r) => (
        <div key={r.id} data-testid="visible-row">
          {r.original.label}
        </div>
      ))}
      {tableRows.length === 0 && (
        <div>
          <span>{t('models.no_matches')}</span>
          {onClearFilters && (
            <button data-testid="models-clear-filters" onClick={onClearFilters}>
              {t('models.clear_filters')}
            </button>
          )}
        </div>
      )}
    </div>
  ),
}));

import ModelStoreTab from '../components/settings/ModelStoreTab';

function mountTab() {
  global.EventSource = class {
    constructor() {
      this.onmessage = null;
    }
    close() {}
  };
  return render(
    <I18nextProvider i18n={i18n}>
      <ModelStoreTab info={{ has_hf_token: true }} modelBadge={null} />
    </I18nextProvider>,
  );
}

const visibleLabels = () => screen.queryAllByTestId('visible-row').map((n) => n.textContent);

describe('Model Store — search filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('narrows rows to matches on label / repo_id / note as the user types', async () => {
    mountTab();
    await waitFor(() => expect(visibleLabels()).toHaveLength(3));

    const search = screen.getByRole('searchbox', { name: i18n.t('models.search_label') });
    fireEvent.change(search, { target: { value: 'whisper' } });
    await waitFor(() => expect(visibleLabels()).toEqual(['Faster-Whisper large-v3']));

    // note text is searchable too ("voice design" → VoxCPM2)
    fireEvent.change(search, { target: { value: 'voice design' } });
    await waitFor(() => expect(visibleLabels()).toEqual(['VoxCPM2']));

    fireEvent.change(search, { target: { value: '' } });
    await waitFor(() => expect(visibleLabels()).toHaveLength(3));
  });

  it('shows the empty state with a working "Clear filters" action when nothing matches', async () => {
    mountTab();
    await waitFor(() => expect(visibleLabels()).toHaveLength(3));

    const search = screen.getByRole('searchbox', { name: i18n.t('models.search_label') });
    fireEvent.change(search, { target: { value: 'zzz-no-such-model' } });
    await waitFor(() => expect(visibleLabels()).toHaveLength(0));
    expect(screen.getByText(i18n.t('models.no_matches'))).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('models-clear-filters'));
    await waitFor(() => expect(visibleLabels()).toHaveLength(3));
    // The search box itself is reset — not just the rows.
    expect(search).toHaveValue('');
  });
});
