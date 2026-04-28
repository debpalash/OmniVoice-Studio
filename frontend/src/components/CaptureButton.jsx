import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Clipboard, X, Loader, ChevronDown } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../store';
import './CaptureButton.css';

import { API as API_BASE } from '../api/client';
import { addTranscription } from '../pages/Transcriptions';

const WHISPER_MODELS = [
  { id: 'tiny',     label: 'Tiny',     desc: 'Fastest · lowest accuracy',    icon: '⚡' },
  { id: 'base',     label: 'Base',     desc: 'Fast · basic accuracy',         icon: '🔵' },
  { id: 'small',    label: 'Small',    desc: 'Balanced speed & quality',      icon: '🟢' },
  { id: 'medium',   label: 'Medium',   desc: 'Good accuracy · slower',        icon: '🟡' },
  { id: 'large-v3', label: 'Large V3', desc: 'Best accuracy · slowest',       icon: '🔴' },
];

const LS_WHISPER_MODEL = 'omni_whisper_model';

/**
 * CaptureButton — global dictation / voice capture widget.
 *
 * Inspired by VoiceBox's Capture mode:
 *   1. Press the button (or ⌘+Shift+Space)
 *   2. Speak into the mic
 *   3. Press again to stop
 *   4. Audio is sent to /transcribe → text appears
 *   5. Click "Copy" to paste into any app
 *
 * The widget floats in the bottom-right corner, expanding when recording.
 */
export default function CaptureButton() {
  const [state, setState] = useState('idle'); // idle | recording | transcribing | done | error
  const [transcript, setTranscript] = useState('');
  const [duration, setDuration] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [whisperModel, setWhisperModel] = useState(() =>
    localStorage.getItem(LS_WHISPER_MODEL) || 'small'
  );
  const [showModelPicker, setShowModelPicker] = useState(false);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);

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

  // Timer while recording
  useEffect(() => {
    if (state === 'recording') {
      const t0 = Date.now();
      timerRef.current = setInterval(() => setDuration(Date.now() - t0), 100);
      return () => clearInterval(timerRef.current);
    }
    clearInterval(timerRef.current);
  }, [state]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
      });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => sendForTranscription();
      mediaRecorderRef.current = recorder;
      recorder.start(250); // collect in 250ms chunks

      setState('recording');
      setDuration(0);
      setTranscript('');
      setExpanded(true);
    } catch (err) {
      toast.error('Microphone access denied. Check browser permissions.');
      setState('error');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setState('transcribing');
  }, []);

  const sendForTranscription = useCallback(async () => {
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('audio', blob, 'capture.webm');
    formData.append('model', whisperModel);

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
      setTranscript(data.text || '');
      setState('done');
      // Persist to Transcriptions page history
      if (data.text) {
        addTranscription(data);
      }
    } catch (err) {
      toast.error(`Transcription failed: ${err.message}`);
      setState('error');
      setTranscript('');
    }
  }, []);

  const copyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(transcript).then(() => {
      toast.success('Copied to clipboard');
    });
  }, [transcript]);

  const dismiss = () => {
    setState('idle');
    setTranscript('');
    setExpanded(false);
    setDuration(0);
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
            <button className="capture-panel__close" onClick={dismiss} title="Close">
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
              <button className="capture-panel__copy" onClick={copyToClipboard}>
                <Clipboard size={12} /> Copy
              </button>
            </div>
          )}

          {state === 'done' && !transcript && (
            <div className="capture-panel__empty">
              No speech detected. Try again.
            </div>
          )}

          {/* Model selector */}
          <div className="capture-panel__model-row">
            <div className="capture-panel__model-picker" style={{ position: 'relative' }}>
              <button
                className="capture-panel__model-btn"
                onClick={() => setShowModelPicker(p => !p)}
                title="Whisper model quality"
              >
                {WHISPER_MODELS.find(m => m.id === whisperModel)?.icon || '🟢'}{' '}
                {WHISPER_MODELS.find(m => m.id === whisperModel)?.label || 'Small'}
                <ChevronDown size={10} />
              </button>
              {showModelPicker && (
                <div className="capture-panel__model-dropdown">
                  {WHISPER_MODELS.map(m => (
                    <button
                      key={m.id}
                      className={`capture-panel__model-option ${whisperModel === m.id ? 'is-active' : ''}`}
                      onClick={() => {
                        setWhisperModel(m.id);
                        localStorage.setItem(LS_WHISPER_MODEL, m.id);
                        setShowModelPicker(false);
                      }}
                    >
                      <span className="capture-panel__model-icon">{m.icon}</span>
                      <span className="capture-panel__model-label">{m.label}</span>
                      <span className="capture-panel__model-desc">{m.desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
