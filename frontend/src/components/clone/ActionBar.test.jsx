import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../SearchableSelect', () => ({
  default: () => <button type="button">Language</button>,
}));

import ActionBar from './ActionBar';

const setter = vi.fn();
const baseProps = {
  t: (key) => key,
  cfg: 2,
  setCfg: setter,
  speed: 1,
  setSpeed: setter,
  tShift: 0.5,
  setTShift: setter,
  posTemp: 1,
  setPosTemp: setter,
  classTemp: 1,
  setClassTemp: setter,
  layerPenalty: 1,
  setLayerPenalty: setter,
  duration: '',
  setDuration: setter,
  denoise: false,
  setDenoise: setter,
  postprocess: false,
  setPostprocess: setter,
  language: 'Auto',
  setLanguage: setter,
  steps: 16,
  setSteps: setter,
  showHearDemo: false,
  outputPlaying: false,
  isGenerating: false,
  handleGenerate: setter,
  generationTime: 0,
  wasGeneratingRef: { current: false },
};

function Harness() {
  const [showOverrides, setShowOverrides] = useState(false);
  return (
    <ActionBar {...baseProps} showOverrides={showOverrides} setShowOverrides={setShowOverrides} />
  );
}

describe('ActionBar', () => {
  it('keeps sampling steps inside Production Overrides', () => {
    render(<Harness />);

    expect(screen.queryByRole('slider', { name: 'clone.steps' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clone.production_overrides/ }));
    expect(screen.getByRole('slider', { name: 'clone.steps' })).toBeInTheDocument();
  });
});
