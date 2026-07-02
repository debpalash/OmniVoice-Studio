import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import LLMProvidersPanel from './LLMProvidersPanel';

const PROVIDERS = {
  active: 'groq',
  providers: [
    {
      id: 'groq',
      display_name: 'Groq',
      local: false,
      needs_account: false,
      signup_url: 'https://console.groq.com',
      notes: 'fast inference',
      base_url: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b',
      has_key: true,
      key_from_env: false,
      configured: true,
    },
    {
      id: 'ollama',
      display_name: 'Ollama',
      local: true,
      needs_account: false,
      signup_url: null,
      notes: null,
      base_url: 'http://localhost:11434/v1',
      model: 'llama3',
      has_key: false,
      key_from_env: false,
      configured: false,
    },
  ],
};

function mockFetchSequence(...responses) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    });
  }
  return fn;
}

describe('LLMProvidersPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads providers and preselects the active one', async () => {
    global.fetch = mockFetchSequence({ body: PROVIDERS });
    render(<LLMProvidersPanel />);
    const select = await screen.findByTestId('llm-provider-select');
    await waitFor(() => expect(select.value).toBe('groq'));
    expect(screen.getByTestId('llm-provider-base-url').value).toBe(
      'https://api.groq.com/openai/v1',
    );
  });

  it('successful test shows model + latency badge', async () => {
    global.fetch = mockFetchSequence(
      { body: PROVIDERS }, // mount GET
      { body: {} }, // save PUT
      { body: PROVIDERS }, // refresh GET
      { body: { ok: true, model: 'llama-3.3-70b', reply: 'ok', latency_ms: 412 } }, // test POST
    );
    render(<LLMProvidersPanel />);
    fireEvent.click(await screen.findByTestId('llm-provider-test'));
    await waitFor(() => expect(screen.getByText(/llama-3\.3-70b · 412 ms/)).toBeInTheDocument());
  });

  it('auth failure renders the actionable localized message, not the raw detail', async () => {
    global.fetch = mockFetchSequence(
      { body: PROVIDERS },
      { body: {} },
      { body: PROVIDERS },
      {
        body: {
          ok: false,
          kind: 'auth',
          detail: 'AuthenticationError: Incorrect API key',
          latency_ms: 130,
        },
      },
    );
    render(<LLMProvidersPanel />);
    fireEvent.click(await screen.findByTestId('llm-provider-test'));
    await waitFor(() => expect(screen.getByText(/Key rejected \(401\/403\)/)).toBeInTheDocument());
    expect(screen.queryByText(/AuthenticationError/)).toBeNull();
  });

  it('network failure explains reachability (local server hint)', async () => {
    global.fetch = mockFetchSequence(
      { body: PROVIDERS },
      { body: {} },
      { body: PROVIDERS },
      { body: { ok: false, kind: 'network', detail: 'APIConnectionError: refused' } },
    );
    render(<LLMProvidersPanel />);
    fireEvent.click(await screen.findByTestId('llm-provider-test'));
    await waitFor(() => expect(screen.getByText(/Can't reach the provider/)).toBeInTheDocument());
  });

  it('fetch models fills the datalist for the model input', async () => {
    global.fetch = mockFetchSequence(
      { body: PROVIDERS },
      { body: {} }, // save PUT (models saves non-key fields first)
      { body: PROVIDERS }, // refresh GET
      { body: { ok: true, models: ['llama-3.1-8b', 'llama-3.3-70b'] } }, // models GET
    );
    render(<LLMProvidersPanel />);
    fireEvent.click(await screen.findByTestId('llm-provider-models'));
    await waitFor(() => expect(screen.getByTestId('llm-provider-model')).toHaveAttribute('list'));
    expect(document.querySelectorAll('datalist option')).toHaveLength(2);
  });

  it('local provider hides the API key row', async () => {
    global.fetch = mockFetchSequence({ body: PROVIDERS });
    render(<LLMProvidersPanel />);
    const select = await screen.findByTestId('llm-provider-select');
    fireEvent.change(select, { target: { value: 'ollama' } });
    await waitFor(() => expect(screen.queryByTestId('llm-provider-key')).toBeNull());
  });
});
