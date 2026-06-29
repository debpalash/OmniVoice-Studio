/**
 * DubbingDemo — side-by-side player for the synthetic dubbing demo.
 *
 * Reads /demo_audio/demo/dubbing/manifest.json (mounted via FastAPI's
 * /demo_audio static route), shows the English source video on the left,
 * a language-pickable dubbed variant on the right, and a "Try it with
 * your own video" CTA below.
 *
 * Renders on the DubTab idle state when no project / file is loaded.
 * Dismissable via `onDismiss` — the parent passes a setter that hides
 * the demo and falls back to the existing drop-zone UI.
 */
import { useEffect, useRef, useState } from 'react';
import { Play, Film, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { API, apiFetch } from '../api/client';
import './DubbingDemo.css';

export default function DubbingDemo({ onDismiss }) {
  const { t } = useTranslation();
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);
  const [pickedCode, setPickedCode] = useState('es');
  const [syncPlay, setSyncPlay] = useState(true);
  const sourceRef = useRef(null);
  const dubbedRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`${API}/demo_audio/demo/dubbing/manifest.json`)
      .then(r => r.json())
      .then(j => { if (!cancelled) setManifest(j); })
      .catch(e => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  // Sync the two players when syncPlay is on — play/pause/seek the
  // English source drives the dubbed clone (and vice versa).
  useEffect(() => {
    if (!syncPlay) return;
    const a = sourceRef.current;
    const b = dubbedRef.current;
    if (!a || !b) return;

    const onPlay = (src, dst) => () => {
      // Avoid feedback loop — only play target if it's currently paused.
      if (dst.paused) {
        dst.currentTime = src.currentTime;
        dst.play().catch(() => {});
      }
    };
    const onPause = (dst) => () => { if (!dst.paused) dst.pause(); };
    const onSeek = (src, dst) => () => { dst.currentTime = src.currentTime; };

    const aPlay = onPlay(a, b);
    const bPlay = onPlay(b, a);
    const aPause = onPause(b);
    const bPause = onPause(a);
    const aSeek = onSeek(a, b);
    const bSeek = onSeek(b, a);

    a.addEventListener('play', aPlay);
    b.addEventListener('play', bPlay);
    a.addEventListener('pause', aPause);
    b.addEventListener('pause', bPause);
    a.addEventListener('seeked', aSeek);
    b.addEventListener('seeked', bSeek);
    return () => {
      a.removeEventListener('play', aPlay);
      b.removeEventListener('play', bPlay);
      a.removeEventListener('pause', aPause);
      b.removeEventListener('pause', bPause);
      a.removeEventListener('seeked', aSeek);
      b.removeEventListener('seeked', bSeek);
    };
  }, [syncPlay, pickedCode]);

  if (error) {
    return null; // No demo manifest yet — silently fall through to drop zone.
  }
  if (!manifest) {
    return (
      <div className="dubbing-demo dubbing-demo--loading">
        {t('demo.dubbing_loading')}
      </div>
    );
  }

  const source = manifest.source;
  const dubbed = manifest.dubbed?.find(d => d.code === pickedCode) || manifest.dubbed?.[0];
  if (!dubbed) return null;

  const base = `${API}/demo_audio/demo/dubbing`;

  return (
    <div className="dubbing-demo">
      <header className="dubbing-demo__head">
        <div className="dubbing-demo__title">
          <Film size={13} /> {t('demo.dubbing_title')}
        </div>
        <div className="dubbing-demo__head-actions">
          <label className="dubbing-demo__sync">
            <input
              type="checkbox"
              checked={syncPlay}
              onChange={e => setSyncPlay(e.target.checked)}
            />
            {t('demo.dubbing_sync')}
          </label>
          {onDismiss && (
            <button
              type="button"
              className="dubbing-demo__dismiss"
              onClick={onDismiss}
              aria-label={t('demo.dubbing_dismiss')}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </header>

      <div className="dubbing-demo__players">
        <div className="dubbing-demo__pane">
          <div className="dubbing-demo__pane-label">{source.label} <span>· {t('demo.original_tag')}</span></div>
          <video
            ref={sourceRef}
            src={`${base}/${source.video}`}
            controls
            playsInline
            preload="metadata"
          />
          <p className="dubbing-demo__caption">{source.script}</p>
        </div>
        <div className="dubbing-demo__pane">
          <div className="dubbing-demo__pane-label">
            {dubbed.label} <span>· {t('demo.dubbed_tag')}</span>
          </div>
          <video
            ref={dubbedRef}
            src={`${base}/${dubbed.video}`}
            controls
            playsInline
            preload="metadata"
            dir={dubbed.dir}
          />
          <p className="dubbing-demo__caption" dir={dubbed.dir}>{dubbed.script}</p>
        </div>
      </div>

      <div className="dubbing-demo__picker">
        <span className="dubbing-demo__picker-label">{t('demo.dubbing_picker')}</span>
        {manifest.dubbed.map(d => (
          <button
            key={d.code}
            type="button"
            className={`dubbing-demo__chip ${pickedCode === d.code ? 'is-active' : ''}`}
            onClick={() => setPickedCode(d.code)}
          >
            {d.label}
          </button>
        ))}
      </div>

      {onDismiss && (
        <button
          type="button"
          className="dubbing-demo__cta"
          onClick={onDismiss}
        >
          <Play size={12} /> {t('demo.dubbing_cta')}
        </button>
      )}
    </div>
  );
}
