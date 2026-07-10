/**
 * Settings → Models → OpenAI-compatible remote ASR panel.
 *
 * The single Save button persists base URL + model + API key. Regression
 * coverage for the dirty/saved lifecycle: Save is disabled while the fields
 * match the server (so "did I save that?" has an answer), enables on any edit
 * (including URL/model-only edits far above the button), and a successful save
 * shows an explicit "Saved" confirmation even when the key didn't change.
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

import AsrOpenAICompatPanel from '../components/settings/AsrOpenAICompatPanel';

const SERVER = { base_url: 'http://localhost:8000/v1', model: 'whisper-1', has_key: false };

function withI18n(node) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}

describe('AsrOpenAICompatPanel', () => {
  beforeEach(() => {
    apiJson.mockReset();
    apiFetch.mockReset();
    apiJson.mockResolvedValue(SERVER);
  });

  const waitForLoad = async () => {
    await waitFor(() =>
      expect(screen.getByTestId('asr-openai-compat-model')).toHaveValue(SERVER.model),
    );
  };

  it('disables Save until a field differs from the server values', async () => {
    render(withI18n(<AsrOpenAICompatPanel />));
    const saveBtn = await screen.findByTestId('asr-openai-compat-save');
    await waitForLoad();
    expect(saveBtn).toBeDisabled();

    // Editing the model (a field far above the button) makes it dirty…
    fireEvent.change(screen.getByTestId('asr-openai-compat-model'), {
      target: { value: 'qwen3-asr' },
    });
    expect(saveBtn).not.toBeDisabled();

    // …and reverting the edit makes it clean again.
    fireEvent.change(screen.getByTestId('asr-openai-compat-model'), {
      target: { value: SERVER.model },
    });
    expect(saveBtn).toBeDisabled();
  });

  it('typing an API key alone marks the form dirty', async () => {
    render(withI18n(<AsrOpenAICompatPanel />));
    const saveBtn = await screen.findByTestId('asr-openai-compat-save');
    await waitForLoad();
    expect(saveBtn).toBeDisabled();
    fireEvent.change(screen.getByTestId('asr-openai-compat-api-key'), {
      target: { value: 'k' },
    });
    expect(saveBtn).not.toBeDisabled();
  });

  it('shows a Saved confirmation after a URL/model-only save (no key change)', async () => {
    apiFetch.mockResolvedValue({
      json: async () => ({ base_url: SERVER.base_url, model: 'qwen3-asr', has_key: false }),
    });
    render(withI18n(<AsrOpenAICompatPanel />));
    await screen.findByTestId('asr-openai-compat-save');
    await waitForLoad();
    fireEvent.change(screen.getByTestId('asr-openai-compat-model'), {
      target: { value: 'qwen3-asr' },
    });
    fireEvent.click(screen.getByTestId('asr-openai-compat-save'));

    expect(await screen.findByTestId('asr-openai-compat-saved')).toHaveTextContent(
      i18n.t('models.asrOpenAICompatSaved'),
    );
    // The PUT carried the edited fields and omitted the untouched key.
    const [path, opts] = apiFetch.mock.calls[0];
    expect(path).toBe('/api/settings/asr-openai-compat');
    expect(JSON.parse(opts.body)).toEqual({ base_url: SERVER.base_url, model: 'qwen3-asr' });
    // Clean again after the save round-trip.
    expect(screen.getByTestId('asr-openai-compat-save')).toBeDisabled();

    // The confirmation clears as soon as the user edits again.
    fireEvent.change(screen.getByTestId('asr-openai-compat-model'), {
      target: { value: 'other' },
    });
    expect(screen.queryByTestId('asr-openai-compat-saved')).not.toBeInTheDocument();
  });
});
