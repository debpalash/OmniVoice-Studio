import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import WaveSurfer from 'wavesurfer.js';
import MinimapPlugin from 'wavesurfer.js/dist/plugins/minimap.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { Play, Pause, ZoomIn, ZoomOut, SkipBack, Loader, Keyboard } from 'lucide-react';
import { useAppStore } from '../store';
import SegmentTrack from './SegmentTrack';
import './WaveformErrorBoundary.css';

/**
 * WaveformTimeline
 *
 * Hosts WaveSurfer (waveform / playhead / zoom / scroll) plus the custom
 * SegmentTrack editing lane (#280, item 3 — replaces the Regions plugin).
 * All segment-box positions derive from a single {pxPerSec, scrollLeft}
 * source read off WaveSurfer's wrapper, so the lane stays pixel-aligned
 * with the waveform across zoom/scroll/resize.
 *
 * Props:
 *   audioSrc        – URL / blob URL for audio (WaveSurfer media + waveform source)
 *   videoSrc        – URL / blob URL for the video preview (optional, shown above waveform)
 *   segments        – Array<{ id, start, end, text }>
 *   disabled        – locks drag/resize of segment boxes
 *   overlayContent  – React node rendered as a translucent overlay on the waveform
 *   onsets          – speech-onset times (s) for the snap ticks
 *   selectedSegId   – selected segment id (timeline ↔ table sync)
 *   onSelectSeg     – (id) => void
 *   incrementalPlan – { stale, fresh } cache plan for box tinting
 *   onSegmentCommit – (id, {start,end}, {undo}) => void — one commit per gesture
 *   onSegmentDelete – (id) => void
 *   onPreviewSegment– (seg) => void — synthesize-and-play this segment's dub
 */
