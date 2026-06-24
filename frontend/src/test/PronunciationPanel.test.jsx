/**
 * Settings → General → Pronunciation dictionary panel.
 *
 * Verifies: entries render (term → replacement + scope/type badges), Add posts
 * the new entry, delete removes it, the enable toggle PUTs, and the test field
 * previews the substitution. All over mocked api/client.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

const apiJson = vi.fn();
const apiFetch = vi.fn();
vi.mock('../api/client', () => ({
  apiJson: (...a) => apiJson(...a),
  apiFetch: (...a) => apiFetch(...a),
}));

import PronunciationPanel from '../components/settings/PronunciationPanel';

const ENTRIES = [
  { id: 'e1', term: 'GIF', replacement: 'jiff', type: 'respelling', language: '*', scope: '*', enabled: true },
  { id: 'e2', term: 'Nevada', replacement: 'Nuh-VAD-uh', type: 'respelling', language: 'en', scope: 'en', enabled: false },
];

function withI18n(node) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}

describe('PronunciationPanel', () => {
  beforeEach(() => {
    apiJson.mockReset();
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true });
  });

  it('lists entries with term, replacement and scope badge', async () => {
    apiJson.mockResolvedValueOnce(ENTRIES);
    render(withI18n(<PronunciationPanel />));
    expect(await screen.findByText('GIF')).toBeInTheDocument();
    expect(screen.getByText('Nevada')).toBeInTheDocument();
    expect(screen.getByText('en')).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
  });

  it('shows the empty hint when there are no entries', async () => {
    apiJson.mockResolvedValueOnce([]);
    render(withI18n(<PronunciationPanel />));
    expect(await screen.findByTestId('pron-empty')).toBeInTheDocument();
  });

  it('POSTs a new entry on Add', async () => {
    apiJson.mockResolvedValue([]);
    render(withI18n(<PronunciationPanel />));
    await screen.findByTestId('pron-add');
    fireEvent.change(screen.getByTestId('pron-term'), { target: { value: 'SQL' } });
    fireEvent.change(screen.getByTestId('pron-replacement'), { target: { value: 'sequel' } });
    fireEvent.click(screen.getByTestId('pron-add'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [path, opts] = apiFetch.mock.calls[0];
    expect(path).toBe('/pronunciation');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ term: 'SQL', replacement: 'sequel', type: 'respelling', language: '*', enabled: true });
  });

  it('does not POST when the term is blank', async () => {
    apiJson.mockResolvedValue([]);
    render(withI18n(<PronunciationPanel />));
    await screen.findByTestId('pron-add');
    fireEvent.click(screen.getByTestId('pron-add'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('DELETEs an entry', async () => {
    apiJson.mockResolvedValue(ENTRIES);
    render(withI18n(<PronunciationPanel />));
    await screen.findByText('GIF');
    fireEvent.click(screen.getByTestId('pron-del-e1'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/pronunciation/e1', { method: 'DELETE' }));
  });

  it('PUTs the enabled toggle', async () => {
    apiJson.mockResolvedValue(ENTRIES);
    render(withI18n(<PronunciationPanel />));
    await screen.findByText('Nevada');
    fireEvent.click(screen.getByTestId('pron-toggle-e2'));
    await waitFor(() => {
      const call = apiFetch.mock.calls.find(([p]) => p === '/pronunciation/e2');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ enabled: true });
    });
  });

  it('previews the substitution via /pronunciation/test', async () => {
    apiJson.mockImplementation((path) => {
      if (path === '/pronunciation/test') {
        return Promise.resolve({ substituted: 'a jiff', changed: true });
      }
      return Promise.resolve(ENTRIES);
    });
    render(withI18n(<PronunciationPanel />));
    await screen.findByTestId('pron-test-input');
    fireEvent.change(screen.getByTestId('pron-test-input'), { target: { value: 'a GIF' } });
    expect(await screen.findByTestId('pron-test-out')).toHaveTextContent('a jiff');
  });
});
