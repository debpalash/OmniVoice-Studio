import { Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { stopActivePlayback, usePlaybackSource } from '../utils/playback';

/**
 * PlaybackStopPill — global stop affordance for "invisible" audio playback
 * (#1032).
 *
 * `playBlobAudio` plays through a bare Audio()/AudioContext with no on-screen
 * player — the generate auto-play, profile previews, and dub segment previews
 * all use it (playback source 'output'). The only visible stop control was the
 * Voice workspace ActionBar's CTA morph (#316), so the same audio started from
 * the Dub workspace, a profile page, or right after navigating away could not
 * be stopped at all. This pill renders whenever an 'output' playback is
 * active, on every page, and stops it via the global single-playback manager.
 *
 * Sources with their own visible player UI (WaveformPlayer instances,
 * 'design-preview', 'demo-output', gallery previews) are deliberately NOT
 * covered — they already have in-place pause/stop controls.
 */
export default function PlaybackStopPill() {
  const { t } = useTranslation();
  const source = usePlaybackSource();
  if (source !== 'output') return null;

  return (
    <button
      type="button"
      onClick={stopActivePlayback}
      aria-label={t('clone.stop_playback')}
      className="fixed left-1/2 -translate-x-1/2 bottom-[calc(var(--logs-footer-height,28px)+64px)] z-[var(--z-toast)] inline-flex items-center gap-[6px] py-[6px] px-[14px] rounded-[var(--radius-pill)] border border-[color:var(--color-border-strong)] bg-[var(--color-bg-elev-1)] text-[color:var(--color-fg)] [font-size:var(--text-sm)] shadow-[var(--shadow-lg)] cursor-pointer [backdrop-filter:var(--glass-blur-md)] hover:bg-[var(--color-bg-elev-2)] focus-visible:[outline:2px_solid_var(--chrome-accent)] focus-visible:[outline-offset:1px]"
    >
      <Square size={12} /> {t('clone.stop_playback')}
    </button>
  );
}
