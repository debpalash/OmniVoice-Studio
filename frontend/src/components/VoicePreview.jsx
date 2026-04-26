import React, { useState, useRef, useCallback } from 'react';
import { Volume2, Play, Square, Loader, X, Mic } from 'lucide-react';
import { generateSpeech } from '../api/generate';
import { PRESETS } from '../utils/constants';
import { Button } from '../ui';
import './VoicePreview.css';

/**
 * VoicePreview — floating "try a voice" card.
 *
 * Opens as a bottom-right popover. User picks a voice profile, types a
 * sentence, hits Play → hears TTS output instantly (8 inference steps for
 * speed). The result is disposable — it doesn't save to history.
 */
const DEFAULT_TEXT = 'Hello! This is a preview of how I sound in this voice.';

export default function VoicePreview({
  open,
  onClose,
  profiles = [],
  initialProfileId = '',
  fileToMediaUrl,
}) {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [voiceId, setVoiceId] = useState(initialProfileId);
  const [audioUrl, setAudioUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const abortRef = useRef(null);

  // Sync initialProfileId when it changes (e.g. clicking preview on a different profile)
  React.useEffect(() => {
    if (initialProfileId) setVoiceId(initialProfileId);
  }, [initialProfileId]);

  const handleGenerate = useCallback(async () => {
    if (!text.trim()) return;
    setLoading(true);
    setAudioUrl(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const fd = new FormData();
      fd.append('text', text);
      fd.append('num_step', '8');         // fast preview
      fd.append('guidance_scale', '2.0');
      fd.append('speed', '1.0');
      fd.append('denoise', 'true');
      fd.append('postprocess_output', 'true');

      let profileId = voiceId;
      let instruct = '';

      if (profileId.startsWith('preset:')) {
        const pr = PRESETS.find(p => p.id === profileId.replace('preset:', ''));
        if (pr) {
          instruct = Object.values(pr.attrs).filter(v => v !== 'Auto').join(', ');
        }
        profileId = '';
      } else {
        const match = profiles.find(p => p.id === profileId);
        if (match?.instruct) instruct = match.instruct;
      }

      if (profileId) fd.append('profile_id', profileId);
      if (instruct) fd.append('instruct', instruct);

      const res = await generateSpeech(fd, { signal: ac.signal });
      if (!res.ok) throw new Error(`TTS failed: ${res.status}`);

      const blob = await res.blob();
      const urls = await fileToMediaUrl(blob, null);
      setAudioUrl(urls.audioUrl);

      // Auto-play
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.play().catch(() => {});
        }
      }, 50);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Preview generation failed:', err);
      }
    } finally {
      setLoading(false);
    }
  }, [text, voiceId, profiles, fileToMediaUrl]);

  const handleStop = () => {
    abortRef.current?.abort();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlaying(false);
    setLoading(false);
  };

  if (!open) return null;

  return (
    <div className="voice-preview">
      <div className="voice-preview__head">
        <span className="voice-preview__title">
          <Volume2 size={13} /> Voice Preview
        </span>
        <button
          type="button"
          className="voice-preview__close"
          onClick={onClose}
          aria-label="Close preview"
        >
          <X size={12} />
        </button>
      </div>

      <div className="voice-preview__body">
        <select
          className="input-base voice-preview__select"
          value={voiceId}
          onChange={e => setVoiceId(e.target.value)}
        >
          <option value="">Default voice</option>
          {profiles.filter(p => !p.instruct).length > 0 && (
            <optgroup label="Clone Profiles">
              {profiles.filter(p => !p.instruct).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>
          )}
          {profiles.filter(p => !!p.instruct).length > 0 && (
            <optgroup label="Designed Voices">
              {profiles.filter(p => !!p.instruct).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>
          )}
          {PRESETS.length > 0 && (
            <optgroup label="Presets">
              {PRESETS.map(p => (
                <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>
              ))}
            </optgroup>
          )}
        </select>

        <textarea
          className="input-base voice-preview__text"
          value={text}
          onChange={e => setText(e.target.value)}
          rows={2}
          placeholder="Type something to hear…"
          spellCheck={false}
        />

        {audioUrl && (
          <audio
            ref={audioRef}
            src={audioUrl}
            className="voice-preview__audio"
            controls
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        )}
      </div>

      <div className="voice-preview__foot">
        {loading ? (
          <Button variant="ghost" size="sm" onClick={handleStop} leading={<Square size={10} />}>
            Stop
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            onClick={handleGenerate}
            disabled={!text.trim()}
            loading={loading}
            leading={!loading && <Play size={10} />}
          >
            {audioUrl ? 'Regenerate' : 'Preview'}
          </Button>
        )}
        <span className="voice-preview__hint">8 steps · fast preview</span>
      </div>
    </div>
  );
}
