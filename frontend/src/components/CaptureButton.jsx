import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Clipboard, X, Loader, Zap, Target, Check } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../store';
import './CaptureButton.css';

import { API as API_BASE } from '../api/client';
import { addTranscription } from '../pages/Transcriptions';

// Flip the system tray icon between default and red-dot. No-op when not
// running inside the Tauri shell (e.g. browser webui, Docker).
async function setTrayRecording(recording) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_tray_recording', { recording });
  } catch { /* not in Tauri */ }
}

const CAPTURE_MODES = [
  { id: 'fast',     label: 'Turbo',    desc: 'MLX Whisper Turbo — fastest',      icon: <Zap size={12} /> },
  { id: 'accurate', label: 'Accurate', desc: 'WhisperX — best word timing',       icon: <Target size={12} /> },
];

const LS_CAPTURE_MODE = 'omni_capture_mode';
const LS_AUTO_COPY = 'omni_capture_auto_copy';

/**
 * CaptureButton — global dictation / voice capture widget.
 *
 * Dual-mode architecture:
 *   • Turbo (default): MLX Whisper Turbo on Apple Silicon — ~5× faster
 *   • Accurate: WhisperX with forced alignment — word-level timing
 *
 * Auto-copies to clipboard so users can immediately ⌘V into any app.
 */
