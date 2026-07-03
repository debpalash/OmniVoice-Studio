import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

// ── Enhancement: unify the two HF-token entry points ───────────────────────
// The Models toolbar used to save the token via /system/set-env (env var +
// HF-CLI file) while Settings → Credentials saves to the encrypted app store —
// two stores with an asymmetric clear path (Credentials' "Clear" couldn't
// remove a toolbar-set token). This test locks the toolbar onto the SAME
// canonical app-store endpoint Credentials uses (/api/settings/hf-token), and
// guards against a regression back to /system/set-env.

const apiPost = vi.fn(() => Promise.resolve({ active: 'app', sources: [] }));
vi.mock('../api/client', () => ({
  apiPost: (...a) => apiPost(...a),
  apiFetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
}));

const refetch = vi.fn();
vi.mock('../api/hooks', () => ({
  useModels: () => ({
    data: {
      models: [],
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
vi.mock('../api/external', () => ({ openExternal: vi.fn() }));
// Keep the render light + focused on the toolbar.
vi.mock('../components/settings/models/ModelsTable', () => ({ default: () => null }));
vi.mock('../components/settings/models/RecoBanner', () => ({ default: () => null }));

import ModelStoreTab from '../components/settings/ModelStoreTab';

function withI18n(node) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}

describe('Model Store toolbar — HF token saves to the canonical app store', () => {
  beforeEach(() => {
    apiPost.mockClear();
    global.EventSource = class {
      constructor() {
        this.onmessage = null;
      }
      close() {}
    };
  });
  afterEach(() => vi.restoreAllMocks());

  async function openAndSave(token) {
    render(withI18n(<ModelStoreTab info={{ has_hf_token: false }} modelBadge={null} />));
    // The compact toolbar shows a "HF Token" trigger when no token is set.
    fireEvent.click(screen.getByRole('button', { name: /HF Token/i }));
    const input = screen.getByPlaceholderText(/hf_/i);
    fireEvent.change(input, { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.save') }));
  }

  it('POSTs the token to /api/settings/hf-token (same store as Credentials)', async () => {
    await openAndSave('hf_abc123');
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/settings/hf-token', { token: 'hf_abc123' });
  });

  it('never routes the token through the legacy /system/set-env store', async () => {
    await openAndSave('hf_xyz');
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    for (const call of apiPost.mock.calls) {
      expect(call[0]).not.toContain('/system/set-env');
    }
    expect(apiPost).toHaveBeenCalledWith('/api/settings/hf-token', { token: 'hf_xyz' });
  });
});
