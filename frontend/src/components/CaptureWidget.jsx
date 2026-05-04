import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Loader } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../store';
import './CaptureWidget.css';

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

const LS_CAPTURE_MODE = 'omni_capture_mode';

function formatElapsed(ms) {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  if (mins > 0) return `${mins}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}

/**
 * CaptureWidget — floating pill for dictation.
 *
 * Minimal status-only UI: pulsing dot + label + timer.
 * All interaction via global hotkey (hold-to-talk).
 * Records → transcribes → auto-pastes → auto-dismisses.
 */
export default function CaptureWidget({ onDismiss }) {
  const [state, setState] = useState('idle'); // idle | recording | transcribing | done | error
  const [transcript, setTranscript] = useState('');
  const [duration, setDuration] = useState(0);
  const [captureMode] = useState(() =>
    localStorage.getItem(LS_CAPTURE_MODE) || 'fast'
  );
  const [lastEngine, setLastEngine] = useState('');
  const [lastTime, setLastTime] = useState(0);
  const [partialText, setPartialText] = useState('');

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const wsRef = useRef(null);
  const wsPendingRef = useRef([]);
  const wsHadFinalRef = useRef(false);
  const fallbackTimerRef = useRef(null);
  const startTimeRef = useRef(0);

  // ── Hold-to-talk: listen for tray-dictate (start) and tray-dictate-stop (release) ──
  useEffect(() => {
    let unlistenStart, unlistenStop;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenStart = await listen('tray-dictate', () => {
          if (state === 'idle' || state === 'done' || state === 'error') {
            startRecording();
          }
        });
        unlistenStop = await listen('tray-dictate-stop', () => {
          if (state === 'recording') {
            stopRecording();
          }
        });
      } catch { /* not in Tauri */ }
    })();
    return () => {
      if (unlistenStart) unlistenStart();
      if (unlistenStop) unlistenStop();
    };
  }, [state]);

  // Keyboard fallback: ⌘+Shift+Space toggles in web mode
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

  // Timer while recording
  useEffect(() => {
    if (state === 'recording') {
      const t0 = Date.now();
      timerRef.current = setInterval(() => setDuration(Date.now() - t0), 100);
      return () => clearInterval(timerRef.current);
    }
    clearInterval(timerRef.current);
  }, [state]);

  // Apply transcription result → auto-paste → auto-dismiss
  const applyResult = useCallback(async (data) => {
    setTranscript(data.text || '');
    setLastEngine(data.engine || '');
    setLastTime(data.transcription_time_s || 0);
    setState('done');

    if (data.text) {
      addTranscription(data);
    }

    if (data.text) {
      try {
        await navigator.clipboard.writeText(data.text);
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('simulate_paste');
        } catch { /* not in Tauri */ }
      } catch { /* clipboard API may fail */ }

      // Auto-dismiss after 1.5s
      setTimeout(async () => {
        setState('idle');
        setTranscript('');
        setDuration(0);
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().hide();
        } catch { /* not in Tauri */ }
        if (onDismiss) onDismiss();
      }, 1500);
    } else {
      // No speech — auto-dismiss after 2.5s
      setTimeout(async () => {
        setState('idle');
        setTranscript('');
        setDuration(0);
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().hide();
        } catch { /* not in Tauri */ }
        if (onDismiss) onDismiss();
      }, 2500);
    }
  }, [onDismiss]);

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

      // Open WebSocket BEFORE starting recorder
      try {
        const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsHost = API_BASE.replace(/^https?:\/\//, '').replace(/\/$/, '')
          || `${window.location.hostname}:3900`;
        const wsUrl = `${wsProto}://${wsHost}/ws/transcribe`;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
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
              if (fallbackTimerRef.current) {
                clearTimeout(fallbackTimerRef.current);
                fallbackTimerRef.current = null;
              }
              try { ws.close(); } catch {}
              wsRef.current = null;
              if (!wsHadFinalRef.current) sendForTranscription();
            }
          } catch {}
        };
        ws.onerror = () => { wsRef.current = null; };
        ws.onclose = () => {
          wsRef.current = null;
          if (
            !wsHadFinalRef.current
            && mediaRecorderRef.current
            && mediaRecorderRef.current.state === 'inactive'
          ) {
            if (fallbackTimerRef.current) {
              clearTimeout(fallbackTimerRef.current);
              fallbackTimerRef.current = null;
            }
            sendForTranscription();
          }
        };
        wsRef.current = ws;
      } catch {
        wsRef.current = null;
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          e.data.arrayBuffer().then(buf => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(buf);
            } else {
              wsPendingRef.current.push(buf);
            }
          });
        }
      };
      recorder.onstop = () => {};
      recorder.start(250);
      mediaRecorderRef.current = recorder;
      startTimeRef.current = Date.now();
      setTrayRecording(true);
      setState('recording');
      setTranscript('');
      setPartialText('');
      setDuration(0);
    } catch {
      const isMac = navigator.platform?.includes('Mac');
      const isWindows = navigator.platform?.includes('Win');
      const hint = isMac
        ? 'macOS: open System Settings → Privacy & Security → Microphone and enable OmniVoice.'
        : isWindows
        ? 'Windows: open Settings → Privacy & security → Microphone and allow OmniVoice.'
        : 'Linux: check that your user is in the audio group and the WebView has mic access.';
      toast.error(`Microphone access denied. ${hint}`, { duration: 6000 });
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
    // Signal EOF to WebSocket
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      const sendEof = () => { try { ws.send('EOF'); } catch {} };
      if (ws.readyState === WebSocket.OPEN) {
        sendEof();
      } else {
        ws.addEventListener('open', sendEof, { once: true });
      }
      // Fallback timer
      const recorded = startTimeRef.current ? Date.now() - startTimeRef.current : 0;
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
      if (wsHadFinalRef.current) return;
      await applyResult(data);
    } catch (err) {
      if (wsHadFinalRef.current) return;
      toast.error(`Transcription failed: ${err.message}`);
      setState('error');
      setTranscript('');
    }
  }, [captureMode, applyResult]);

  const dismiss = async () => {
    setState('idle');
    setTranscript('');
    setDuration(0);
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    } catch { /* not in Tauri */ }
    if (onDismiss) onDismiss();
  };

  // ── Pill label ──
  let label = '';
  let emoji = '';
  if (state === 'recording') {
    emoji = '🎙️';
    label = partialText || 'Listening…';
  } else if (state === 'transcribing') {
    emoji = '📝';
    label = partialText || 'Transcribing…';
  } else if (state === 'done' && transcript) {
    emoji = '✅';
    label = 'Pasted';
  } else if (state === 'done' && !transcript) {
    emoji = '⚠️';
    label = 'No speech detected';
  } else if (state === 'error') {
    emoji = '❌';
    label = 'Mic access denied';
  } else {
    emoji = '🎙️';
    label = 'Ready — hold shortcut to speak';
  }

  return (
    <div className={`capture-pill capture-pill--${state}`} role="status" aria-live="polite">
      {/* Pulsing status dot */}
      <span className="capture-pill__dot" />

      {/* Content */}
      <div className="capture-pill__content">
        <span className="capture-pill__label">
          {emoji} {label}
        </span>
      </div>

      {/* Timer */}
      {(state === 'recording' || state === 'transcribing') && (
        <span className="capture-pill__timer">
          {formatElapsed(duration)}
        </span>
      )}

      {/* Transcribing spinner */}
      {state === 'transcribing' && (
        <Loader size={14} className="capture-pill__spinner" />
      )}

      {/* Dismiss — only on done/error */}
      {(state === 'done' || state === 'error') && (
        <button className="capture-pill__dismiss" onClick={dismiss} aria-label="Dismiss">
          <X size={12} />
        </button>
      )}
    </div>
  );
}
