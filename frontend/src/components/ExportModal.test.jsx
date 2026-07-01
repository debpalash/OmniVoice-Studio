// Regression for #183: a dub job's Export modal crashed DubTab's ErrorBoundary
// with "TypeError: e is not a function" — the i18n sweep added t('…') calls
// inside `.map(t => …)` callbacks where `t` was the loop variable, shadowing the
// useTranslation `t`. Rendering with a dub track that equals the primary
// dubLangCode exercises the exact crashing branch.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import '../i18n';
import ExportModal from './ExportModal';

const noop = () => {};

function renderModal(extra = {}) {
  return render(
    <ExportModal
      open
      onClose={noop}
      jobId="job1"
      filename="video.mp4"
      dubTracks={['es', 'fr']}
      dubLangCode="es"
      preserveBg={false}
      setPreserveBg={noop}
      defaultTrack="original"
      setDefaultTrack={noop}
      exportTracks={{}}
      setExportTracks={noop}
      dualSubs={false}
      setDualSubs={noop}
      burnSubs={false}
      setBurnSubs={noop}
      API=""
      triggerDownload={noop}
      handleDubDownload={noop}
      handleDubAudioDownload={noop}
      handleAudioExport={noop}
      segmentCount={3}
      {...extra}
    />,
  );
}

describe('ExportModal (regression #183)', () => {
  it('renders with dub tracks incl. the primary dub without throwing', () => {
    expect(() => renderModal()).not.toThrow();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <ExportModal open={false} onClose={noop} dubTracks={[]} exportTracks={{}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
