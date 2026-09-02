// Audiobook tab layout — the prod-polish compaction (#1214).
//
// The right-hand settings column is a compact property inspector: essentials
// stay visible and one optional production tool opens at a time.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../i18n';
import en from '../i18n/locales/en.json';

// listEngines runs once on mount to gate the emotion controls — stub it so the
// tab renders offline and reports "no emotion support".
vi.mock('../api/engines', () => ({
  listEngines: vi.fn().mockResolvedValue({ tts: { active: 'x', backends: [] } }),
}));
vi.mock('../api/generate', () => ({ audioUrl: (f) => `http://test.local/audio/${f}` }));
vi.mock('../api/audiobook', () => ({
  audiobookPlan: vi.fn(),
  audiobookGenerate: vi.fn(),
  audiobookUploadCover: vi.fn(),
  audiobookPreviewChapter: vi.fn(),
  audiobookImport: vi.fn(),
}));

import AudiobookTab from '../pages/AudiobookTab';
import { useAppStore } from '../store';

// AudiobookTab embeds VoiceSelector, which reads /archetypes via react-query
// (#1219) — so a QueryClient must be in context even though the fetch is gated
// on the dropdown being open.
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const withI18n = (node) => (
  <QueryClientProvider client={qc}>
    <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
  </QueryClientProvider>
);
describe('AudiobookTab — compact grouped layout (#1214)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().setLastOutput('');
    useAppStore.getState().setScript('');
  });

  it('keeps the primary inputs always visible', () => {
    const { container } = render(withI18n(<AudiobookTab profiles={[]} />));
    // Script editor, default voice, language — the three always-on controls.
    expect(screen.getByLabelText(en.audiobook.script)).toBeTruthy();
    expect(screen.getByText(en.audiobook.default_voice)).toBeTruthy();
    expect(screen.getByText(en.audiobook.language)).toBeTruthy();
    expect(screen.getByLabelText(en.audiobook.format)).toBeTruthy();
    // Secondary actions stay discoverable through accessible icon labels.
    expect(screen.getByLabelText(en.audiobook.load_sample)).toBeTruthy();
    expect(screen.getByLabelText(en.audiobook.import)).toBeTruthy();
    expect(screen.getByLabelText(en.audiobook.preview_plan)).toBeTruthy();
    expect(screen.getByText(en.audiobook.create)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: en.audiobook.title })).toBeTruthy();
    expect(container.querySelector('[class*="container-name:audiobook-inspector"]')).toBeTruthy();
    expect(
      container.querySelector('[class*="@min-[360px]/audiobook-inspector:grid-cols-2"]'),
    ).toBeTruthy();
  });

  it('groups optional controls into an icon-led tool strip', () => {
    render(withI18n(<AudiobookTab profiles={[]} />));
    for (const title of [
      en.audiobook.output,
      en.audiobook.details,
      en.audiobook.lexicon,
      en.audiobook.markup_help,
    ]) {
      expect(screen.getByRole('button', { name: title })).toBeTruthy();
    }
  });

  it('keeps optional panels closed by default', () => {
    render(withI18n(<AudiobookTab profiles={[]} />));
    expect(screen.queryByLabelText(en.audiobook.loudness)).toBeNull();
    expect(screen.queryByLabelText(en.audiobook.meta_title)).toBeNull();
  });

  it('opens Cast by default when the script contains cast tags', () => {
    useAppStore.getState().setScript('# Chapter\n[voice:Mara] Hello');
    render(withI18n(<AudiobookTab profiles={[]} />));
    expect(screen.getByRole('button', { name: en.audiobook.cast })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText(`${en.audiobook.cast}: Mara`)).toBeTruthy();
  });

  it('shows only the selected optional panel', () => {
    render(withI18n(<AudiobookTab profiles={[]} />));
    fireEvent.click(screen.getByRole('button', { name: en.audiobook.details }));
    expect(screen.getByLabelText(en.audiobook.meta_title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.audiobook.output }));
    expect(screen.queryByLabelText(en.audiobook.meta_title)).toBeNull();
    expect(screen.getByLabelText(en.audiobook.loudness)).toBeTruthy();
  });

  it('pairs a persisted output with its render-time script after later edits', () => {
    useAppStore
      .getState()
      .setLastOutputSnapshot('rendered.m4b', '# Rendered\nOld line', [
        { title: 'Rendered', status: 'done', duration_s: 2 },
      ]);
    useAppStore.getState().setScript('# Edited\nNew line');

    render(withI18n(<AudiobookTab profiles={[]} />));

    expect(screen.getByRole('button', { name: 'Old' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
  });
});
