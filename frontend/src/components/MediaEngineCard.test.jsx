import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api/client', () => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
}));

import { apiJson, apiFetch } from '../api/client';
import MediaEngineCard from './MediaEngineCard';

const statusWith = (ready, acquire) => ({
  ready,
  tools: {},
  ops: { acquire: acquire || { state: 'idle', progress: 0, error: null } },
});

describe('MediaEngineCard — invisible-by-default media engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it('renders NOTHING when the media engine is resolved (the ideal outcome)', async () => {
    apiJson.mockResolvedValue(statusWith(true));
    const { container } = render(<MediaEngineCard />);
    await waitFor(() => expect(apiJson).toHaveBeenCalledWith('/media-tools/status'));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('media-engine-card')).not.toBeInTheDocument();
  });

  it('shows only a quiet progress line while the bundled build downloads', async () => {
    apiJson.mockResolvedValue(statusWith(false, { state: 'running', progress: 0.42, error: null }));
    render(<MediaEngineCard />);
    const line = await screen.findByTestId('media-engine-progress');
    expect(line).toHaveTextContent('Preparing media engine…');
    expect(line).toHaveTextContent('42%');
    // No requirements-style card, no mention of package managers.
    expect(screen.queryByTestId('media-engine-card')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/brew|apt|choco/i);
  });

  it('shows the actionable failure card only when acquisition failed', async () => {
    apiJson.mockResolvedValue(
      statusWith(false, { state: 'error', progress: 0, error: 'download checksum mismatch' }),
    );
    render(<MediaEngineCard />);
    const card = await screen.findByTestId('media-engine-card');
    expect(card).toHaveTextContent('Media engine download failed');
    expect(screen.getByTestId('media-engine-error')).toHaveTextContent(
      'download checksum mismatch',
    );
    expect(screen.getByTestId('media-engine-retry')).toBeInTheDocument();
    expect(screen.getByTestId('media-engine-use-system')).toBeInTheDocument();
  });

  it('Retry re-posts the acquisition endpoint', async () => {
    apiJson.mockResolvedValue(statusWith(false, { state: 'error', error: 'boom' }));
    render(<MediaEngineCard />);
    fireEvent.click(await screen.findByTestId('media-engine-retry'));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/media-tools/acquire', expect.anything()),
    );
  });

  it('Use a system copy posts use-system and surfaces a not-found detail', async () => {
    apiJson.mockResolvedValue(statusWith(false, { state: 'error', error: 'boom' }));
    apiFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        detail: 'No system ffmpeg found on PATH or in the usual install locations.',
      }),
    });
    render(<MediaEngineCard />);
    fireEvent.click(await screen.findByTestId('media-engine-use-system'));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/media-tools/ffmpeg/use-system', expect.anything()),
    );
    expect(await screen.findByTestId('media-engine-error')).toHaveTextContent(
      'No system ffmpeg found',
    );
  });

  it('Choose file… falls back to an inline path input outside Tauri and saves it', async () => {
    apiJson.mockResolvedValue(statusWith(false, { state: 'error', error: 'boom' }));
    render(<MediaEngineCard />);
    fireEvent.click(await screen.findByText('Choose file…'));
    const input = await screen.findByTestId('media-engine-path');
    fireEvent.change(input, { target: { value: '/usr/local/bin/ffmpeg' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/media-tools/ffmpeg/custom-path',
        expect.objectContaining({ body: JSON.stringify({ path: '/usr/local/bin/ffmpeg' }) }),
      ),
    );
  });
});
