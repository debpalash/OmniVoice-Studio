import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const STATE_THREE_UNSET = {
  active: null,
  sources: [
    { source: 'app', set: false, masked: null, whoami_user: null, whoami_ok: false },
    { source: 'env', set: false, masked: null, whoami_user: null, whoami_ok: false },
    { source: 'hf-cli', set: false, masked: null, whoami_user: null, whoami_ok: false },
  ],
};

const STATE_APP_ACTIVE = {
  active: 'app',
  sources: [
    { source: 'app', set: true, masked: 'hf_…abc', whoami_user: 'alice', whoami_ok: true },
    { source: 'env', set: false, masked: null, whoami_user: null, whoami_ok: false },
    { source: 'hf-cli', set: false, masked: null, whoami_user: null, whoami_ok: false },
  ],
};

const STATE_ENV_ACTIVE = {
  active: 'env',
  sources: [
    { source: 'app', set: false, masked: null, whoami_user: null, whoami_ok: false },
    { source: 'env', set: true, masked: 'hf_…xyz', whoami_user: 'bob', whoami_ok: true },
    { source: 'hf-cli', set: false, masked: null, whoami_user: null, whoami_ok: false },
  ],
};

function mockFetchOnce(payload, status = 200) {
  return vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
}

function mockFetchSequence(...responses) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    });
  }
  return fn;
}

import ApiKeysPanel from './ApiKeysPanel';

describe('ApiKeysPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders 3 source rows after mount', async () => {
    global.fetch = mockFetchOnce(STATE_THREE_UNSET);
    const { container } = render(<ApiKeysPanel />);
    await waitFor(() => {
      const rows = container.querySelectorAll('.apikeys-row');
      expect(rows.length).toBe(3);
      expect(container.querySelector('[data-source="app"]')).not.toBeNull();
      expect(container.querySelector('[data-source="env"]')).not.toBeNull();
      expect(container.querySelector('[data-source="hf-cli"]')).not.toBeNull();
    });
  });

  it('shows the Active badge on the row matching state.active', async () => {
    global.fetch = mockFetchOnce(STATE_APP_ACTIVE);
    const { container } = render(<ApiKeysPanel />);
    await waitFor(() => {
      const appRow = container.querySelector('[data-source="app"]');
      expect(appRow).not.toBeNull();
      expect(appRow.classList.contains('apikeys-row--active')).toBe(true);
      const badge = appRow.querySelector('.apikeys-badge--active');
      expect(badge?.textContent).toMatch(/active/i);
    });
  });

  it('moves the Active badge when the env source is active', async () => {
    global.fetch = mockFetchOnce(STATE_ENV_ACTIVE);
    const { container } = render(<ApiKeysPanel />);
    await waitFor(() => {
      const envRow = container.querySelector('[data-source="env"]');
      expect(envRow?.classList.contains('apikeys-row--active')).toBe(true);
      const appRow = container.querySelector('[data-source="app"]');
      expect(appRow?.classList.contains('apikeys-row--active')).toBe(false);
    });
  });

  it('Save button POSTs the entered token and refetches state', async () => {
    const fetchMock = mockFetchSequence(
      { status: 200, body: STATE_THREE_UNSET }, // initial GET
      { status: 200, body: STATE_APP_ACTIVE }, // POST returns updated state
      { status: 200, body: STATE_APP_ACTIVE }, // GET after save
    );
    global.fetch = fetchMock;

    render(<ApiKeysPanel />);
    await waitFor(() => screen.getByPlaceholderText(/hf_/));

    const input = screen.getByPlaceholderText(/hf_/);
    fireEvent.change(input, { target: { value: 'hf_newtoken123' } });
    const saveBtn = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      // Find the POST call
      const postCall = calls.find(([_url, opts]) => opts && opts.method === 'POST');
      expect(postCall).toBeTruthy();
      const [url, init] = postCall;
      expect(url).toMatch(/\/api\/settings\/hf-token$/);
      const body = JSON.parse(init.body);
      expect(body).toEqual({ token: 'hf_newtoken123' });
    });
  });

  it('Clear button shows confirmation dialog and DELETEs on confirm', async () => {
    const fetchMock = mockFetchSequence(
      { status: 200, body: STATE_APP_ACTIVE }, // initial GET
      { status: 200, body: STATE_THREE_UNSET }, // DELETE response
      { status: 200, body: STATE_THREE_UNSET }, // refetch GET
    );
    global.fetch = fetchMock;

    render(<ApiKeysPanel />);
    await waitFor(() => screen.getByPlaceholderText(/hf_/));

    const clearBtn = screen.getByRole('button', { name: /^clear$/i });
    fireEvent.click(clearBtn);

    // Dialog appears
    expect(screen.getByText(/Clear the App-source HuggingFace token/)).toBeInTheDocument();
    const confirmBtn = screen.getByRole('button', { name: /clear token/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const del = calls.find(([_u, opts]) => opts && opts.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(del[0]).toMatch(/\/api\/settings\/hf-token/);
      // also_clear_hf_cli default is false → no query string
      expect(del[0]).not.toMatch(/also_clear_hf_cli=true/);
    });
  });

  it('"Test now" button refetches state', async () => {
    const fetchMock = mockFetchSequence(
      { status: 200, body: STATE_THREE_UNSET },
      { status: 200, body: STATE_THREE_UNSET },
    );
    global.fetch = fetchMock;

    render(<ApiKeysPanel />);
    await waitFor(() => screen.getByPlaceholderText(/hf_/));
    const testBtn = screen.getByRole('button', { name: /test now/i });
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
