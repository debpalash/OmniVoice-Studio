import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../api/client', () => ({
  LS_BACKEND_URL: 'ov_backend_url',
  LS_API_KEY: 'ov_api_key',
  API: 'http://127.0.0.1:3900',
}));

// Shared confirmation dialog (Tauri-aware) — controlled per test.
const { askConfirm } = vi.hoisted(() => ({ askConfirm: vi.fn() }));
vi.mock('../../utils/dialog', () => ({ askConfirm }));

import toast from 'react-hot-toast';
import RemoteBackendPanel, { isValidBackendUrl } from './RemoteBackendPanel';

describe('isValidBackendUrl', () => {
  it('accepts absolute http(s) URLs only', () => {
    expect(isValidBackendUrl('http://gpu-box:3900')).toBe(true);
    expect(isValidBackendUrl('https://gpu-box.tailnet.ts.net:3900')).toBe(true);
    // The classic typo: schemeless host:port parses as a URL with a bogus
    // protocol — it must NOT be accepted (it bricks every call post-reload).
    expect(isValidBackendUrl('gpu-box:3900')).toBe(false);
    expect(isValidBackendUrl('not a url')).toBe(false);
    expect(isValidBackendUrl('ftp://gpu-box')).toBe(false);
    expect(isValidBackendUrl('')).toBe(false);
  });
});

describe('RemoteBackendPanel', () => {
  let reload;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    reload = vi.fn();
  });

  const setUrl = (value) =>
    fireEvent.change(screen.getByTestId('remote-backend-url'), { target: { value } });
  const clickSave = () => fireEvent.click(screen.getByTestId('remote-backend-save'));

  it('rejects an invalid URL instead of saving and reloading into a broken app', async () => {
    render(<RemoteBackendPanel reload={reload} />);
    setUrl('gpu-box:3900');
    clickSave();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem('ov_backend_url')).toBeNull();
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it('asks for confirmation before saving an unverified URL, and aborts on decline', async () => {
    askConfirm.mockResolvedValue(false);
    render(<RemoteBackendPanel reload={reload} />);
    setUrl('http://gpu-box:3900');
    clickSave();

    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem('ov_backend_url')).toBeNull();
  });

  it('saves and reloads an unverified URL when the user confirms', async () => {
    askConfirm.mockResolvedValue(true);
    render(<RemoteBackendPanel reload={reload} />);
    setUrl('http://gpu-box:3900/');
    clickSave();

    await waitFor(() => expect(reload).toHaveBeenCalled());
    // Trailing slashes are normalized before persisting.
    expect(localStorage.getItem('ov_backend_url')).toBe('http://gpu-box:3900');
  });

  it('skips the confirmation when the exact URL passed a connection test', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.3.15', device: 'cuda' }),
    });
    render(<RemoteBackendPanel reload={reload} />);
    setUrl('http://gpu-box:3900');

    fireEvent.click(screen.getByTestId('remote-backend-test'));
    await screen.findByText('OK — 0.3.15 on cuda');

    clickSave();
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(askConfirm).not.toHaveBeenCalled();
    expect(localStorage.getItem('ov_backend_url')).toBe('http://gpu-box:3900');
  });

  it('clears both settings and reloads without confirmation when the URL is emptied', async () => {
    localStorage.setItem('ov_backend_url', 'http://old-box:3900');
    localStorage.setItem('ov_api_key', 'k');
    render(<RemoteBackendPanel reload={reload} />);
    setUrl('');
    fireEvent.change(screen.getByTestId('remote-backend-key'), { target: { value: '' } });
    clickSave();

    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(askConfirm).not.toHaveBeenCalled();
    expect(localStorage.getItem('ov_backend_url')).toBeNull();
    expect(localStorage.getItem('ov_api_key')).toBeNull();
  });

  it('renders localized strings and labelled inputs (no hardcoded-English bypass)', () => {
    render(<RemoteBackendPanel reload={reload} />);
    // Strings resolve through i18n (en locale in tests) …
    expect(screen.getByText('Remote backend')).toBeInTheDocument();
    expect(screen.getByText('Test connection')).toBeInTheDocument();
    expect(screen.getByText('Save & reload')).toBeInTheDocument();
    // … and both inputs carry accessible names.
    expect(screen.getByLabelText('Backend URL')).toBeInTheDocument();
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
  });
});
