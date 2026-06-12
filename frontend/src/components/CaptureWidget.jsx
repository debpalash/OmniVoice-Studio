import React, { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from "../utils/copyText";
import { X, Loader } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../store';
import { useTranslation } from 'react-i18next';
import './CaptureWidget.css';

import { wsUrl as buildWsUrl, apiFetch } from '../api/client';
import { addTranscription } from '../pages/Transcriptions';
import { micErrorMessage } from '../utils/micError';

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
  const { t } = useTranslation();
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
  // Opt-in dictate-over-playback AEC (parity Action 8). When on, we capture
  // raw PCM via an AudioWorklet and tag mic/far-end frames instead of using
  // MediaRecorder. All AEC state lives in refs so the default path is inert.
  const aecModeRef = useRef(false);
  const aecStopRef = useRef(null);     // async teardown of the mic worklet graph
  const farEndUnsubRef = useRef(null); // unsubscribe from the far-end bus

  const teardownAec = useCallback(async () => {
    try { farEndUnsubRef.current?.(); } catch { /* ignore */ }
    farEndUnsubRef.current = null;
    const stop = aecStopRef.current;
    aecStopRef.current = null;
    try { await stop?.(); } catch { /* ignore */ }
    aecModeRef.current = false;
  }, []);

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
    // Wave 2.1: the backend may attach an LLM-refined version of the final
    // text (filler words removed, self-corrections applied). Paste/show the
    // refined text when present; the raw text is kept in history alongside.
    const finalText = data.refined_text || data.text || '';
    setTranscript(finalText);
    setLastEngine(data.engine || '');
    setLastTime(data.transcription_time_s || 0);
    setState('done');

    if (data.text) {
      addTranscription(data);
    }

    if (finalText) {
      try {
        // Best-effort WebView copy (works in browser mode). In Tauri the
        // widget window is unfocused on macOS, where WebView clipboard APIs
        // fail silently — so pass the transcript to simulate_paste, which
        // writes the clipboard natively (OS-side) before sending ⌘V (#287).
        await copyText(finalText);
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('simulate_paste', { text: finalText });
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

      // Read the opt-in AEC pref at start time (avoids a stale closure).
      const aecOn = useAppStore.getState().aecEnabled === true;
      aecModeRef.current = aecOn;

      // Open WebSocket BEFORE starting recorder
      try {
        // Scheme + host + remote api key all derive from the API base
        // (Wave 2.3) — window.location lies inside the Tauri webview.
        // AEC mode adds ?aec=1 so the server runs the NLMS canceller and
        // expects tagged raw-PCM frames.
        const wsPath = aecOn ? '/ws/transcribe?aec=1&sr=16000' : '/ws/transcribe';
        const ws = new WebSocket(buildWsUrl(wsPath));
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

      if (aecOn) {
        // AEC path: stream raw PCM. The mic is tagged 0x00; whatever the app
        // is playing (published to the far-end bus by the audio player) is
        // tagged 0x01 so the server can cancel the echo. No MediaRecorder and
        // no WebM POST fallback here — the WS is the only path in this mode.
        const [{ startMicCapture }, { subscribeFarEnd }, { frameFromFloat, AEC_NEAR, AEC_FAR }] =
          await Promise.all([
            import('../utils/aec/micCapture'),
            import('../utils/aec/farEndBus'),
            import('../utils/aec/pcm'),
          ]);
        const sendTagged = (float32, kind) => {
          const buf = frameFromFloat(float32, kind);
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(buf); } catch { /* ignore */ }
          } else {
            wsPendingRef.current.push(buf);
          }
        };
        aecStopRef.current = await startMicCapture(
          stream, (f) => sendTagged(f, AEC_NEAR), { sampleRate: 16000 },
        );
        farEndUnsubRef.current = subscribeFarEnd((f) => sendTagged(f, AEC_FAR));
        mediaRecorderRef.current = null;
      } else {
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
      }
      startTimeRef.current = Date.now();
      setTrayRecording(true);
      setState('recording');
      setTranscript('');
      setPartialText('');
      setDuration(0);
    } catch (err) {
      // Distinguish "permission denied" (→ per-OS settings hint) from
      // "no device" / "device busy" / anything else (#323).
      toast.error(micErrorMessage(t, err), { duration: 6000 });
      setTrayRecording(false);
      setState('error');
    }
  }, [applyResult, t]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    // AEC mode: stop the mic worklet + far-end subscription before EOF so no
    // stray frames arrive after the end-of-stream signal.
    if (aecModeRef.current) {
      teardownAec();
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
  }, [teardownAec]);

  const sendForTranscription = useCallback(async () => {
    if (wsHadFinalRef.current) return;
    // No WebM blob exists on the AEC path — the WS is the only result channel.
    if (aecModeRef.current) return;

    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('audio', blob, 'capture.webm');
    formData.append('mode', captureMode);

    try {
      // apiFetch attaches the PIN / remote API key headers (Wave 2.3)
      // and throws on non-2xx with the server's detail message.
      const res = await apiFetch('/transcribe', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (wsHadFinalRef.current) return;
      await applyResult(data);
    } catch (err) {
      if (wsHadFinalRef.current) return;
      toast.error(t('capture.transcription_failed', { message: err.message }));
      setState('error');
      setTranscript('');
    }
  }, [captureMode, applyResult]);

  const dismiss = async () => {
    if (aecModeRef.current) teardownAec();
    setState('idle');
    setTranscript('');
    setDuration(0);
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    } catch { /* not in Tauri */ }
    if (onDismiss) onDismiss();
  };

  // Idle: render nothing — pill is hold-to-talk only (Whisper-Flow / Ghost-Pepper
  // style). The tray-dictate listener above stays mounted, so the shortcut still
  // triggers startRecording() which flips state out of 'idle' and remounts the
  // pill DOM with the slide-in animation.
  if (state === 'idle') return null;

  // ── Pill label ──
  let label = '';
  let emoji = '';
  if (state === 'recording') {
    emoji = '🎙️';
    label = partialText || t('capture.listening_label');
  } else if (state === 'transcribing') {
    emoji = '📝';
    label = partialText || t('capture.transcribing_label');
  } else if (state === 'done' && transcript) {
    emoji = '✅';
    label = t('capture.pasted');
  } else if (state === 'done' && !transcript) {
    emoji = '⚠️';
    label = t('capture.no_speech');
  } else if (state === 'error') {
    emoji = '❌';
    label = t('capture.mic_denied');
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
        <button className="capture-pill__dismiss" onClick={dismiss} aria-label={t('common.dismiss')}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}
