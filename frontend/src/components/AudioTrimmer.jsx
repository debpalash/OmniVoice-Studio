import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Scissors, Play, Pause, Check, ZoomIn, ZoomOut, Maximize2, Repeat } from 'lucide-react';
import {
  clamp, encodeWav, computePeaksFromChannel, computePeaksAsync, pickTickInterval,
  xToTime as xToTimeUtil, pickHandle as pickHandleUtil,
  applyDrag as applyDragUtil, zoomAtCursor, zoomCenter, sliceToMono,
  decodeToMonoLowRate, DEFAULT_PEAK_BUCKETS,
} from '../utils/audioTrim.js';
import { Dialog, Button } from '../ui';
import './AudioTrimmer.css';

const EDGE_GRAB_PX = 10;

const computePeaks = (buffer, buckets = DEFAULT_PEAK_BUCKETS) =>
  computePeaksFromChannel(buffer.getChannelData(0), buckets);

function fmtSec(t, precision = 2) {
  if (!isFinite(t)) return '0.00s';
  return `${t.toFixed(precision)}s`;
}

function fmtHMS(t) {
  if (!isFinite(t)) return '0:00.00';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export default function AudioTrimmer({ file, maxSeconds = 15, onConfirm, onCancel }) {
  const waveRef = useRef(null);
  const rulerRef = useRef(null);
  const audioRef = useRef(null);
  const containerRef = useRef(null);
  const bufferRef = useRef(null);
  const peaksRef = useRef(null);
  const drawRafRef = useRef(0);
  const dragRafRef = useRef(0);
  const dragStateRef = useRef(null);
  const pointerRef = useRef(null);
  const stateRef = useRef({ start: 0, end: 0, cursor: 0, viewStart: 0, viewEnd: 0, duration: 0 });

  const [ready, setReady] = useState(false);
  const [decoding, setDecoding] = useState(true);
  const [peakProgress, setPeakProgress] = useState(0);
  const [error, setError] = useState('');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [startInput, setStartInput] = useState('0.00');
  const [endInput, setEndInput] = useState('0.00');

  const [audioMeta, setAudioMeta] = useState(null);

  useEffect(() => {
    stateRef.current = {
      start, end, cursor, viewStart, viewEnd,
      duration: bufferRef.current ? bufferRef.current.duration : 0,
    };
  }, [start, end, cursor, viewStart, viewEnd]);

  useEffect(() => { setStartInput(start.toFixed(2)); }, [start]);
  useEffect(() => { setEndInput(end.toFixed(2)); }, [end]);

  // Decode (low rate mono) + async peaks — keeps UI responsive for long files.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setDecoding(true);
    setReady(false);
    setPeakProgress(0);
    (async () => {
      try {
        const buf = await decodeToMonoLowRate(file, 22050);
        if (cancelled) return;
        bufferRef.current = buf;
        setAudioMeta({ duration: buf.duration, sampleRate: buf.sampleRate });
        // Prime with a coarse synchronous pass so waveform shows something instantly.
        peaksRef.current = computePeaksFromChannel(buf.getChannelData(0), 1024);
        setDuration(buf.duration);
        setViewEnd(buf.duration);
        setEnd(Math.min(buf.duration, maxSeconds));
        setStart(0);
        setCursor(0);
        setViewStart(0);
        setDecoding(false);
        setReady(true);
        // Refine peaks asynchronously without blocking UI.
        const refined = await computePeaksAsync(
          buf.getChannelData(0),
          DEFAULT_PEAK_BUCKETS,
          (p) => { if (!cancelled) setPeakProgress(p); },
        );
        if (cancelled) return;
        peaksRef.current = refined;
        setPeakProgress(1);
      } catch (e) {
        if (!cancelled) setError('Decode failed: ' + (e.message || e));
        setDecoding(false);
      }
    })();
    return () => { cancelled = true; };
  }, [file, maxSeconds]);

  // Bind audio src
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = audioRef.current;
    if (a) { a.src = url; a.load(); }
    return () => {
      if (a) { try { a.pause(); a.removeAttribute('src'); a.load(); } catch {} }
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const sizeCanvas = useCallback((canvas) => {
    if (!canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return { w, h, dpr };
  }, []);

  const drawWave = useCallback(() => {
    const buffer = bufferRef.current;
    const peaks = peaksRef.current;
    const canvas = waveRef.current;
    if (!buffer || !peaks || !canvas) return;
    const sized = sizeCanvas(canvas);
    if (!sized) return;
    const { w, h, dpr } = sized;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const { viewStart: vs, viewEnd: ve, start: s, end: e, cursor: c, duration: dur } = stateRef.current;
    const viewDur = Math.max(1e-6, ve - vs);
    const totalBuckets = peaks.length / 2;
    const secPerBucket = dur / totalBuckets;
    const secPerPixel = viewDur / w;
    const useRaw = secPerPixel < secPerBucket;
    const ch = buffer.getChannelData(0);
    const sr = buffer.sampleRate;

    // Center baseline
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Waveform
    ctx.fillStyle = '#7a6f5d';
    for (let x = 0; x < w; x++) {
      const t0 = vs + (x / w) * viewDur;
      const t1 = vs + ((x + 1) / w) * viewDur;
      let mn = 1, mx = -1;
      if (useRaw) {
        const i0 = Math.max(0, Math.floor(t0 * sr));
        const i1 = Math.min(ch.length, Math.ceil(t1 * sr));
        for (let i = i0; i < i1; i++) {
          const v = ch[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      } else {
        const b0 = Math.max(0, Math.floor(t0 / secPerBucket));
        const b1 = Math.min(totalBuckets, Math.ceil(t1 / secPerBucket));
        for (let b = b0; b < b1; b++) {
          const pmn = peaks[b * 2];
          const pmx = peaks[b * 2 + 1];
          if (pmn < mn) mn = pmn;
          if (pmx > mx) mx = pmx;
        }
      }
      if (mx < mn) { mn = 0; mx = 0; }
      const y1 = (1 - mx) * 0.5 * h;
      const y2 = (1 - mn) * 0.5 * h;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    // Selection
    const tToX = (t) => ((t - vs) / viewDur) * w;
    const sx = tToX(s);
    const ex = tToX(e);
    const selW = ex - sx;
    ctx.fillStyle = 'rgba(211,134,155,0.18)';
    ctx.fillRect(sx, 0, selW, h);

    // Redraw selection waveform in accent
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(0, sx), 0, Math.max(0, Math.min(w, ex) - Math.max(0, sx)), h);
    ctx.clip();
    ctx.fillStyle = '#d3869b';
    for (let x = Math.max(0, Math.floor(sx)); x < Math.min(w, Math.ceil(ex)); x++) {
      const t0 = vs + (x / w) * viewDur;
      const t1 = vs + ((x + 1) / w) * viewDur;
      let mn = 1, mx = -1;
      if (useRaw) {
        const i0 = Math.max(0, Math.floor(t0 * sr));
        const i1 = Math.min(ch.length, Math.ceil(t1 * sr));
        for (let i = i0; i < i1; i++) {
          const v = ch[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      } else {
        const b0 = Math.max(0, Math.floor(t0 / secPerBucket));
        const b1 = Math.min(totalBuckets, Math.ceil(t1 / secPerBucket));
        for (let b = b0; b < b1; b++) {
          const pmn = peaks[b * 2];
          const pmx = peaks[b * 2 + 1];
          if (pmn < mn) mn = pmn;
          if (pmx > mx) mx = pmx;
        }
      }
      if (mx < mn) { mn = 0; mx = 0; }
      const y1 = (1 - mx) * 0.5 * h;
      const y2 = (1 - mn) * 0.5 * h;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    ctx.restore();

    // Selection border
    ctx.strokeStyle = '#d3869b';
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(sx + 0.5, 0.5, selW, h - 1);

    // Handles (flags)
    const handleW = 6 * dpr;
    const handleH = Math.min(h, 22 * dpr);
    ctx.fillStyle = '#d3869b';
    ctx.fillRect(sx - handleW / 2, 0, handleW, handleH);
    ctx.fillRect(ex - handleW / 2, 0, handleW, handleH);
    ctx.fillRect(sx - handleW / 2, h - handleH, handleW, handleH);
    ctx.fillRect(ex - handleW / 2, h - handleH, handleW, handleH);

    // Playhead
    if (c >= vs && c <= ve) {
      const cx = tToX(c);
      ctx.fillStyle = '#fabd2f';
      ctx.fillRect(cx, 0, 1.5 * dpr, h);
    }
  }, [sizeCanvas]);

  const drawRuler = useCallback(() => {
    const canvas = rulerRef.current;
    const buffer = bufferRef.current;
    if (!canvas || !buffer) return;
    const sized = sizeCanvas(canvas);
    if (!sized) return;
    const { w, h, dpr } = sized;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const { viewStart: vs, viewEnd: ve } = stateRef.current;
    const viewDur = Math.max(1e-6, ve - vs);
    const tick = pickTickInterval(viewDur);
    const firstTick = Math.ceil(vs / tick) * tick;

    ctx.font = `${10 * dpr}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = '#a89984';
    ctx.strokeStyle = 'rgba(168,153,132,0.3)';
    ctx.lineWidth = 1;
    for (let t = firstTick; t <= ve + 1e-6; t += tick) {
      const x = ((t - vs) / viewDur) * w;
      ctx.beginPath();
      ctx.moveTo(x, h - 6 * dpr);
      ctx.lineTo(x, h);
      ctx.stroke();
      const label = tick >= 1 ? fmtHMS(t) : `${t.toFixed(2)}s`;
      ctx.fillText(label, x + 3 * dpr, h - 8 * dpr);
    }
  }, [sizeCanvas]);

  const scheduleDraw = useCallback(() => {
    if (drawRafRef.current) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = 0;
      drawWave();
      drawRuler();
    });
  }, [drawWave, drawRuler]);

  useEffect(() => { scheduleDraw(); }, [start, end, cursor, viewStart, viewEnd, ready, scheduleDraw]);

  useEffect(() => {
    const onResize = () => scheduleDraw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [scheduleDraw]);

  const canvasRect = () => {
    const c = waveRef.current;
    return c ? c.getBoundingClientRect() : null;
  };

  const xToTime = (clientX) => {
    const rect = canvasRect();
    if (!rect) return 0;
    return xToTimeUtil(clientX - rect.left, rect.width,
      stateRef.current.viewStart, stateRef.current.viewEnd);
  };

  const pickHandleAt = (clientX) => {
    const rect = canvasRect();
    if (!rect) return null;
    return pickHandleUtil(clientX, rect.left, rect.width, stateRef.current, EDGE_GRAB_PX);
  };

  const applyPointer = useCallback(() => {
    const pos = pointerRef.current;
    if (!pos) return;
    pointerRef.current = null;
    const buffer = bufferRef.current;
    const rect = canvasRect();
    if (!buffer || !rect) return;
    const drag = dragStateRef.current;
    if (!drag) {
      const t = xToTimeUtil(pos.clientX - rect.left, rect.width,
        stateRef.current.viewStart, stateRef.current.viewEnd);
      setCursor(clamp(t, 0, stateRef.current.duration));
      return;
    }
    const out = applyDragUtil(stateRef.current, pos.clientX, rect.left, rect.width, drag, 0.02);
    if (drag.mode === 'start') setStart(out.start);
    else if (drag.mode === 'end') setEnd(out.end);
    else if (drag.mode === 'region' || drag.mode === 'new') { setStart(out.start); setEnd(out.end); }
    else if (drag.mode === 'pan') { setViewStart(out.viewStart); setViewEnd(out.viewEnd); }
  }, []);

  const schedulePointer = useCallback(() => {
    if (dragRafRef.current) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = 0;
      applyPointer();
    });
  }, [applyPointer]);

  useEffect(() => {
    const move = (e) => {
      pointerRef.current = { clientX: e.clientX };
      schedulePointer();
    };
    const up = () => { dragStateRef.current = null; pointerRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [schedulePointer]);

  const onCanvasDown = (e) => {
    if (!ready) return;
    e.preventDefault();
    const buffer = bufferRef.current;
    if (!buffer) return;
    if (e.button === 1 || e.altKey || e.metaKey) {
      dragStateRef.current = {
        mode: 'pan',
        startClientX: e.clientX,
        viewStart: stateRef.current.viewStart,
        viewDur: stateRef.current.viewEnd - stateRef.current.viewStart,
      };
      pointerRef.current = { clientX: e.clientX };
      schedulePointer();
      return;
    }
    const handle = pickHandleAt(e.clientX);
    if (handle === 'region') {
      const t = xToTime(e.clientX);
      dragStateRef.current = {
        mode: 'region',
        regionLen: stateRef.current.end - stateRef.current.start,
        offset: t - stateRef.current.start,
      };
    } else if (handle === 'start' || handle === 'end') {
      dragStateRef.current = { mode: handle };
    } else {
      const t = clamp(xToTime(e.clientX), 0, buffer.duration);
      // Start a fresh selection anchored at click point. Drag extends it.
      setStart(t);
      setEnd(t);
      setCursor(t);
      const a = audioRef.current;
      if (a) { try { a.currentTime = t; } catch {} }
      dragStateRef.current = { mode: 'new', anchorT: t };
    }
    pointerRef.current = { clientX: e.clientX };
    schedulePointer();
  };

  const onWheel = useCallback((e) => {
    const buffer = bufferRef.current;
    if (!buffer) return;
    e.preventDefault();
    const rect = waveRef.current.getBoundingClientRect();
    const { viewStart: vs, viewEnd: ve } = stateRef.current;
    const viewDur = ve - vs;
    if (e.shiftKey) {
      const dir = Math.sign(e.deltaY || e.deltaX);
      const pan = dir * viewDur * 0.15;
      const newVs = clamp(vs + pan, 0, buffer.duration - viewDur);
      setViewStart(newVs);
      setViewEnd(newVs + viewDur);
    } else {
      const xFrac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const factor = e.deltaY < 0 ? 0.8 : 1.25;
      const minDur = Math.max(0.01, buffer.sampleRate ? 200 / buffer.sampleRate : 0.01);
      const out = zoomAtCursor(vs, ve, buffer.duration, factor, xFrac, minDur);
      setViewStart(out.viewStart);
      setViewEnd(out.viewEnd);
    }
  }, []);

  useEffect(() => {
    const canvas = waveRef.current;
    if (!canvas) return;
    const handler = (e) => { if (ready) onWheel(e); };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [onWheel, ready]);

  const zoomIn = () => {
    const buffer = bufferRef.current; if (!buffer) return;
    const { viewStart: vs, viewEnd: ve } = stateRef.current;
    const out = zoomCenter(vs, ve, buffer.duration, 0.5);
    setViewStart(out.viewStart); setViewEnd(out.viewEnd);
  };
  const zoomOut = () => {
    const buffer = bufferRef.current; if (!buffer) return;
    const { viewStart: vs, viewEnd: ve } = stateRef.current;
    const out = zoomCenter(vs, ve, buffer.duration, 2);
    setViewStart(out.viewStart); setViewEnd(out.viewEnd);
  };
  const fitAll = () => {
    const buffer = bufferRef.current; if (!buffer) return;
    setViewStart(0);
    setViewEnd(buffer.duration);
  };
  const fitSelection = () => {
    const buffer = bufferRef.current; if (!buffer) return;
    const { start: s, end: e } = stateRef.current;
    const pad = Math.max(0.1, (e - s) * 0.2);
    const nvs = clamp(s - pad, 0, buffer.duration);
    const nve = clamp(e + pad, nvs + 0.02, buffer.duration);
    setViewStart(nvs);
    setViewEnd(nve);
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); return; }
    const s = stateRef.current.start;
    const doPlay = () => {
      try { a.currentTime = s; } catch (err) { console.warn('currentTime set failed', err); }
      a.play().then(() => setPlaying(true)).catch((err) => {
        setError('Playback failed: ' + (err.message || err));
      });
    };
    // HAVE_METADATA = 1 is enough to set currentTime on most browsers.
    if (a.readyState >= 1) {
      doPlay();
    } else {
      a.addEventListener('loadedmetadata', doPlay, { once: true });
      a.addEventListener('error', () => setError('Audio load failed'), { once: true });
    }
  };

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    let raf;
    const tick = () => {
      if (!a.paused) {
        setCursor(a.currentTime);
        const { start: s, end: e } = stateRef.current;
        if (a.currentTime >= e) {
          if (loop) {
            try { a.currentTime = s; } catch {}
          } else {
            a.pause();
            setPlaying(false);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loop]);

  const duration = end - start;
  const tooLong = duration > maxSeconds;
  const tooShort = duration < 0.1;

  const commitStartInput = () => {
    const v = parseFloat(startInput);
    if (isFinite(v)) setStart(clamp(v, 0, Math.max(0, end - 0.02)));
    else setStartInput(start.toFixed(2));
  };
  const commitEndInput = () => {
    const buffer = bufferRef.current;
    const v = parseFloat(endInput);
    if (isFinite(v) && buffer) setEnd(clamp(v, start + 0.02, buffer.duration));
    else setEndInput(end.toFixed(2));
  };

  const onKeyDown = (e) => {
    if (!ready) return;
    const buffer = bufferRef.current;
    if (!buffer) return;
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
    const fine = e.shiftKey ? 0.01 : e.altKey ? 1.0 : 0.1;
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) setEnd(clamp(end - fine, start + 0.02, buffer.duration));
      else setStart(clamp(start - fine, 0, Math.max(0, end - 0.02)));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) setEnd(clamp(end + fine, start + 0.02, buffer.duration));
      else setStart(clamp(start + fine, 0, Math.max(0, end - 0.02)));
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomOut(); }
    else if (e.key === 'Home') { e.preventDefault(); fitAll(); }
    else if (e.key === 'End') { e.preventDefault(); fitSelection(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    else if (e.key === 'Enter') { if (!tooLong && !tooShort) handleConfirm(); }
  };

  const keyHandlerRef = useRef(onKeyDown);
  useEffect(() => { keyHandlerRef.current = onKeyDown; }, [onKeyDown]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const handler = (e) => keyHandlerRef.current(e);
    node.addEventListener('keydown', handler);
    node.focus();
    return () => node.removeEventListener('keydown', handler);
  }, []);

  const handleConfirm = () => {
    const buffer = bufferRef.current;
    if (!buffer || tooLong || tooShort) return;
    const mono = sliceToMono(buffer, start, end);
    const wav = encodeWav(mono, buffer.sampleRate);
    const base = (file.name || 'trimmed').replace(/\.[^.]+$/, '');
    const trimmed = new File([wav], `${base}_trim.wav`, { type: 'audio/wav' });
    onConfirm(trimmed);
  };

  const duration_ms = Math.max(0, (end - start) * 1000);

  return (
    <Dialog
      open
      onClose={onCancel}
      size="xl"
      title={<><Scissors size={15} color="var(--color-brand)" /> Trim reference audio</>}
    >
      <div ref={containerRef} tabIndex={-1} className="audio-trimmer">
        <div className="audio-trimmer__meta">
          <span>{decoding
            ? 'Decoding audio…'
            : (audioMeta
                ? `Length ${fmtHMS(audioMeta.duration)} · ${audioMeta.sampleRate} Hz${peakProgress > 0 && peakProgress < 1 ? ` · rendering waveform ${Math.round(peakProgress * 100)}%` : ''}`
                : '…')
          }</span>
          <span className="audio-trimmer__hint">
            scroll = zoom · shift+scroll = pan · alt+drag = pan · ⏐ ⟵ ⟶ ⏐ keys adjust handles
          </span>
        </div>

        {error && <div className="audio-trimmer__error">{error}</div>}

        {/* Zoom controls */}
        <div className="audio-trimmer__toolbar">
          <Button variant="subtle" iconSize="md" onClick={zoomIn}        disabled={!ready} title="Zoom in (+)"><ZoomIn size={12}/></Button>
          <Button variant="subtle" iconSize="md" onClick={zoomOut}       disabled={!ready} title="Zoom out (-)"><ZoomOut size={12}/></Button>
          <Button variant="subtle" iconSize="md" onClick={fitAll}        disabled={!ready} title="Fit all (Home)"><Maximize2 size={12}/></Button>
          <Button variant="chip"   size="sm"    onClick={fitSelection} disabled={!ready} title="Fit selection (End)">FIT SEL</Button>
          <div className="audio-trimmer__view-info">
            View {fmtHMS(viewStart)} → {fmtHMS(viewEnd)} ({fmtSec(viewEnd - viewStart, viewEnd - viewStart < 10 ? 2 : 0)})
          </div>
        </div>

        {/* Ruler */}
        <canvas ref={rulerRef} className="audio-trimmer__ruler" />

        {/* Waveform */}
        <canvas ref={waveRef} onMouseDown={onCanvasDown} className="audio-trimmer__wave" />

        {/* Numeric fields */}
        <div className="audio-trimmer__fields">
          <label className="trim-field">
            <span className="trim-field__label">Start</span>
            <input
              type="text" inputMode="decimal" value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              onBlur={commitStartInput}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitStartInput(); } }}
              className="trim-field__input"
            />
            <span className="trim-field__unit">s</span>
          </label>
          <label className="trim-field">
            <span className="trim-field__label">End</span>
            <input
              type="text" inputMode="decimal" value={endInput}
              onChange={(e) => setEndInput(e.target.value)}
              onBlur={commitEndInput}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEndInput(); } }}
              className="trim-field__input"
            />
            <span className="trim-field__unit">s</span>
          </label>
          <div className="trim-field trim-field--readonly">
            <span className="trim-field__label">Length</span>
            <span className={`trim-field__value ${tooLong ? 'is-err' : ''}`}>
              {(duration_ms / 1000).toFixed(2)}s
            </span>
            <span className="trim-field__unit">{tooLong ? `>${maxSeconds}s` : tooShort ? 'too short' : 'ok'}</span>
          </div>
          <Button
            variant="icon"
            iconSize="md"
            active={loop}
            onClick={() => setLoop((v) => !v)}
            title="Loop preview"
          >
            <Repeat size={12} />
          </Button>
        </div>

        {/* Play / Action row */}
        <div className="audio-trimmer__actions">
          <Button
            variant="subtle"
            onClick={togglePlay}
            disabled={!ready}
            leading={playing ? <Pause size={12} /> : <Play size={12} />}
            className="audio-trimmer__play-btn"
          >
            {playing ? 'Pause' : 'Preview selection'}
          </Button>
          <span className="audio-trimmer__kbd-hint">Space to play · Enter to confirm · Esc to cancel</span>

          <div className="audio-trimmer__actions-right">
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button
              variant={(tooLong || tooShort) ? 'danger' : 'primary'}
              disabled={!ready || tooLong || tooShort}
              onClick={handleConfirm}
              leading={<Check size={12} />}
            >
              Use trimmed
            </Button>
          </div>
        </div>

        <audio ref={audioRef} preload="auto" onEnded={() => setPlaying(false)} className="audio-trimmer__audio" />
      </div>
    </Dialog>
  );
}
