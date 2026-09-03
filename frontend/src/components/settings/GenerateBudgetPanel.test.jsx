import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../api/client', () => ({
  apiJson: vi.fn(),
  apiPost: vi.fn(),
}));

import { toast } from 'react-hot-toast';
import { apiJson, apiPost } from '../../api/client';
import GenerateBudgetPanel from './GenerateBudgetPanel';

describe('GenerateBudgetPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiJson.mockResolvedValue({ generate_timeout_s: 300, cpu_generate_timeout_s: 600 });
    apiPost.mockResolvedValue({ key: 'x', set: true });
  });

  it('prefills both budgets from /system/info', async () => {
    render(<GenerateBudgetPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('generate-timeout-input-OMNIVOICE_GENERATE_TIMEOUT_S')).toHaveValue(
        300,
      ),
    );
    expect(
      screen.getByTestId('generate-timeout-input-OMNIVOICE_CPU_GENERATE_TIMEOUT_S'),
    ).toHaveValue(600);
  });

  it('surfaces both env var names', async () => {
    render(<GenerateBudgetPanel />);
    await waitFor(() => screen.getByText('OMNIVOICE_GENERATE_TIMEOUT_S'));
    expect(screen.getByText('OMNIVOICE_CPU_GENERATE_TIMEOUT_S')).toBeInTheDocument();
  });

  it('every row carries the restart-required badge — the value is import-time captured', async () => {
    render(<GenerateBudgetPanel />);
    await waitFor(() => screen.getAllByText('Restart required'));
    expect(screen.getAllByText('Restart required')).toHaveLength(2);
  });

  it('saving posts the new value to /system/set-env', async () => {
    render(<GenerateBudgetPanel />);
    const input = await screen.findByTestId('generate-timeout-input-OMNIVOICE_GENERATE_TIMEOUT_S');
    fireEvent.change(input, { target: { value: '900' } });
    fireEvent.click(screen.getByTestId('generate-timeout-save-OMNIVOICE_GENERATE_TIMEOUT_S'));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/system/set-env', {
        key: 'OMNIVOICE_GENERATE_TIMEOUT_S',
        value: '900',
      }),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('rejects a non-positive value client-side without calling the API', async () => {
    render(<GenerateBudgetPanel />);
    const input = await screen.findByTestId(
      'generate-timeout-input-OMNIVOICE_CPU_GENERATE_TIMEOUT_S',
    );
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('generate-timeout-save-OMNIVOICE_CPU_GENERATE_TIMEOUT_S'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('rejects a value above the max client-side without calling the API', async () => {
    render(<GenerateBudgetPanel />);
    const input = await screen.findByTestId(
      'generate-timeout-input-OMNIVOICE_CPU_GENERATE_TIMEOUT_S',
    );
    fireEvent.change(input, { target: { value: '999999' } });
    fireEvent.click(screen.getByTestId('generate-timeout-save-OMNIVOICE_CPU_GENERATE_TIMEOUT_S'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(apiPost).not.toHaveBeenCalled();
  });
});
