import React, { useEffect, useRef, useState } from 'react';
import { X, CheckCircle, AlertCircle } from 'lucide-react';
import { useAppStore } from '../store';
import './FloatingPill.css';

/**
 * FloatingPill — always-on-top status indicator for long-running operations.
 *
 * Inspired by VoiceBox 0.5.0's CapturePill. Walks through a state machine
 * (loading-model → transcribing → translating → generating → done) with a
 * live elapsed timer, mini progress bar, and dismiss button.
 *
 * Reads entirely from the pillSlice in the Zustand store — any part of the
 * app can trigger it via `useAppStore.getState().showPill(...)`.
 */

function formatElapsed(ms) {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  if (mins > 0) return `${mins}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}

const STAGE_LABELS = {
  'loading-model': '🧠',
  'recording':     '🎙️',
  'transcribing':  '📝',
  'translating':   '🌐',
  'generating':    '🔊',
  'exporting':     '📦',
  'refining':      '✨',
  'done':          '✅',
  'error':         '❌',
};

export default function FloatingPill() {
  const visible    = useAppStore(s => s.visible);
  const stage      = useAppStore(s => s.stage);
  const label      = useAppStore(s => s.label);
  const progress   = useAppStore(s => s.progress);
  const startedAt  = useAppStore(s => s.startedAt);
  const error      = useAppStore(s => s.error);
  const cancellable = useAppStore(s => s.cancellable);
  const dismissPill = useAppStore(s => s.dismissPill);

  const [elapsed, setElapsed] = useState(0);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef(null);

  // Elapsed timer
  useEffect(() => {
    if (!startedAt || stage === 'done' || stage === 'error' || stage === 'idle') {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => clearInterval(timerRef.current);
  }, [startedAt, stage]);

  // Handle dismiss with exit animation
  const handleDismiss = () => {
    setExiting(true);
    setTimeout(() => {
      setExiting(false);
      dismissPill();
    }, 250);
  };

  if (!visible) return null;

  const stageEmoji = STAGE_LABELS[stage] || '⏳';
  const isDone = stage === 'done';
  const isError = stage === 'error';
  const isActive = !isDone && !isError && stage !== 'idle';

  return (
    <div
      className={[
        'floating-pill',
        exiting ? 'floating-pill--exiting' : '',
        isDone ? 'floating-pill--done' : '',
        isError ? 'floating-pill--error' : '',
      ].filter(Boolean).join(' ')}
      role="status"
      aria-live="polite"
    >
      {/* Stage indicator dot */}
      <span className={`floating-pill__dot floating-pill__dot--${stage}`} />

      {/* Content */}
      <div className="floating-pill__content">
        <span className="floating-pill__label">
          {stageEmoji} {label}
        </span>

        {/* Meta row: timer + progress text */}
        <div className="floating-pill__meta">
          {isActive && elapsed > 0 && (
            <span className="floating-pill__timer">{formatElapsed(elapsed)}</span>
          )}
          {progress !== null && isActive && (
            <span>{Math.round(progress)}%</span>
          )}
          {isError && error && (
            <span className="floating-pill__error" title={error}>{error}</span>
          )}
        </div>

        {/* Mini progress bar */}
        {isActive && (
          <div className="floating-pill__progress">
            <div
              className={[
                'floating-pill__progress-fill',
                progress === null ? 'floating-pill__progress-fill--indeterminate' : '',
              ].filter(Boolean).join(' ')}
              style={progress !== null ? { width: `${progress}%` } : undefined}
            />
          </div>
        )}
      </div>

      {/* Dismiss / cancel button */}
      <button
        className="floating-pill__dismiss"
        onClick={handleDismiss}
        title={cancellable ? 'Cancel' : 'Dismiss'}
        aria-label={cancellable ? 'Cancel operation' : 'Dismiss status'}
      >
        <X size={12} />
      </button>
    </div>
  );
}
