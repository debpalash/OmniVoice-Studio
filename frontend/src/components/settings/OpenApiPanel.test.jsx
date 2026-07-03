import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

// Stub Scalar's heavy bundled component — we only need to assert the panel
// mounts the reference container, not exercise the real Vue app in jsdom.
vi.mock('@scalar/api-reference-react', async () => {
  const { jsx } = await import('react/jsx-runtime');
  return { ApiReferenceReact: () => jsx('div', { 'data-testid': 'scalar-mock' }) };
});

// Control the spec fetch + backend base without a live backend.
vi.mock('../../api/client', () => ({
  API: 'http://127.0.0.1:3900',
  apiFetch: vi.fn(),
}));

import OpenApiPanel from './OpenApiPanel';
import { apiFetch } from '../../api/client';

const MINIMAL_SPEC = {
  openapi: '3.1.0',
  info: { title: 'OmniVoice', version: '0.0.0' },
  paths: {},
};

describe('OpenApiPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the local /openapi.json spec and renders the Scalar reference', async () => {
    apiFetch.mockResolvedValue({ json: async () => MINIMAL_SPEC });

    render(<OpenApiPanel />);

    // The spec is fetched from the backend root route (not under /api).
    expect(apiFetch).toHaveBeenCalledWith('/openapi.json');

    // Reference container + embedded (mocked) Scalar component mount.
    expect(await screen.findByTestId('scalar-mock')).toBeInTheDocument();
    expect(screen.getByTestId('openapi-reference')).toBeInTheDocument();

    // Copy / open-raw affordances point at the resolved backend base.
    expect(screen.getByText('http://127.0.0.1:3900/openapi.json')).toBeInTheDocument();
    expect(screen.getByTestId('openapi-copy-url')).toBeInTheDocument();
    expect(screen.getByTestId('openapi-open-raw')).toBeInTheDocument();
  });

  it('shows the unreachable-backend fallback when the spec fetch fails', async () => {
    apiFetch.mockRejectedValue(new Error('backend down'));

    render(<OpenApiPanel />);

    const fallback = await screen.findByTestId('openapi-unreachable');
    expect(fallback).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('openapi-retry')).toBeInTheDocument();

    // Scalar must never mount when the spec can't be reached.
    expect(screen.queryByTestId('scalar-mock')).not.toBeInTheDocument();
  });

  it('recovers when Retry succeeds after an initial failure', async () => {
    apiFetch
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValueOnce({ json: async () => MINIMAL_SPEC });

    render(<OpenApiPanel />);

    fireEvent.click(await screen.findByTestId('openapi-retry'));

    expect(await screen.findByTestId('scalar-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('openapi-unreachable')).not.toBeInTheDocument();
  });
});
