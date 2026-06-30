/**
 * DemoPresetGrid — the empty-state of the Voice Design tab.
 *
 * Renders the curated 7-card grid of demo voice designs (see
 * backend/core/personalities.py entries with `is_demo: true`). Each card:
 *   • Title + icon + 1-line description
 *   • ▶ Preview button (plays pre-rendered WAV from /demo_audio, no model
 *     load required — works offline before any engine is installed)
 *   • Use this design → calls `onUse(preset)` which pre-fills text + sliders
 *
 * Only one preview plays at a time. Mounting/unmounting the audio element
 * cancels any in-flight playback so navigating away mid-preview is silent.
 */
import { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DEMO_ICONS, FALLBACK_VOICE_ICON, stripVoiceEmoji } from '../utils/voiceIcons';
import { API } from '../api/client';
import { claimPlayback, stopActivePlayback } from '../utils/playback';
import './DemoPresetGrid.css';

export default function DemoPresetGrid({ presets, onUse }) {
  const { t } = useTranslation();
  const [playingId, setPlayingId] = useState(null);
  const audioRef = useRef(null);
  const releaseRef = useRef(null);

  // Stop playback on unmount so leaving the Design tab mid-preview goes
  // silent immediately.
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, []);

  const handlePreview = (preset) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === preset.id) {
      // Our claim's stop pauses the element and clears playingId.
      stopActivePlayback();
      return;
    }
    // Claim the global playback slot (#316): stops any other preview/output
    // that is currently playing before this one starts.
    releaseRef.current = claimPlayback(() => {
      audio.pause();
      setPlayingId(null);
    }, 'design-preview');
    audio.src = `${API}${preset.preview_url}`;
    audio.currentTime = 0;
    audio
      .play()
      .then(() => setPlayingId(preset.id))
      .catch((e) => {
        // Most common failure: WAV missing on disk (someone deleted it or
        // build_demos.sh hasn't been run). Fall back gracefully — the card
        // still works for "Use this design".
        console.warn('Preview playback failed:', e);
        releaseRef.current?.();
        releaseRef.current = null;
        setPlayingId(null);
      });
  };

  return (
    <div className="demo-preset-grid">
      {/* Single audio element shared across cards — keeps the "only one
          plays at a time" invariant without per-card state coordination. */}
      <audio
        ref={audioRef}
        onEnded={() => {
          setPlayingId(null);
          releaseRef.current?.();
          releaseRef.current = null;
        }}
        preload="none"
      />
      {presets.map((p) => {
        const isPlaying = playingId === p.id;
        const Icon = DEMO_ICONS[p.id] || FALLBACK_VOICE_ICON;
        return (
          <div key={p.id} className="demo-preset-card">
            <div className="demo-preset-card__head">
              <span className="demo-preset-card__icon" aria-hidden>
                <Icon size={18} />
              </span>
              <span className="demo-preset-card__name">{stripVoiceEmoji(p.name)}</span>
            </div>
            <p className="demo-preset-card__desc">{p.description}</p>
            <code className="demo-preset-card__instruct">{p.instruct}</code>
            <div className="demo-preset-card__actions">
              <button
                type="button"
                className="demo-preset-card__preview"
                onClick={() => handlePreview(p)}
                aria-label={isPlaying ? `Pause ${p.name}` : `Preview ${p.name}`}
                aria-pressed={isPlaying}
              >
                {isPlaying ? <Pause size={12} /> : <Play size={12} />}
                {isPlaying ? t('demo.preset_stop') : t('demo.preset_preview')}
              </button>
              <button
                type="button"
                className="demo-preset-card__use"
                onClick={() => onUse(p)}
                aria-label={`Use ${p.name} design`}
              >
                {t('demo.preset_use')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
