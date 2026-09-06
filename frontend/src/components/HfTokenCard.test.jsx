import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import HfTokenCard from './HfTokenCard';

const STATE_NONE_ACTIVE = {
  active: null,
  sources: [
    { source: 'app', set: false, masked: null, whoami_user: null, whoami_ok: false },
    { source: 'env', set: false, masked: null, whoami_user: null, whoami_ok: false },
    { source: 'hf-cli', set: false, masked: null, whoami_user: null, whoami_ok: false },
  ],
};

// Mirrors the live report (#FR-006): `hf-cli` already resolved and validated.
const STATE_HF_CLI_ACTIVE = {
  active: 'hf-cli',
  sources: [
    { source: 'app', set: false, masked: null, whoami_user: null, whoami_ok: false },
    { source: 'env', set: false, masked: null, whoami_user: null, whoami_ok: false },
    {
      source: 'hf-cli',
      set: true,
      masked: 'hf_…Sfb',
      whoami_user: 'alice',
      whoami_ok: true,
    },
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

describe('HfTokenCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the add-token pitch when no token is active anywhere', async () => {
    global.fetch = mockFetchOnce(STATE_NONE_ACTIVE);
    render(<HfTokenCard />);
    await waitFor(() => expect(screen.getByPlaceholderText(/hf_/)).toBeInTheDocument());
    expect(screen.getByText(/Speed up downloads with a free Hugging Face token/)).toBeInTheDocument();
  });

  it('does NOT pitch a new token once one is already active and validated (#FR-006)', async () => {
    global.fetch = mockFetchOnce(STATE_HF_CLI_ACTIVE);
    render(<HfTokenCard />);

    // The satisfied state names the masked value; the blind "paste a token"
    // input must never appear alongside it.
    await waitFor(() => expect(screen.getByText(/hf_…Sfb/)).toBeInTheDocument());
    expect(screen.queryByPlaceholderText(/hf_/)).toBeNull();
    expect(screen.queryByText(/Speed up downloads with a free Hugging Face token/)).toBeNull();
  });

  it('replacing an active token requires an explicit "Replace…" click, not a blind paste-and-Save', async () => {
    global.fetch = mockFetchOnce(STATE_HF_CLI_ACTIVE);
    render(<HfTokenCard />);
    await waitFor(() => expect(screen.getByText(/hf_…Sfb/)).toBeInTheDocument());

    // Still no paste field until the user opts in.
    expect(screen.queryByPlaceholderText(/hf_/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /replace/i }));

    // Now the field appears, alongside a warning that this overwrites the
    // token above — the deliberate-action gate the fix adds.
    await waitFor(() => expect(screen.getByPlaceholderText(/hf_/)).toBeInTheDocument());
    expect(
      screen.getByText(/replaces the token above.*old one stops working/i),
    ).toBeInTheDocument();
  });

  it('shows a neutral checking placeholder while state is loading, never the pitch', async () => {
    let resolveFetch;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    render(<HfTokenCard />);

    expect(screen.queryByPlaceholderText(/hf_/)).toBeNull();
    expect(screen.queryByText(/Speed up downloads with a free Hugging Face token/)).toBeNull();
    expect(screen.getByText(/checking/i)).toBeInTheDocument();

    await waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => STATE_NONE_ACTIVE,
      text: async () => JSON.stringify(STATE_NONE_ACTIVE),
    });
    await waitFor(() => expect(screen.getByPlaceholderText(/hf_/)).toBeInTheDocument());
  });

  it('falls back to the pitch (pre-fix behavior) when the state check fails, rather than hiding the card', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('network error'));
    render(<HfTokenCard />);
    await waitFor(() => expect(screen.getByPlaceholderText(/hf_/)).toBeInTheDocument());
  });

  it('Save still POSTs HF_TOKEN via /system/set-env when no token was active', async () => {
    const fetchMock = mockFetchSequence(
      { status: 200, body: STATE_NONE_ACTIVE }, // GET state
      { status: 200, body: { key: 'HF_TOKEN', set: true, shadowed: false } }, // POST set-env
    );
    global.fetch = fetchMock;

    render(<HfTokenCard />);
    const input = await screen.findByPlaceholderText(/hf_/);
    fireEvent.change(input, { target: { value: 'hf_newtoken123' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST');
      expect(postCall).toBeTruthy();
      expect(postCall[0]).toMatch(/\/system\/set-env$/);
      expect(JSON.parse(postCall[1].body)).toEqual({ key: 'HF_TOKEN', value: 'hf_newtoken123' });
    });
    await waitFor(() =>
      expect(screen.getByText(/Hugging Face token saved/)).toBeInTheDocument(),
    );
  });
});
