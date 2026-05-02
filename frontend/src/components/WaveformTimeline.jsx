import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import MinimapPlugin from 'wavesurfer.js/dist/plugins/minimap.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { Play, Pause, ZoomIn, ZoomOut, SkipBack, Loader, Keyboard } from 'lucide-react';
import './WaveformErrorBoundary.css';

const REGION_COLORS = [
  'rgba(211,134,155,0.3)',
  'rgba(131,165,152,0.3)',
  'rgba(184,187,38,0.3)',
  'rgba(250,189,47,0.3)',
  'rgba(142,192,124,0.3)',
  'rgba(254,128,25,0.3)',
  'rgba(104,157,106,0.3)',
];

/**
 * WaveformTimeline
 *
 * Props:
 *   audioSrc       – URL / blob URL for audio (used as WaveSurfer media + waveform source)
 *   videoSrc       – URL / blob URL for the video preview (optional, shown above waveform)
 *   segments       – Array<{ id, start, end, text }>
 *   onSegmentsChange – (fn) => void  (receives a setter-style function)
 *   disabled       – locks drag/resize of regions
 *   overlayContent – React node rendered as a translucent overlay on the waveform
 */
export default function WaveformTimeline({
  audioSrc,
  videoSrc,
  segments = [],
  onSegmentsChange,
  disabled = false,
  overlayContent,
}) {
  const waveContainerRef = useRef(null);  // div WaveSurfer draws into
  const videoContainerRef = useRef(null); // div we imperatively append the <video> into
  const wsRef         = useRef(null);
  const mediaElRef    = useRef(null);  // fallback: direct media element if WaveSurfer unavailable
  const regionsRef    = useRef(null);
  const isDraggingRef = useRef(false);
  const lastFpRef     = useRef(null);

  const [ready,       setReady]       = useState(false);
  const [loadError,   setLoadError]   = useState(false);
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [zoom,        setZoom]        = useState(50);

  // ── Core init — only re-runs when src changes ───────────────────────────────
  useEffect(() => {
    if (!waveContainerRef.current || !audioSrc) return;

    setReady(false);
    setLoadError(false);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);

    // ── 1. Create the video element imperatively (stable, no React re-renders) ──
    let videoEl = null;
    if (videoSrc && videoContainerRef.current) {
      // Remove prior children + detach listeners explicitly to avoid leaks.
      const c = videoContainerRef.current;
      while (c.firstChild) {
        const child = c.firstChild;
        if (child.tagName === 'VIDEO' || child.tagName === 'AUDIO') {
          try { child.pause(); child.removeAttribute('src'); child.load?.(); } catch (_) {}
        }
        c.removeChild(child);
      }
      videoEl = document.createElement('video');
      videoEl.src = videoSrc;
      videoEl.muted = false;
      videoEl.playsInline = true;
      // Load enough data to paint first frame as thumbnail preview.
      videoEl.preload = 'auto';
      videoEl.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
      // Decode and show the first frame as a thumbnail.
      // WebKit won't paint a frame until currentTime is set past 0.
      const showFirstFrame = () => {
        try {
          if (videoEl.currentTime === 0 && isFinite(videoEl.duration) && videoEl.duration > 0) {
            // Seek to the earliest decodable frame.
            videoEl.currentTime = Math.min(0.1, videoEl.duration * 0.01);
          }
        } catch (_) { /* ignore */ }
      };
      videoEl.addEventListener('loadedmetadata', showFirstFrame, { once: true });
      // Fallback if loadedmetadata already fired before listener attached (cached).
      if (videoEl.readyState >= 1) showFirstFrame();
      videoContainerRef.current.appendChild(videoEl);
    }

    // ── 2. Create the media element WaveSurfer will control ──────────────────
    //    Use <video> if we have one (it has audio), otherwise <audio>.
    //    This avoids two media elements fighting each other.
    const mediaEl = videoEl ?? (() => {
      const a = document.createElement('audio');
      a.src = audioSrc;
      a.preload = 'auto';
      return a;
    })();
    // For the audio-only case (server WAV), also set src on the media element
    if (!videoEl) {
      mediaEl.src = audioSrc;
    }
    mediaEl.crossOrigin = 'anonymous'; // helps in sandboxed WebViews
    mediaElRef.current = mediaEl;       // keep ref for fallback play/pause

    // ── 3. Init WaveSurfer with that single media element ────────────────────
    const regions = RegionsPlugin.create();
    regionsRef.current = regions;
    lastFpRef.current  = null;

    let ws;
    try {
      // Start at the container's measured height; a ResizeObserver below
      // keeps WaveSurfer in sync when the column resizes. Fallback to 200
      // if layout hasn't settled yet so we never render a flat sliver.
      const initialHeight = Math.max(80, Math.min(waveContainerRef.current.clientHeight || 120, 160));
      const minimap = MinimapPlugin.create({
        height: 20,
        waveColor: 'rgba(168,153,132,0.25)',
        progressColor: 'rgba(211,134,155,0.4)',
        cursorColor: '#d3869b',
      });
      const timeline = TimelinePlugin.create({
        height: 14,
        timeInterval: 1,
        primaryLabelInterval: 5,
        style: {
          fontSize: '9px',
          color: 'rgba(168,153,132,0.5)',
        },
      });
      ws = WaveSurfer.create({
        container:     waveContainerRef.current,
        waveColor:     'rgba(168,153,132,0.45)',
        progressColor: 'rgba(211,134,155,0.75)',
        cursorColor:   '#d3869b',
        cursorWidth:   2,
        height:        initialHeight,
        barWidth:      2,
        barGap:        1,
        barRadius:     2,
        normalize:     true,
        media:         mediaEl,
        plugins:       [regions, minimap, timeline],
      });
    } catch (initErr) {
      console.warn('WaveSurfer init failed (WebKit restriction?):', initErr);
      // Still allow media element to function for video playback
      // Wire native events so play button and time display work
      const waitMeta = () => {
        setDuration(mediaEl.duration || 0);
        setReady(true);
      };
      if (mediaEl.readyState >= 1) waitMeta();
      else mediaEl.addEventListener('loadedmetadata', waitMeta, { once: true });
      mediaEl.addEventListener('timeupdate', () => setCurrentTime(mediaEl.currentTime));
      mediaEl.addEventListener('play',  () => setIsPlaying(true));
      mediaEl.addEventListener('pause', () => setIsPlaying(false));
      mediaEl.addEventListener('ended', () => setIsPlaying(false));
      wsRef.current = null;
      return;
    }

    ws.on('ready',      ()  => { setDuration(ws.getDuration()); setReady(true); });
    ws.on('timeupdate', (t) => setCurrentTime(t));
    ws.on('play',       ()  => setIsPlaying(true));
    ws.on('pause',      ()  => setIsPlaying(false));
    ws.on('finish',     ()  => setIsPlaying(false));

    // Handle errors (like Safari refusing to decode .mov in WebAudio)
    ws.on('error', (err) => {
      const errStr = typeof err === 'string' ? err.toLowerCase() : (err?.message || '').toLowerCase();
      const errName = err?.name || '';
      if (errName === 'AbortError' || errStr.includes('abort')) {
        return; // Ignore React cleanup aborts
      }
      // WebKit NotSupportedError — skip decode, load with empty peaks so media element still works
      if (errName === 'NotSupportedError' || errStr.includes('not supported')) {
        console.warn('WebKit audio decode not supported, using media element directly');
        try {
          const emptyPeaks = new Float32Array(1000).fill(0);
          ws.load(undefined, [emptyPeaks], mediaEl.duration || 60);
        } catch (_) {
          setReady(true);
        }
        return;
      }

      // If WaveSurfer failed to decode the media element stream (e.g. 404, .mov on MacOS, or pure .wav files failing to emit peaks),
      // we manually fetch the companion `audioSrc`, decode it, and supply raw peaks.
      if (audioSrc) {
        fetch(audioSrc)
          .then(res => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.arrayBuffer();
          })
          .then(buffer => {
            const actx = new (window.AudioContext || window.webkitAudioContext)();
            return actx.decodeAudioData(buffer);
          })
          .then(audioBuffer => {
             const channelData = audioBuffer.getChannelData(0);
             ws.load(undefined, [channelData], audioBuffer.duration);
          })
          .catch((decodeErr) => {
            console.warn('Audio decode fallback failed, loading with empty peaks:', decodeErr);
            // Last resort — show flat waveform but keep media element playback working
            try {
              const emptyPeaks = new Float32Array(1000).fill(0);
              ws.load(undefined, [emptyPeaks], mediaEl.duration || 60);
            } catch (_) {
              setLoadError(true);
            }
          });
      } else {
        setLoadError(true);
      }
    });

    regions.on('region-updated', (region) => {
      const segId = parseInt(region.id.replace('seg-', ''), 10);
      if (isNaN(segId) || !onSegmentsChange) return;
      isDraggingRef.current = true;
      onSegmentsChange(prev =>
        (Array.isArray(prev) ? prev : []).map(s => {
          if (s.id !== segId) return s;
          
          // Store the very first original duration so successive drags compound correctly
          const origDur = s.original_duration || (s.end - s.start);
          const newStart = +region.start.toFixed(2);
          const newEnd = +region.end.toFixed(2);
          const newDuration = newEnd - newStart;
          
          // Speed = (original spoken duration) / (new target duration defined by UI region width)
          const newSpeed = newDuration > 0 ? +(origDur / newDuration).toFixed(2) : 1.0;

          return { 
            ...s, 
            start: newStart, 
            end: newEnd, 
            speed: newSpeed, 
            original_duration: origDur 
          };
        })
      );
      requestAnimationFrame(() => { isDraggingRef.current = false; });
    });

    regions.on('region-clicked', (region, e) => {
      e.stopPropagation();
      try { region.play(); } catch (_) { /* WebKit may reject */ }
    });

    wsRef.current = ws;

    return () => {
      try { ws.destroy(); } catch (_) {}
      wsRef.current      = null;
      mediaElRef.current = null;
      regionsRef.current = null;
      // Clear the imperatively-created video element (release src so browser frees decoder)
      const c = videoContainerRef.current;
      if (c) {
        while (c.firstChild) {
          const child = c.firstChild;
          if (child.tagName === 'VIDEO' || child.tagName === 'AUDIO') {
            try { child.pause(); child.removeAttribute('src'); child.load?.(); } catch (_) {}
          }
          c.removeChild(child);
        }
      }
      setReady(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSrc, videoSrc]);

  // ── Zoom ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (wsRef.current && ready) {
      try {
        wsRef.current.zoom(zoom);
      } catch (err) {
        console.warn('WaveSurfer zoom failed:', err);
      }
    }
  }, [zoom, ready]);

  // ── Sync regions — skips when dragging or fingerprint unchanged ─────────────
  const fingerprint = useMemo(
    () => segments.map(s => `${s.id}:${s.start}:${s.end}`).join('|'),
    [segments]
  );

  useEffect(() => {
    if (!regionsRef.current || !ready || isDraggingRef.current) return;
    if (lastFpRef.current === fingerprint) return;
    lastFpRef.current = fingerprint;

    regionsRef.current.clearRegions();
    segments.forEach((seg, i) => {
      regionsRef.current.addRegion({
        id:      `seg-${seg.id}`,
        start:   seg.start,
        end:     seg.end,
        color:   REGION_COLORS[i % REGION_COLORS.length],
        drag:    !disabled,
        resize:  !disabled,
        content: seg.text?.length > 32 ? seg.text.slice(0, 30) + '…' : (seg.text || ''),
      });
    });
  }, [fingerprint, ready, disabled, segments]);

  const togglePlay = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.playPause();
    } else if (mediaElRef.current) {
      // Fallback: control the native media element directly
      const el = mediaElRef.current;
      if (el.paused) {
        el.play().catch(() => {});
      } else {
        el.pause();
      }
    }
  }, []);
  const seekTo = useCallback((t) => {
    if (wsRef.current) {
      wsRef.current.setTime(t);
    } else if (mediaElRef.current) {
      mediaElRef.current.currentTime = t;
    }
  }, []);

  const fmt = (t) => {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1);
    return `${m}:${s.padStart(4, '0')}`;
  };

  // ── Keyboard shortcuts (J/K/L video-editor style) ──────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === ' ' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        togglePlay();
      }
      if (e.key === 'j') seekTo(Math.max(0, currentTime - 5));
      if (e.key === 'l') seekTo(Math.min(duration, currentTime + 5));
      if (e.key === 'k') togglePlay();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentTime, duration, togglePlay, seekTo]);

  // ── Error fallback ──────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="waveform-timeline">
        <div className="wfm-error">
          ⚠ Could not load audio from this file
        </div>
      </div>
    );
  }

  return (
    <div className="waveform-timeline wfm-layout" role="region" aria-label="Audio waveform timeline">
      {/* Video + Waveform stacked vertically */}
      <div className="wfm-stack">
        {/* Video preview — pinned to its aspect ratio so we don't letterbox
            into huge black bars. Waveform gets the remaining height. */}
        {videoSrc && (
          <div
            ref={videoContainerRef}
            className="wfm-video-preview"
          />
        )}

        {/* Waveform — fills the rest. This is the actual editing surface. */}
        <div className="wfm-wave-wrap">
          <div
            ref={waveContainerRef}
            className="waveform-container wfm-wave-inner"
          />

          {/* Loading shimmer */}
          {!ready && !loadError && (
            <div className="wfm-loading">
              <Loader className="spinner" size={12} color="#d3869b"/>
              <span className="wfm-loading__text">Loading waveform…</span>
            </div>
          )}

          {/* Overlay slot — transcription / dubbing progress */}
          {overlayContent && (
            <div className="wfm-overlay">
              {overlayContent}
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="waveform-controls wfm-controls" role="toolbar" aria-label="Playback controls">
        <div className="waveform-controls-left">
          <button className="waveform-btn" onClick={() => seekTo(0)} title="Restart" aria-label="Restart playback"><SkipBack size={11}/></button>
          <button className="waveform-btn waveform-btn-play" onClick={togglePlay} disabled={!ready} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <Pause size={11}/> : <Play size={11}/>}
          </button>
          <span className="waveform-time" aria-live="off">{fmt(currentTime)} / {fmt(duration)}</span>
          <span className="wfm-kbd-hint" title="J/K/L: rewind, play/pause, forward"><Keyboard size={10}/></span>
        </div>
        <div className="waveform-controls-right">
          <button className="waveform-btn" onClick={() => setZoom(z => Math.max(10, z - 20))} aria-label="Zoom out"><ZoomOut size={11}/></button>
          <input type="range" min="10" max="300" value={zoom}
            onChange={e => setZoom(Number(e.target.value))} className="waveform-zoom-slider"
            aria-label="Zoom level" />
          <button className="waveform-btn" onClick={() => setZoom(z => Math.min(300, z + 20))} aria-label="Zoom in"><ZoomIn size={11}/></button>
        </div>
      </div>
    </div>
  );
}
