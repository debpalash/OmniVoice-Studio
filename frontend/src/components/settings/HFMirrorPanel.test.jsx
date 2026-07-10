import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../api/client', () => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
}));

import toast from 'react-hot-toast';
import { apiJson, apiFetch } from '../../api/client';
import HFMirrorPanel from './HFMirrorPanel';

const STATE = {
  configured: 'https://hf-mirror.com',
  effective: 'https://hf-mirror.com',
  presets: [
    { label: 'Official (huggingface.co)', url: '' },
    { label: 'hf-mirror.com (community, China)', url: 'https://hf-mirror.com' },
  ],
};

describe('HFMirrorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the panel visible with an error and a Retry when the initial GET fails', async () => {
    // The restricted-network user whose backend GET 500s is exactly the user
    // who needs this panel — it must never silently vanish.
    apiJson.mockRejectedValueOnce(new Error('HTTP 500'));

    render(<HFMirrorPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
    expect(screen.getByText('Hugging Face mirror')).toBeInTheDocument();

    // Retry re-fetches and renders the rows.
    apiJson.mockResolvedValueOnce(STATE);
    fireEvent.click(screen.getByTestId('hf-mirror-retry'));

    expect(await screen.findByTestId('hf-mirror-url')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a loading state while the GET is in flight (never an empty gap)', () => {
    apiJson.mockReturnValue(new Promise(() => {}));
    render(<HFMirrorPanel />);
    expect(screen.getByText('Hugging Face mirror')).toBeInTheDocument();
    expect(screen.getByTestId('hf-mirror-loading')).toBeInTheDocument();
  });

  it('marks the configured preset as active', async () => {
    apiJson.mockResolvedValue(STATE);
    render(<HFMirrorPanel />);

    const mirror = await screen.findByTestId('hf-preset-https://hf-mirror.com');
    const official = screen.getByTestId('hf-preset-official');
    expect(mirror).toHaveAttribute('aria-pressed', 'true');
    expect(official).toHaveAttribute('aria-pressed', 'false');
  });

  it('labels the custom-URL row in plain language and toasts on save', async () => {
    apiJson.mockResolvedValue(STATE);
    apiFetch.mockResolvedValue({
      json: async () => ({ configured: 'https://mirror.example', restart_required: true }),
    });

    render(<HFMirrorPanel />);

    // Plain translated label (HF_ENDPOINT is a subtitle detail, not the title),
    // and the input carries an accessible name.
    const input = await screen.findByLabelText('Custom mirror URL');
    expect(screen.getByText('Custom mirror URL')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'https://mirror.example' } });
    fireEvent.click(screen.getByTestId('hf-mirror-save'));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mirror setting saved'));
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/settings/hf-mirror',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});
