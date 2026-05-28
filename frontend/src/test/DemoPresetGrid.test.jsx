import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

import DemoPresetGrid from '../components/DemoPresetGrid';

const PRESETS = [
  {
    id: 'p1',
    name: 'The Librarian',
    icon: '📚',
    description: 'Warm UK narrator',
    instruct: 'female, middle-aged, low pitch, british accent',
    attrs: { Gender: 'female', Age: 'middle-aged' },
    script: 'Once upon a time…',
    preview_url: '/demo_audio/voice_design/p1.wav',
    language: 'English',
  },
  {
    id: 'p2',
    name: 'The Anchor',
    icon: '📺',
    description: 'US news broadcaster',
    instruct: 'male, middle-aged, moderate pitch, american accent',
    attrs: { Gender: 'male' },
    script: 'Good evening…',
    preview_url: '/demo_audio/voice_design/p2.wav',
    language: 'English',
  },
];

function withI18n(node) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}

describe('DemoPresetGrid', () => {
  it('renders one card per preset', () => {
    render(withI18n(<DemoPresetGrid presets={PRESETS} onUse={vi.fn()} />));
    expect(screen.getByText('The Librarian')).toBeInTheDocument();
    expect(screen.getByText('The Anchor')).toBeInTheDocument();
    expect(screen.getAllByText('Use this design →')).toHaveLength(2);
  });

  it('shows the instruct taxonomy string on each card', () => {
    render(withI18n(<DemoPresetGrid presets={PRESETS} onUse={vi.fn()} />));
    expect(screen.getByText(/british accent/)).toBeInTheDocument();
    expect(screen.getByText(/american accent/)).toBeInTheDocument();
  });

  it('calls onUse with the preset object when "Use this design" is clicked', () => {
    const onUse = vi.fn();
    render(withI18n(<DemoPresetGrid presets={PRESETS} onUse={onUse} />));
    const buttons = screen.getAllByText('Use this design →');
    fireEvent.click(buttons[0]);
    expect(onUse).toHaveBeenCalledWith(PRESETS[0]);
  });
});
