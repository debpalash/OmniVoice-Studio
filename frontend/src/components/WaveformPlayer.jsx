/**
 * WaveformPlayer — the single, shared audio player used for every playback
 * surface in the app (generated TTS output, voice-design output, history items,
 * voice-profile reference + test audio, voice-preview popover, A/B compare).
 *
 * One component so every "play some audio" spot looks and behaves identically:
 * a play/pause button, a click-to-seek wavesurfer waveform, and a time readout.
 * It cooperates with the global single-playback manager (utils/playback.js), so
 * starting one player stops whatever else was playing across the app.
 *
 * `src` may be a URL string or a Blob/File (we object-URL it and clean up).
 *
 * WebKit (Tauri on macOS) can refuse to decode some media in WebAudio; if
 * WaveSurfer fails to init or load we transparently fall back to a native
 * <audio controls> element so playback still works — mirrors WaveformTimeline.
 */
import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, Loader } from 'lucide-react';
import { claimPlayback } from '../utils/playback';
import { isTauri, fileToMediaUrl } from '../utils/media';
import './WaveformPlayer.css';

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export default function WaveformPlayer({
  src,
  source = 'output',   // global-playback-manager label
  autoPlay = false,
  height = 44,
  compact = false,
  onEnded,
  className = '',
}) {
  const containerRef = useRef(null);
  const nativeRef = useRef(null);
  const mediaRef = useRef(null);   // in-DOM <audio> driven by WaveSurfer
  const wsRef = useRef(null);
  const releaseRef = useRef(null);
  const autoPlayRef = useRef(autoPlay);
  useEffect(() => { autoPlayRef.current = autoPlay; }, [autoPlay]);

  const [resolvedUrl, setResolvedUrl] = useState(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);   // WaveSurfer unavailable → native fallback
  const [missing, setMissing] = useState(false); // source 404s (stale history) → inert notice
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  // Resolve Blob/File → playable URL. Strings pass through. In Tauri, blob:
  // URLs don't play in WebKit media elements, so blobs are routed through the
  // backend preview endpoint (same path the rest of the app uses).
  useEffect(() => {
    if (!src) { setResolvedUrl(null); return; }
    if (typeof src === 'string') { setResolvedUrl(src); return; }
    if (isTauri) {
      let cancelled = false;
      fileToMediaUrl(src, null)
        .then(urls => { if (!cancelled) setResolvedUrl(urls.audioUrl); })
        .catch(() => { if (!cancelled) setResolvedUrl(URL.createObjectURL(src)); });
      return () => { cancelled = true; };
    }
    const u = URL.createObjectURL(src);
    setResolvedUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [src]);

  // Build / tear down the WaveSurfer instance for the current url.
  useEffect(() => {
    setMissing(false); // a new url gets a fresh chance
    if (!resolvedUrl || failed || !containerRef.current || !mediaRef.current) return;
    setReady(false); setIsPlaying(false); setDuration(0); setCurrentTime(0);

    let ws;
    try {
      ws = WaveSurfer.create({
        container:     containerRef.current,
        waveColor:     'rgba(168,153,132,0.45)',
        progressColor: 'rgba(211,134,155,0.75)',
        cursorColor:   '#d3869b',
        cursorWidth:   2,
        height,
        barWidth:      2,
        barGap:        1,
        barRadius:     2,
        normalize:     true,
        // Drive a REAL in-DOM <audio> element instead of letting WaveSurfer
        // create a detached one: Tauri's WebKit decodes (peaks render) but
        // won't actually output sound for detached/blob-backed media — the
        // same reason WaveformTimeline passes its <video> element.
        media:         mediaRef.current,
        url:           resolvedUrl,
      });
    } catch (initErr) {
      console.warn('WaveformPlayer: WaveSurfer init failed, native fallback:', initErr);
      setFailed(true);
      return;
    }
    wsRef.current = ws;

    ws.on('ready', () => {
      setDuration(ws.getDuration());
      setReady(true);
      if (autoPlayRef.current) ws.play().catch(() => {});
    });
    ws.on('timeupdate', (t) => setCurrentTime(t));
    ws.on('play', () => {
      setIsPlaying(true);
      releaseRef.current = claimPlayback(() => { try { ws.pause(); } catch { /* noop */ } }, source);
    });
    ws.on('pause', () => {
      setIsPlaying(false);
      if (releaseRef.current) { releaseRef.current(); releaseRef.current = null; }
    });
    ws.on('finish', () => {
      setIsPlaying(false);
      if (releaseRef.current) { releaseRef.current(); releaseRef.current = null; }
      if (onEnded) onEnded();
    });
    ws.on('error', (err) => {
      const msg = (typeof err === 'string' ? err : err?.message || '').toLowerCase();
      if (err?.name === 'AbortError' || msg.includes('abort')) return; // React cleanup aborts
      if (/\b40[34]\b|not found/.test(msg)) {
        // The audio file is gone (stale history row, cleared outputs dir).
        // A native fallback would just re-request and 404 again — render an
        // inert "missing" notice instead and stop retrying.
        setMissing(true);
        return;
      }
      console.warn('WaveformPlayer: WaveSurfer error, native fallback:', err);
      setFailed(true);
    });

    // (No explicit ws.load — `url` in the create options loads via the media el.)

    return () => {
      if (releaseRef.current) { releaseRef.current(); releaseRef.current = null; }
      try { ws.destroy(); } catch { /* already gone */ }
      wsRef.current = null;
    };
  }, [resolvedUrl, failed, height, source, onEnded]);

  const togglePlay = () => { try { wsRef.current?.playPause(); } catch { /* noop */ } };

  if (!resolvedUrl) return null;

  // Source file no longer exists (stale history row) — inert notice, no retries.
  if (missing) {
    return (
      <div className={`wf-player wf-player--missing ${compact ? 'wf-player--compact' : ''} ${className}`}>
        <span className="wf-player__missing-msg">audio file missing</span>
      </div>
    );
  }

  // Native fallback — still wires the global playback manager so cross-app
  // "only one thing plays at once" holds even on the degraded path.
  if (failed) {
    return (
      <audio
        ref={nativeRef}
        className={`wf-player__native ${className}`}
        controls
        src={resolvedUrl}
        autoPlay={autoPlay}
        onPlay={() => { releaseRef.current = claimPlayback(() => { try { nativeRef.current?.pause(); } catch { /* noop */ } }, source); }}
        onPause={() => { if (releaseRef.current) { releaseRef.current(); releaseRef.current = null; } }}
        onEnded={() => { if (releaseRef.current) { releaseRef.current(); releaseRef.current = null; } if (onEnded) onEnded(); }}
        onError={() => setMissing(true)}
      />
    );
  }

  return (
    <div className={`wf-player ${compact ? 'wf-player--compact' : ''} ${className}`}>
      {/* Hidden but DOM-attached playback element (see WaveSurfer `media`). */}
      <audio ref={mediaRef} preload="metadata" style={{ display: 'none' }} />
      <button
        type="button"
        className="wf-player__btn"
        onClick={togglePlay}
        disabled={!ready}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {!ready
          ? <Loader size={compact ? 13 : 15} className="wf-player__spin" />
          : isPlaying ? <Pause size={compact ? 13 : 15} /> : <Play size={compact ? 13 : 15} />}
      </button>
      <div className="wf-player__wave" ref={containerRef} style={{ height }} />
      <span className="wf-player__time">{fmt(currentTime)} / {fmt(duration)}</span>
    </div>
  );
}