function WaveformTimeline({
  audioSrc,
  videoSrc,
  segments = [],
  disabled = false,
  overlayContent,
  onsets = [],
  selectedSegId = null,
  onSelectSeg,
  incrementalPlan = null,
  onSegmentCommit,
  onSegmentDelete,
  onPreviewSegment,
}, ref) {
  const waveContainerRef = useRef(null);  // div WaveSurfer draws into
  const videoContainerRef = useRef(null); // div we imperatively append the <video> into
  const wsRef         = useRef(null);
  const mediaElRef    = useRef(null);  // fallback: direct media element if WaveSurfer unavailable
  const playRangeEndRef = useRef(null); // playRange() watcher pauses at this time

  const [ready,       setReady]       = useState(false);
  // WaveSurfer init threw (WebKit restriction) — media element still works;
  // the SegmentTrack then self-scrolls with a locally fixed pxPerSec.
  const [fallbackMode, setFallbackMode] = useState(false);
  // Single alignment source for the SegmentTrack, read off ws.getWrapper().
  const [metrics, setMetrics] = useState({ pxPerSec: 0, scrollLeft: 0 });
  const [loadError,   setLoadError]   = useState(false);
  // Specifically: the source returned a non-media response (typically 404
  // HTML). Differentiates from a generic decode failure so the error UI
  // can tell the user the file has moved/been deleted, not just "broken".
  const [sourceMissing, setSourceMissing] = useState(false);
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [zoom,        setZoom]        = useState(50);

  // ── Live "current segment" signal ──────────────────────────────────────────
  // Derive which segment contains the playhead and write the id to the store
  // *only when it changes*. This keeps DubSegmentTable re-renders bounded to
  // segment-crossings instead of the 4-50Hz timeupdate cadence.
  const setDubCurrentSegId = useAppStore(s => s.setDubCurrentSegId);
  const lastSegIdRef = useRef(null);
  useEffect(() => {
    if (!segments.length) {
      if (lastSegIdRef.current != null) {
        lastSegIdRef.current = null;
        setDubCurrentSegId(null);
      }
      return;
    }
    // Linear scan — fine for ≤200 segments. For longer transcripts we'd
    // switch to a binary search; keep it simple until needed.
    let hit = null;
    for (const s of segments) {
      if (currentTime >= s.start && currentTime < s.end) { hit = s.id; break; }
    }
    if (hit !== lastSegIdRef.current) {
      lastSegIdRef.current = hit;
      setDubCurrentSegId(hit);
    }
  }, [currentTime, segments, setDubCurrentSegId]);
  // Clear on unmount so a stale id can't outlive the editor.
  useEffect(() => () => { setDubCurrentSegId(null); }, [setDubCurrentSegId]);

  // ── Core init — only re-runs when src changes ───────────────────────────────
  useEffect(() => {
    if (!waveContainerRef.current || !audioSrc) return;

    setReady(false);
    setLoadError(false);
    setSourceMissing(false);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setFallbackMode(false);
    playRangeEndRef.current = null;

    // ── 1. Create the video element imperatively (stable, no React re-renders) ──
    let videoEl = null;
    let videoRetryTimer = null;
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
      // Surface media decode failures so future format issues don't
      // present as a silent black box. MediaError codes: 1=aborted,
      // 2=network, 3=decode, 4=src not supported. 3 = real codec/
      // container mismatch (decoder ran but couldn't handle it); 4 =
      // server returned a non-media response (most often a 404 HTML
      // body when the source video moved or was deleted between
      // project save and reload). In either case the rest of the
      // pipeline can't do anything useful, so flip into the
      // user-facing error fallback instead of staring at a black box.
      // Right after a URL ingest the server file may not be finalized yet
      // (yt-dlp still remuxing) — the first load then fails with code 2
      // (network) or 4 (non-media 404 body) and the preview used to stay a
      // black box until the project was reloaded. Retry with backoff before
      // declaring the source dead; code 3 (decode) is terminal immediately.
      let videoRetries = 0;
      videoEl.addEventListener('error', () => {
        const code = videoEl.error?.code;
        if ((code === 2 || code === 4) && videoRetries < 6) {
          videoRetries += 1;
          videoRetryTimer = setTimeout(() => {
            try { videoEl.src = videoSrc; videoEl.load(); } catch (_) { /* ignore */ }
          }, 1000 * videoRetries);
          return;
        }
        if (code === 3 || code === 4) {
          console.warn('[WaveformTimeline] video element rejected source', videoSrc, 'code', code);
          setSourceMissing(code === 4);
          setLoadError(true);
        }
      });
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
        plugins:       [minimap, timeline],
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
      mediaEl.addEventListener('timeupdate', () => {
        setCurrentTime(mediaEl.currentTime);
        // playRange watcher — stop at the requested slot end.
        if (playRangeEndRef.current != null && mediaEl.currentTime >= playRangeEndRef.current - 0.02) {
          playRangeEndRef.current = null;
          try { mediaEl.pause(); } catch (_) { /* ignore */ }
        }
      });
      mediaEl.addEventListener('play',  () => setIsPlaying(true));
      mediaEl.addEventListener('pause', () => { setIsPlaying(false); playRangeEndRef.current = null; });
      mediaEl.addEventListener('ended', () => setIsPlaying(false));
      wsRef.current = null;
      setFallbackMode(true);
      return;
    }

    ws.on('ready',      ()  => { setDuration(ws.getDuration()); setReady(true); });
    ws.on('timeupdate', (t) => {
      setCurrentTime(t);
      // playRange watcher — pause when the requested slot finishes.
      if (playRangeEndRef.current != null && t >= playRangeEndRef.current - 0.02) {
        playRangeEndRef.current = null;
        try { ws.pause(); } catch (_) { /* ignore */ }
      }
    });
    ws.on('play',       ()  => setIsPlaying(true));
    ws.on('pause',      ()  => { setIsPlaying(false); playRangeEndRef.current = null; });
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
            // HTTP 404 on the companion audio means the source file is
            // gone (typically: project loaded after the underlying media
            // was moved/deleted). Surface that explicitly — an empty
            // waveform fallback would just confuse the user into thinking
            // the file is silent. Other decode failures still fall back
            // to empty peaks so the media element can still play.
            const isMissing = /\bHTTP 404\b/.test(String(decodeErr?.message || decodeErr));
            if (isMissing) {
              console.warn('Audio source missing (HTTP 404):', audioSrc);
              setSourceMissing(true);
              setLoadError(true);
              return;
            }
            console.warn('Audio decode fallback failed, loading with empty peaks:', decodeErr);
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

    wsRef.current = ws;

    return () => {
      if (videoRetryTimer) clearTimeout(videoRetryTimer);
      // Gracefully stop before destroy to avoid WaveSurfer's internal
      // fetch progress handler logging "AbortError: Fetch is aborted".
      try { ws.pause(); } catch (_) {}
      try { ws.cancelAudioFetch?.(); } catch (_) {}
      // Empty the media source before destroy so any in-flight fetch
      // resolves its AbortController without a stale reference.
      if (mediaEl && !videoEl) {
        try { mediaEl.pause(); mediaEl.removeAttribute('src'); mediaEl.load?.(); } catch (_) {}
      }
      try { ws.destroy(); } catch (_) {}
      wsRef.current      = null;
      mediaElRef.current = null;
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

  // ── Alignment metrics — the single {pxPerSec, scrollLeft} source ────────────
  // Everything the SegmentTrack draws derives from these two numbers, read
  // off WaveSurfer's wrapper after every zoom/scroll/redraw/resize. rAF-
  // throttled so scroll events can't render-storm.
  const metricsRafRef = useRef(0);
  const syncMetrics = useCallback(() => {
    if (metricsRafRef.current) return;
    metricsRafRef.current = requestAnimationFrame(() => {
      metricsRafRef.current = 0;
      const ws = wsRef.current;
      if (!ws) return;
      let wrap = null;
      try { wrap = ws.getWrapper?.(); } catch (_) { /* destroyed */ }
      if (!wrap) return;
      const scrollEl = wrap.parentElement || wrap;
      const dur = ws.getDuration?.() || 0;
      const next = {
        pxPerSec: dur > 0 ? wrap.scrollWidth / dur : 0,
        scrollLeft: scrollEl.scrollLeft || 0,
      };
      setMetrics(m => (m.pxPerSec === next.pxPerSec && m.scrollLeft === next.scrollLeft) ? m : next);
    });
  }, []);
  useEffect(() => () => { if (metricsRafRef.current) cancelAnimationFrame(metricsRafRef.current); }, []);

  useEffect(() => {
    if (!ready || !wsRef.current) return undefined;
    const ws = wsRef.current;
    ws.on('redraw', syncMetrics);
    ws.on('zoom', syncMetrics);
    ws.on('scroll', syncMetrics);
    let wrap = null;
    try { wrap = ws.getWrapper?.(); } catch (_) { /* ignore */ }
    const scrollEl = wrap?.parentElement || null;
    if (scrollEl) scrollEl.addEventListener('scroll', syncMetrics, { passive: true });
    const ro = scrollEl ? new ResizeObserver(syncMetrics) : null;
    if (ro && scrollEl) ro.observe(scrollEl);
    syncMetrics();
    return () => {
      try { ws.un('redraw', syncMetrics); ws.un('zoom', syncMetrics); ws.un('scroll', syncMetrics); } catch (_) { /* destroyed */ }
      if (scrollEl) scrollEl.removeEventListener('scroll', syncMetrics);
      if (ro) ro.disconnect();
    };
  }, [ready, syncMetrics]);

  // ── Zoom ────────────────────────────────────────────────────────────────────
  // pendingZoomAnchorRef keeps the time under the cursor fixed across a
  // Ctrl/Cmd-wheel zoom: after ws.zoom() we re-read the real pxPerSec and
  // restore the anchor's pixel position.
  const pendingZoomAnchorRef = useRef(null);
  useEffect(() => {
    if (wsRef.current && ready) {
      try {
        wsRef.current.zoom(zoom);
        const anchor = pendingZoomAnchorRef.current;
        if (anchor) {
          pendingZoomAnchorRef.current = null;
          const wrap = wsRef.current.getWrapper?.();
          const scrollEl = wrap?.parentElement;
          const dur = wsRef.current.getDuration?.() || 0;
          if (wrap && scrollEl && dur > 0) {
            const pps = wrap.scrollWidth / dur;
            scrollEl.scrollLeft = Math.max(0, anchor.time * pps - anchor.cursorX);
          }
        }
      } catch (err) {
        console.warn('WaveSurfer zoom failed:', err);
      }
      syncMetrics();
    }
  }, [zoom, ready, syncMetrics]);

  // Imperative seek + scroll hooks — used by the transcript table to jump the
  // player to a clicked row, and by the mouse-wheel handler below.
  useImperativeHandle(ref, () => ({
    seekTo(time) {
      const ws = wsRef.current;
      if (ws && ready) {
        try {
          const d = ws.getDuration?.() || duration || 0;
          const t = Math.max(0, Math.min(time, d || time));
          if (typeof ws.setTime === 'function') ws.setTime(t);
          else if (typeof ws.seekTo === 'function' && d > 0) ws.seekTo(t / d);
        } catch (err) { console.warn('WaveSurfer seek failed:', err); }
        return;
      }
      const el = mediaElRef.current;
      if (el && Number.isFinite(time)) {
        try { el.currentTime = Math.max(0, time); } catch (err) { console.warn('media seek failed:', err); }
      }
    },
  }), [ready, duration]);

  // Horizontal mouse-wheel → scroll the waveform. WaveSurfer doesn't bind this
  // by default; users expect to spin the wheel over a long timeline. We also
  // honour vertical wheel (most mice) as horizontal motion.
  const onWaveWheel = useCallback((e) => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    const wrap = ws.getWrapper?.();
    if (!wrap) return;
    const scrollEl = wrap.parentElement || wrap;
    // Ctrl/Cmd + wheel = zoom centered on the cursor (#280, item 3).
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const dur = ws.getDuration?.() || 0;
      if (dur <= 0) return;
      const rect = scrollEl.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const curPps = wrap.scrollWidth / dur;
      const timeAt = (scrollEl.scrollLeft + cursorX) / curPps;
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      setZoom(z => {
        const nz = Math.min(300, Math.max(10, Math.round(z * factor)));
        if (nz !== z) pendingZoomAnchorRef.current = { time: timeAt, cursorX };
        return nz;
      });
      return;
    }
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!dx) return;
    e.preventDefault();
    scrollEl.scrollLeft += dx;
  }, [ready]);

  // playRange — seek + play, pausing automatically at `end` via the
  // timeupdate watcher wired in the init effect. Used by the SegmentTrack
  // ("play this slot") on whatever media the player currently holds, so it
  // respects the original/dubbed preview toggle for free.
  const playRange = useCallback((start, end) => {
    playRangeEndRef.current = end;
    const ws = wsRef.current;
    if (ws) {
      try { ws.setTime(start); ws.play(); } catch (_) { playRangeEndRef.current = null; }
      return;
    }
    const el = mediaElRef.current;
    if (el) {
      try { el.currentTime = start; el.play().catch(() => {}); } catch (_) { playRangeEndRef.current = null; }
    }
  }, []);

  // Scroll a given time into view (keyboard focus moved to an off-screen box).
  const ensureTimeVisible = useCallback((timeS) => {
    const ws = wsRef.current;
    if (!ws) return;
    const wrap = ws.getWrapper?.();
    const scrollEl = wrap?.parentElement;
    const dur = ws.getDuration?.() || 0;
    if (!wrap || !scrollEl || dur <= 0) return;
    const pps = wrap.scrollWidth / dur;
    const x = timeS * pps;
    if (x < scrollEl.scrollLeft || x > scrollEl.scrollLeft + scrollEl.clientWidth) {
      scrollEl.scrollLeft = Math.max(0, x - scrollEl.clientWidth * 0.3);
    }
  }, []);

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
          {sourceMissing ? (
            <>
              ⚠ Source media missing — this file may have moved or been deleted.
              Re-upload the video to continue.
            </>
          ) : (
            <>⚠ Could not load audio from this file</>
          )}
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
            onWheel={onWaveWheel}
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

        {/* Segment editing lane — pixel-aligned with the waveform via the
            shared {pxPerSec, scrollLeft} metrics. In the WebKit fallback
            (no WaveSurfer) it self-scrolls with a fixed px/sec scale. */}
        {ready && segments.length > 0 && (
          <SegmentTrack
            segments={segments}
            pxPerSec={fallbackMode ? zoom : metrics.pxPerSec}
            scrollLeft={metrics.scrollLeft}
            duration={duration}
            currentTime={currentTime}
            onsets={onsets}
            disabled={disabled}
            selectedId={selectedSegId}
            onSelectSeg={onSelectSeg}
            incrementalPlan={incrementalPlan}
            onCommit={onSegmentCommit}
            onDelete={onSegmentDelete}
            onPlayRange={playRange}
            onPreviewSegment={onPreviewSegment}
            onEnsureVisible={ensureTimeVisible}
            selfScroll={fallbackMode}
          />
        )}
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

export default forwardRef(WaveformTimeline);
