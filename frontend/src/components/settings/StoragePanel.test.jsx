import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn() } }));
const apiJson = vi.fn();
const apiFetch = vi.fn();
vi.mock('../../api/client', () => ({
  apiJson: (...args) => apiJson(...args),
  apiFetch: (...args) => apiFetch(...args),
}));
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));

import StoragePanel from './StoragePanel';

describe('StoragePanel native path boundary', () => {
  it('never sends the selected models directory through HTTP', async () => {
    apiJson.mockResolvedValue({ configured: '', effective: '/cache', default: '/default' });
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ configured: '/private/models', restart_required: true }),
    });
    invoke.mockResolvedValue('d'.repeat(64));
    render(<StoragePanel />);

    const input = await screen.findByTestId('models-dir-input');
    fireEvent.change(input, { target: { value: '/private/models' } });
    fireEvent.click(screen.getByTestId('models-dir-save'));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('authorize_host_path', {
        kind: 'models_dir',
        path: '/private/models',
      }),
    );
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/settings/storage/models-dir',
      expect.objectContaining({ body: JSON.stringify({ authorization: 'd'.repeat(64) }) }),
    );
    expect(apiFetch.mock.calls.flat().join(' ')).not.toContain('/private/models');
  });
});
