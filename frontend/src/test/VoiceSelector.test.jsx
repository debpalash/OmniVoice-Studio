import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import VoiceSelector from '../components/VoiceSelector';

const PROFILES = [
  { id: 'p_clone', name: 'Aria' },               // falsy instruct → clone
  { id: 'p_design', name: 'Narrator', instruct: 'warm, deep' }, // designed
];

function open() {
  // The trigger is the only button until the popup opens.
  fireEvent.click(screen.getAllByRole('button')[0]);
}

describe('VoiceSelector', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // jsdom doesn't implement scrollIntoView; SearchableSelect calls it on open.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('renders engine-default first, then grouped clone/designed options', () => {
    render(<VoiceSelector value="" onChange={vi.fn()} profiles={PROFILES} />);
    // trigger shows the engine-default label
    expect(screen.getByRole('button', { name: /Engine default/ })).toBeInTheDocument();
    open();
    expect(screen.getByText('Aria')).toBeInTheDocument();
    expect(screen.getByText('Narrator')).toBeInTheDocument();
    // group headers present (designed split from clone)
    expect(screen.getByText('Cloned voices')).toBeInTheDocument();
    expect(screen.getByText('Designed voices')).toBeInTheDocument();
  });

  it('commits the profile id (value contract) on click', () => {
    const onChange = vi.fn();
    render(<VoiceSelector value="" onChange={onChange} profiles={PROFILES} />);
    open();
    fireEvent.mouseDown(screen.getByText('Aria'));
    expect(onChange).toHaveBeenCalledWith('p_clone');
  });

  it('emits preset:<id> values when presets enabled', () => {
    const onChange = vi.fn();
    render(<VoiceSelector value="" onChange={onChange} profiles={[]} presets />);
    open();
    expect(screen.getByText('Presets')).toBeInTheDocument();
    // the first preset row commits a preset: value
    const presetRow = screen.getAllByRole('option').find(
      (el) => el.textContent && /Authoritative|Preset|🎙/.test(el.textContent),
    );
    // fall back to any non-default option if preset names change
    fireEvent.mouseDown(presetRow || screen.getAllByRole('option')[1]);
    expect(onChange.mock.calls[0][0]).toMatch(/^preset:/);
  });

  it('slugs from-video speakers to auto:<slug> (byte-identical to dub)', () => {
    const onChange = vi.fn();
    render(
      <VoiceSelector value="" onChange={onChange} profiles={[]}
        speakerClones={{ 'Speaker 1': {} }} />,
    );
    open();
    expect(screen.getByText('From video')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('🎤 Speaker 1'));
    expect(onChange).toHaveBeenCalledWith('auto:speaker_1');
  });

  it('renders a ghost row (does NOT auto-clear) for a deleted-but-referenced voice', () => {
    const onChange = vi.fn();
    render(<VoiceSelector value="p_gone" onChange={onChange} profiles={PROFILES} />);
    // trigger shows a human label, not the raw id
    expect(screen.getByRole('button', { name: /Voice not found/ })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();  // value preserved
  });

  it('does NOT record sentinel values (engine-default) as recents', () => {
    const onChange = vi.fn();
    render(<VoiceSelector value="p_clone" onChange={onChange} profiles={PROFILES} recentsKey="vs_test" />);
    open();
    // pick engine default ('')
    fireEvent.mouseDown(screen.getByText('Engine default'));
    expect(onChange).toHaveBeenCalledWith('');
    const recents = JSON.parse(window.localStorage.getItem('vs_test') || '[]');
    expect(recents).not.toContain('');
  });

  it('DOES record a real profile id as a recent', () => {
    render(<VoiceSelector value="" onChange={vi.fn()} profiles={PROFILES} recentsKey="vs_test2" />);
    open();
    fireEvent.mouseDown(screen.getByText('Aria'));
    const recents = JSON.parse(window.localStorage.getItem('vs_test2') || '[]');
    expect(recents).toContain('p_clone');
  });

  it('renders a preview button only when onPreview is provided, passing the current value', () => {
    const onPreview = vi.fn();
    const { rerender } = render(
      <VoiceSelector value="p_clone" onChange={vi.fn()} profiles={PROFILES} onPreview={onPreview} />,
    );
    const previewBtn = screen.getByRole('button', { name: /Preview voice/ });
    fireEvent.click(previewBtn);
    expect(onPreview).toHaveBeenCalledWith('p_clone');

    // absent without the prop
    rerender(<VoiceSelector value="p_clone" onChange={vi.fn()} profiles={PROFILES} />);
    expect(screen.queryByRole('button', { name: /Preview voice/ })).not.toBeInTheDocument();
  });

  it('disables the preview button while previewLoading', () => {
    render(
      <VoiceSelector value="p_clone" onChange={vi.fn()} profiles={PROFILES}
        onPreview={vi.fn()} previewLoading />,
    );
    expect(screen.getByRole('button', { name: /Preview voice/ })).toBeDisabled();
  });
});