export default function CaptureButton() {
  const [state, setState] = useState('idle'); // idle | recording | transcribing | done | error
  const [transcript, setTranscript] = useState('');
  const [duration, setDuration] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [captureMode, setCaptureMode] = useState(() =>
    localStorage.getItem(LS_CAPTURE_MODE) || 'fast'
  );
  const [autoCopy, setAutoCopy] = useState(() =>
    localStorage.getItem(LS_AUTO_COPY) !== 'false'
  );
  const [lastEngine, setLastEngine] = useState('');
  const [lastTime, setLastTime] = useState(0);
  const [copied, setCopied] = useState(false);
  const [partialText, setPartialText] = useState('');

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const wsRef = useRef(null);
  // Chunks captured before the WebSocket finishes its handshake — drained
  // in `ws.onopen` so the server's `final` transcript covers the full
  // recording (no missing first 250 ms).
  const wsPendingRef = useRef([]);
  // Set when the WebSocket delivers a `final` message. Used to dedupe
  // against the HTTP POST fallback so we don't transcribe twice.
  const wsHadFinalRef = useRef(false);
  // Cancellable timer that fires the HTTP POST fallback if WS `final`
  // never arrives in time.
  const fallbackTimerRef = useRef(null);
  // Wall-clock start of the current recording. Read by stopRecording to
  // size the WS-fallback timeout against actual recording length without
  // closing over the (stale) `duration` state.
  const startTimeRef = useRef(0);

  // Keyboard shortcut: Ctrl+Shift+Space (or ⌘+Shift+Space on Mac)
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        if (state === 'idle' || state === 'done' || state === 'error') {
          startRecording();
        } else if (state === 'recording') {
          stopRecording();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state]);

  // Listen for tray "Start Dictation" event (Tauri desktop)
  useEffect(() => {
    let unlisten;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('tray-dictate', () => {
          if (state === 'idle' || state === 'done' || state === 'error') {
            startRecording();
          } else if (state === 'recording') {
            stopRecording();
          }
        });
      } catch { /* not in Tauri */ }
    })();
    return () => { if (unlisten) unlisten(); };
  }, [state]);

  // Timer while recording
  useEffect(() => {
    if (state === 'recording') {
      const t0 = Date.now();
      timerRef.current = setInterval(() => setDuration(Date.now() - t0), 100);
      return () => clearInterval(timerRef.current);
    }
    clearInterval(timerRef.current);
  }, [state]);

  // Render a transcription result (from either the WS `final` message or
  // the HTTP POST fallback). Idempotent — guarded by wsHadFinalRef so a
  // late HTTP response can't overwrite a WS final that already landed.
  const applyResult = useCallback(async (data) => {
    setTranscript(data.text || '');
    setLastEngine(data.engine || '');
    setLastTime(data.transcription_time_s || 0);
    setState('done');

    if (data.text) {
      addTranscription(data);
    }

    if (data.text && autoCopy) {
      try {
        await navigator.clipboard.writeText(data.text);
        setCopied(true);
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('simulate_paste');
          toast.success('Pasted into active app', { duration: 2000 });
        } catch {
          toast.success('Copied to clipboard — paste with ⌘V', { duration: 2000 });
        }
      } catch { /* clipboard API may fail in some contexts */ }
    }
  }, [autoCopy]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
      });
      streamRef.current = stream;
      chunksRef.current = [];
      wsPendingRef.current = [];
      wsHadFinalRef.current = false;
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          // Stream chunk to WebSocket for partial results AND to drive the
          // server's `final` transcription. If the socket is still in
          // CONNECTING state, queue the chunk so `ws.onopen` can drain it
          // — otherwise the server's final transcript would lose the
          // first ~250 ms of audio (the open-handshake window).
          e.data.arrayBuffer().then(buf => {
            const ws = wsRef.current;
            if (!ws) return;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(buf);
            } else if (ws.readyState === WebSocket.CONNECTING) {
              wsPendingRef.current.push(buf);
            }
          });
        }
      };
      // recorder.onstop frees the mic and (only as fallback) kicks the HTTP
      // POST. The WebSocket `final` path is preferred — see ws.onmessage.
      recorder.onstop = () => {
        if (wsHadFinalRef.current) return;
        if (!wsRef.current) {
          // WS never opened — HTTP POST is the only path.
          sendForTranscription();
        }
        // Otherwise: the fallback timer set in stopRecording will fire if
        // the WS final never arrives.
      };
      mediaRecorderRef.current = recorder;
      recorder.start(250); // collect in 250ms chunks

      startTimeRef.current = Date.now();
      setState('recording');
      setDuration(0);
      setTranscript('');
      setPartialText('');
      setExpanded(true);
      setCopied(false);
      setLastEngine('');
      setLastTime(0);
      setTrayRecording(true);

      // Open WebSocket for streaming partial results + final transcript
      try {
        const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsHost = API_BASE.replace(/^https?:\/\//, '').replace(/\/$/, '')
          || `${window.location.hostname}:3900`;
        const wsUrl = `${wsProto}://${wsHost}/ws/transcribe`;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          // Drain chunks captured during the WS handshake.
          for (const buf of wsPendingRef.current) {
            try { ws.send(buf); } catch {}
          }
          wsPendingRef.current = [];
        };
        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.type === 'partial') {
              setPartialText(msg.text || '');
            } else if (msg.type === 'final') {
              wsHadFinalRef.current = true;
              if (fallbackTimerRef.current) {
                clearTimeout(fallbackTimerRef.current);
                fallbackTimerRef.current = null;
              }
              applyResult(msg);
              try { ws.close(); } catch {}
            } else if (msg.type === 'error') {
              // Let the fallback timer fire HTTP POST.
            }
          } catch {}
        };
        ws.onerror = () => { wsRef.current = null; };
        ws.onclose = () => { wsRef.current = null; };
        wsRef.current = ws;
      } catch {
        // WebSocket not available — will fallback to HTTP POST
        wsRef.current = null;
      }
    } catch (err) {
      toast.error('Microphone access denied. Check browser permissions.');
      setTrayRecording(false);
      setState('error');
    }
  }, [applyResult]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    // Signal end-of-audio to the WS but DO NOT close — we want the server's
    // `final` message to arrive over the same socket. The HTTP POST fallback
    // timer below covers the case where final never lands.
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      const sendEof = () => { try { ws.send('EOF'); } catch {} };
      if (ws.readyState === WebSocket.OPEN) {
        sendEof();
      } else {
        // Wait for open before sending EOF, otherwise the message is dropped.
        ws.addEventListener('open', sendEof, { once: true });
      }
      // Fallback: if WS final doesn't arrive in time, use HTTP POST.
      // Cleared in ws.onmessage when `final` lands. Timeout scales with
      // recording length so long-form dictation (where the server's final
      // pass naturally takes longer) doesn't trip the fallback and run the
      // model twice. Floor of 15 s covers slow first-call cold starts.
      const recorded = startTimeRef.current
        ? Date.now() - startTimeRef.current
        : 0;
      const ms = Math.max(15000, recorded + 10000);
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = setTimeout(() => {
        fallbackTimerRef.current = null;
        if (!wsHadFinalRef.current) {
          try { wsRef.current?.close(); } catch {}
          wsRef.current = null;
          sendForTranscription();
        }
      }, ms);
    }
    setTrayRecording(false);
    setState('transcribing');
  }, []);

  const sendForTranscription = useCallback(async () => {
    // Race-guard: WS final may have landed between when this was scheduled
    // and now. Skip the duplicate HTTP transcription.
    if (wsHadFinalRef.current) return;

    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('audio', blob, 'capture.webm');
    formData.append('mode', captureMode);

    try {
      const res = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      // Re-check guard — a WS final could land while we awaited the POST.
      if (wsHadFinalRef.current) return;
      await applyResult(data);
    } catch (err) {
      if (wsHadFinalRef.current) return;
      toast.error(`Transcription failed: ${err.message}`);
      setState('error');
      setTranscript('');
    }
  }, [captureMode, applyResult]);

  const copyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(transcript).then(() => {
      setCopied(true);
      toast.success('Copied to clipboard');
    });
  }, [transcript]);

  const dismiss = () => {
    setState('idle');
    setTranscript('');
    setExpanded(false);
    setDuration(0);
    setCopied(false);
  };

  const toggleCapture = () => {
    if (state === 'idle' || state === 'done' || state === 'error') {
      startRecording();
    } else if (state === 'recording') {
      stopRecording();
    }
  };

  const formatTime = (ms) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return m > 0 ? `${m}:${String(ss).padStart(2, '0')}` : `${ss}s`;
  };

  return (
    <div className={`capture-widget ${expanded ? 'capture-widget--expanded' : ''}`}>
      {/* Expanded panel */}
      {expanded && (
        <div className="capture-panel">
          <div className="capture-panel__header">
            <span className="capture-panel__title">
              {state === 'recording' && '🎙️ Listening…'}
              {state === 'transcribing' && '📝 Transcribing…'}
              {state === 'done' && '✅ Done'}
              {state === 'error' && '❌ Error'}
              {state === 'idle' && '🎤 Capture'}
            </span>
            <button className="capture-panel__close" onClick={dismiss} title="Close" aria-label="Close capture panel">
              <X size={12} />
            </button>
          </div>

          {state === 'recording' && (
            <div className="capture-panel__recording">
              <div className="capture-panel__waveform">
                {[...Array(12)].map((_, i) => (
                  <span key={i} className="capture-panel__bar" style={{ animationDelay: `${i * 0.08}s` }} />
                ))}
              </div>
              <span className="capture-panel__timer">{formatTime(duration)}</span>
              {partialText && (
                <p className="capture-panel__partial">{partialText}</p>
              )}
            </div>
          )}

          {state === 'transcribing' && (
            <div className="capture-panel__loading">
              <Loader size={16} className="spinner" />
              <span>Processing audio…</span>
            </div>
          )}

          {state === 'done' && transcript && (
            <div className="capture-panel__result">
              <p className="capture-panel__text">{transcript}</p>
              <div className="capture-panel__result-actions">
                <button className="capture-panel__copy" onClick={copyToClipboard}>
                  {copied ? <Check size={12} /> : <Clipboard size={12} />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                {lastEngine && (
                  <span className="capture-panel__engine">
                    {lastEngine === 'mlx-whisper' ? '⚡ MLX' : lastEngine} · {lastTime}s
                  </span>
                )}
              </div>
            </div>
          )}

          {state === 'done' && !transcript && (
            <div className="capture-panel__empty">
              No speech detected. Try again.
            </div>
          )}

          {/* Mode selector + auto-copy toggle */}
          <div className="capture-panel__controls">
            <div className="capture-panel__mode-toggle" role="radiogroup" aria-label="Transcription mode">
              {CAPTURE_MODES.map(m => (
                <button
                  key={m.id}
                  className={`capture-panel__mode-btn ${captureMode === m.id ? 'is-active' : ''}`}
                  onClick={() => {
                    setCaptureMode(m.id);
                    localStorage.setItem(LS_CAPTURE_MODE, m.id);
                  }}
                  title={m.desc}
                  aria-label={`${m.label} mode: ${m.desc}`}
                  aria-checked={captureMode === m.id}
                  role="radio"
                >
                  {m.icon} {m.label}
                </button>
              ))}
            </div>
            <button
              className={`capture-panel__auto-copy ${autoCopy ? 'is-active' : ''}`}
              onClick={() => {
                const next = !autoCopy;
                setAutoCopy(next);
                localStorage.setItem(LS_AUTO_COPY, String(next));
              }}
              title={autoCopy ? 'Auto-copy enabled — results go to clipboard' : 'Auto-copy disabled'}
              aria-label={autoCopy ? 'Disable auto-copy to clipboard' : 'Enable auto-copy to clipboard'}
              aria-pressed={autoCopy}
            >
              <Clipboard size={10} /> Auto
            </button>
          </div>

          <div className="capture-panel__hint">
            <kbd>{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}</kbd>+<kbd>⇧</kbd>+<kbd>Space</kbd>
          </div>
        </div>
      )}

      {/* Main FAB button */}
      <button
        className={`capture-fab ${state === 'recording' ? 'capture-fab--recording' : ''} ${state === 'transcribing' ? 'capture-fab--busy' : ''}`}
        onClick={toggleCapture}
        disabled={state === 'transcribing'}
        title={state === 'recording' ? 'Stop recording' : 'Start dictation (⌘+⇧+Space)'}
        aria-label={state === 'recording' ? 'Stop recording' : 'Start voice dictation'}
      >
        {state === 'recording' ? <MicOff size={20} /> : state === 'transcribing' ? <Loader size={20} className="spinner" /> : <Mic size={20} />}
      </button>
    </div>
  );
}
