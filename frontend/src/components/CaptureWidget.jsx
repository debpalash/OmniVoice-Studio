import React, { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '../utils/copyText';
import { X, Loader } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../store';
import { useTranslation } from 'react-i18next';

import { wsUrl as buildWsUrl, apiFetch } from '../api/client';
import { addTranscription } from '../pages/Transcriptions';
import { micErrorMessage } from '../utils/micError';
import { createWaveform } from './captureWaveform';

// True inside the Tauri shell (desktop app / widget window); false in the
// browser webui / Docker, where the native commands don't exist. Gating on
// this keeps "not in Tauri" out of the error paths entirely — a failure that
// happens INSIDE Tauri is real and must surface, never be swallowed.
function inTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Flip the system tray icon between default and red-dot.
async function setTrayRecording(recording) {
  if (!inTauri()) return; // browser webui / Docker — no tray
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_tray_recording', { recording });
  } catch (err) {
    // Cosmetic only (the tray dot) — a pill error would outrank the failure.
    console.warn('set_tray_recording failed:', err);
  }
}

// Hide the standalone widget window (no-op in the browser webui).
async function hideWidgetWindow() {
  if (!inTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().hide();
  } catch (err) {
    console.warn('widget hide failed:', err);
  }
}

// macOS Accessibility probe (AXIsProcessTrusted via the shell). Resolves true
// on Windows/Linux and outside Tauri — there is nothing to grant there.
async function checkAccessibility() {
  if (!inTauri()) return true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke('check_accessibility')) !== false;
  } catch (err) {
    // Older shell without the command — don't block dictation on the probe.
    console.warn('check_accessibility failed:', err);
    return true;
  }
}

// Open the OS pane where the user grants Accessibility (macOS
// Privacy_Accessibility; no-op elsewhere — the shell command handles the OS
// switch).
async function openA11ySettings() {
  if (!inTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_accessibility_settings');
  } catch (err) {
    console.warn('open_accessibility_settings failed:', err);
  }
}

const LS_CAPTURE_MODE = 'omni_capture_mode';
// Live retract-retype (word-by-word typing with visible backspace corrections
// in the target app) is OPT-IN: default dictation only inserts committed
// finals. Set '1' to re-enable the live mode.
const LS_LIVE_TYPING = 'omni_capture_live_typing';

// How many waveform bars the pill draws while recording.
const WAVE_BARS = 12;

// A dictation model id is a sherpa-onnx live model when it carries the
// `sherpa-` prefix the backend assigns (see services/sherpa_dictation.py). Only
// then do we open the low-latency raw-PCM streaming path; anything else (or no
// selection) falls through to the legacy MediaRecorder/WebM path unchanged.
export function isSherpaModel(id) {
  return typeof id === 'string' && id.startsWith('sherpa-');
}

/**
 * Classify a sherpa `final` message against the utterances committed so far.
 * Pure + exported for unit testing the live-streaming state machine.
 *   • 'summary'    — the authoritative EOF summary (text === the committed
 *                    join): finalise, don't re-paste.
 *   • 'utterance'  — a new per-utterance commit: paste it live + append.
 *   • 'terminator' — an empty no-speech EOF final with nothing committed:
 *                    finalise (resolve the pill).
 *   • 'ignore'     — empty final but utterances exist (covered by the summary).
 */
export function classifySherpaFinal(segText, committed) {
  const text = (segText || '').trim();
  const joined = (committed || []).join(' ').trim();
  if (text && text === joined && joined !== '') return 'summary';
  if (!text) return committed && committed.length ? 'ignore' : 'terminator';
  return 'utterance';
}

/**
 * Compute the keystroke delta to turn `prevTyped` (what we've already typed into
 * the focused field for the in-flight utterance) into `nextText` (the recognizer's
 * latest revision of that same utterance). Pure + exported for unit testing.
 *
 * Streaming recognizers don't only append — they REVISE earlier words ("recognise"
 * → "recognize", "to" → "two"). So we find the longest common prefix, retract
 * everything after it with backspaces, then type the corrected suffix. The common
 * case (pure append) yields `backspaces: 0` and just the new tail.
 *
 *   computeTypeDelta('hello wor', 'hello world') → { backspaces: 0, text: 'ld' }
 *   computeTypeDelta('hello to', 'hello two')    → { backspaces: 1, text: 'wo' }
 *   computeTypeDelta('hello', 'hello')           → { backspaces: 0, text: '' }  (noop)
 *
 * Returns `{ backspaces, text }`; `noop` is true when both are empty.
 */
export function computeTypeDelta(prevTyped, nextText) {
  const prev = prevTyped || '';
  const next = nextText || '';
  // Longest common prefix (by UTF-16 code unit — enigo types code points but the
  // backspace count we send is per-character; spread to count code points so an
  // astral char like an emoji retracts/types as one unit on every platform).
  const prevChars = Array.from(prev);
  const nextChars = Array.from(next);
  let i = 0;
  const max = Math.min(prevChars.length, nextChars.length);
  while (i < max && prevChars[i] === nextChars[i]) i++;
  const backspaces = prevChars.length - i;
  const text = nextChars.slice(i).join('');
  return { backspaces, text, noop: backspaces === 0 && text === '' };
}

/**
 * Map a failed `simulate_paste`/`simulate_type` invoke into an actionable
 * `{ kind, message }`. The Rust command prefixes its Err strings with the
 * failing layer — "a11y:" (macOS Accessibility not granted; the pill offers
 * open_accessibility_settings), "clipboard:" (couldn't write/restore the user
 * clipboard) or "paste:" (the synthetic ⌘V/Ctrl+V itself failed). Pure +
 * exported for unit testing.
 */
export function parsePasteError(err) {
  const raw = typeof err === 'string' ? err : (err && err.message) || String(err ?? '');
  for (const kind of ['a11y', 'clipboard', 'paste']) {
    if (raw.startsWith(`${kind}:`)) return { kind, message: raw.slice(kind.length + 1).trim() };
  }
  return { kind: 'paste', message: raw };
}

// Deliver a transcript to the user: best-effort WebView clipboard copy (works
// in browser mode; in Tauri the unfocused widget window can't always reach the
// WebView clipboard — #287) then, inside Tauri, the native simulate_paste
// (which saves the user clipboard, writes + sends ⌘V/Ctrl+V, then restores).
// Returns { ok: true, kind: 'pasted' | 'copied' } or { ok: false, error }.
// The caller renders the TRUE outcome — "Pasted" is never shown unless the
// invoke actually resolved Ok.
async function deliverText(text) {
  let copyErr = null;
  try {
    await copyText(text);
  } catch (err) {
    // Only fatal when there is no native path below to write it instead.
    copyErr = err;
  }
  if (!inTauri()) {
    if (copyErr) {
      return {
        ok: false,
        error: { kind: 'clipboard', message: String(copyErr?.message || copyErr) },
      };
    }
    return { ok: true, kind: 'copied' };
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('simulate_paste', { text });
    return { ok: true, kind: 'pasted' };
  } catch (err) {
    return { ok: false, error: parsePasteError(err) };
  }
}

// Live paste of a committed utterance into whatever app has focus. Same
// clipboard+⌘V/Ctrl+V path as the session final, so each silence-endpoint
// utterance lands in the target field as the user pauses — that's what makes
// streaming dictation feel live. Returns the deliverText outcome so the
// session can surface a failed segment instead of pretending it landed.
async function pasteSegment(text) {
  if (!text) return { ok: true, kind: 'noop' };
  return deliverText(text);
}

// Live, word-by-word typing of the in-flight utterance into whatever app has
// focus — the native-dictation experience (words appear AS you speak, not only
// on pauses). Given the delta vs what we last typed, it backspaces any revised
// tail then types the corrected suffix via the `simulate_type` Tauri command
// (one round trip). Returns true on success, false if the input layer was
// unavailable (not in Tauri, or accessibility not granted) so the caller can
// fall back to the paste path for that segment without double-inserting.
async function typeDelta({ backspaces, text }) {
  if (!backspaces && !text) return true;
  if (!inTauri()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('simulate_type', { text, backspaces });
    return true;
  } catch (err) {
    // Caller latches live typing off and pastes instead — the failure is not
    // silent (a failing paste then raises the pill's error state).
    console.warn('simulate_type failed:', err);
    return false;
  }
}

function formatElapsed(ms) {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  if (mins > 0) return `${mins}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}

// Localized headline for the pill's error state.
function errorLabel(t, info) {
  switch (info?.kind) {
    case 'a11y':
      return t('capture.a11y_error');
    case 'clipboard':
      return t('capture.clipboard_error');
    case 'paste':
      return t('capture.paste_error');
    case 'mic':
      return t('capture.mic_denied');
    default:
      return t('capture.transcription_failed', { message: info?.message || '' });
  }
}

/**
 * CaptureWidget — floating pill for dictation.
 *
 * Minimal status-only UI: live waveform (or status dot) + label + timer.
 * All interaction via global hotkey (hold-to-talk); Esc cancels anywhere.
 * Records → transcribes → auto-pastes → auto-dismisses — and every state the
 * pill shows is TRUE: "Pasted" only after simulate_paste resolved Ok, model
 * download/load progress straight from the backend's status frames, and an
 * actionable setup state when macOS Accessibility hasn't been granted yet.
 */
export default function CaptureWidget({ onDismiss }) {
  const { t } = useTranslation();
  const [state, setState] = useState('idle'); // idle | setup | recording | transcribing | done | error
  const [transcript, setTranscript] = useState('');
  const [duration, setDuration] = useState(0);
  const [captureMode] = useState(() => localStorage.getItem(LS_CAPTURE_MODE) || 'fast');
  const [, setLastEngine] = useState('');
  const [, setLastTime] = useState(0);
  const [partialText, setPartialText] = useState('');
  // How the finished transcript actually reached the user: 'pasted' (native
  // simulate_paste Ok) or 'copied' (clipboard only — browser mode). Drives the
  // done label so the pill never claims a paste that didn't happen.
  const [doneKind, setDoneKind] = useState(null);
  // { kind, message } for the error state (mic / a11y / clipboard / paste /
  // transcription / server). The a11y kind renders the Open-Settings action.
  const [errorInfo, setErrorInfo] = useState(null);
  // Backend model lifecycle ({type:"status"} WS frames): null when ready, else
  // { stage: 'downloading' | 'loading', progress: 0..1 | null }.
  const [modelStatus, setModelStatus] = useState(null);
  // Live waveform bars (0..1 heights). Only fed on the raw-PCM paths where the
  // micCapture AudioWorklet already emits frames — no second audio pipeline.
  const [bars, setBars] = useState(() => Array.from({ length: WAVE_BARS }, () => 0));
  const [waveOn, setWaveOn] = useState(false);

  // Live-dictation prefs (mirrored from the backend dictation.* namespace).
  // `mode` switches the hotkey start/stop semantics; `modelId` selects the
  // sherpa-onnx live engine; `enabled` gates the hotkey entirely.
  const dictationEnabled = useAppStore((s) => s.dictationEnabled);
  const dictationMode = useAppStore((s) => s.dictationMode);
  const loadDictationPrefs = useAppStore((s) => s.loadDictationPrefs);
  // Mode/enabled are also read through refs inside event listeners so the
  // long-lived tray/keyboard handlers always see the current value without
  // re-subscribing on every pref change.
  const modeRef = useRef(dictationMode);
  const enabledRef = useRef(dictationEnabled);
  useEffect(() => {
    modeRef.current = dictationMode;
  }, [dictationMode]);
  useEffect(() => {
    enabledRef.current = dictationEnabled;
  }, [dictationEnabled]);

  // Sherpa live-streaming session refs. `sherpaModeRef` flips on at start when a
  // sherpa model is selected; `committedRef` accumulates per-utterance finals so
  // the pill can show the running transcript and the EOF summary can reconcile.
  const sherpaModeRef = useRef(false);
  const committedRef = useRef([]);
  // Live-typing state. `typedRef` is the exact text we have typed into the
  // focused field for the CURRENT in-flight utterance (committed utterances are
  // left alone — we never backspace across an utterance boundary). It resets to
  // '' each time an utterance is committed. `liveTypingRef` is seeded from the
  // LS_LIVE_TYPING pref at session start (default OFF — commit-only insert, no
  // visible backspace storms) and latches off if a simulate_type call fails so
  // the rest of the session uses the paste fallback instead of typing-then-
  // also-pasting (which would double-insert).
  const typedRef = useRef('');
  const liveTypingRef = useRef(false);
  // Set after an utterance commits: the next utterance's first typed delta is
  // prefixed with a single separating space (so we don't trail a space after the
  // final utterance, and words across utterances don't run together).
  const pendingSepRef = useRef(false);
  // Serialise simulate_type calls: partials can arrive faster than the OS input
  // queue drains; chaining on this promise keeps backspaces/types strictly
  // ordered so a late delta can't interleave and corrupt the field.
  const typeChainRef = useRef(Promise.resolve());
  // Serialise per-utterance paste deliveries the same way, so finalise can
  // AWAIT them — the offline-model socket close races the last paste, and the
  // pill must not claim "Pasted" while an invoke is still in flight.
  const pasteChainRef = useRef(Promise.resolve());
  // First delivery failure of a live session (per-utterance paste). Checked at
  // finalise so the pill reports the truth instead of a green "Pasted".
  const segmentErrorRef = useRef(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const wsRef = useRef(null);
  const wsPendingRef = useRef([]);
  const wsHadFinalRef = useRef(false);
  const fallbackTimerRef = useRef(null);
  const dismissTimerRef = useRef(null);
  const startTimeRef = useRef(0);
  // Waveform ring buffer (pure module) — fed by the worklet frame callbacks.
  const waveRef = useRef(null);
  if (!waveRef.current) waveRef.current = createWaveform();
  // The Accessibility setup pill is shown at most once per widget lifetime.
  const a11ySetupSeenRef = useRef(false);
  // Opt-in dictate-over-playback AEC (parity Action 8). When on, we capture
  // raw PCM via an AudioWorklet and tag mic/far-end frames instead of using
  // MediaRecorder. All AEC state lives in refs so the default path is inert.
  const aecModeRef = useRef(false);
  const aecStopRef = useRef(null); // async teardown of the mic worklet graph
  const farEndUnsubRef = useRef(null); // unsubscribe from the far-end bus

  const teardownAec = useCallback(async () => {
    try {
      farEndUnsubRef.current?.();
    } catch (err) {
      console.warn('far-end unsubscribe failed:', err);
    }
    farEndUnsubRef.current = null;
    const stop = aecStopRef.current;
    aecStopRef.current = null;
    try {
      await stop?.();
    } catch (err) {
      console.warn('mic worklet teardown failed:', err);
    }
    aecModeRef.current = false;
  }, []);

  // Hydrate dictation prefs (enabled / mode / model) from the backend once. The
  // widget runs in its own Tauri webview (a separate JS context from the main
  // window), so it loads the prefs itself rather than relying on the Settings
  // window having loaded them.
  useEffect(() => {
    loadDictationPrefs();
  }, [loadDictationPrefs]);

  // First-run truthfulness: without the macOS Accessibility grant neither
  // simulate_paste nor simulate_type can deliver a single character — so probe
  // up front and show a one-time setup pill instead of pretending to work.
  // (Resolves true on Windows/Linux and outside Tauri.)
  useEffect(() => {
    let stale = false;
    (async () => {
      const ok = await checkAccessibility();
      if (!stale && !ok && !a11ySetupSeenRef.current) {
        a11ySetupSeenRef.current = true;
        setState((s) => (s === 'idle' ? 'setup' : s));
      }
    })();
    return () => {
      stale = true;
    };
  }, []);

  // ── Tray hotkey: tray-dictate (start) + tray-dictate-stop (release) ──
  // Toggle mode: tray-dictate flips start↔stop, tray-dictate-stop is ignored
  //   (Tauri only emits tray-dictate-stop on key *release* in hold registration;
  //   in toggle registration the backend emits tray-dictate on each press).
  // Hold mode: tray-dictate starts, tray-dictate-stop stops.
  // Both branches are gated on `enabled` so a disabled toggle makes the hotkey
  // inert. Behaviour is identical on macOS / Windows / Linux.
  useEffect(() => {
    if (!inTauri()) return; // browser webui — the keyboard fallback below runs
    let unlistenStart, unlistenStop;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenStart = await listen('tray-dictate', () => {
          if (!enabledRef.current) return;
          if (state === 'setup') {
            // Re-probe on each press — the user may have just granted access
            // in System Settings; if so, flow straight into recording.
            checkAccessibility().then((ok) => {
              if (ok) startRecording();
            });
            return;
          }
          const idle = state === 'idle' || state === 'done' || state === 'error';
          if (modeRef.current === 'toggle') {
            // Press once to start, again to stop.
            if (idle) startRecording();
            else if (state === 'recording') stopRecording();
          } else if (idle) {
            // Hold mode: keydown → start.
            startRecording();
          }
        });
        unlistenStop = await listen('tray-dictate-stop', () => {
          // Only hold mode acts on release; toggle ignores it.
          if (modeRef.current === 'hold' && state === 'recording') {
            stopRecording();
          }
        });
      } catch (err) {
        // Hotkey wiring failed inside Tauri — dictation still works via the
        // in-page shortcut, but say so in the console for bug reports.
        console.warn('tray-dictate listen failed:', err);
      }
    })();
    return () => {
      if (unlistenStart) unlistenStart();
      if (unlistenStop) unlistenStop();
    };
  }, [state]);

  // Keyboard fallback (web UI / Docker — no global tray hotkey). Mirrors the
  // tray semantics so the DEFAULT dictation behaviour is identical with or
  // without Tauri: Toggle = keydown flips start↔stop; Hold = keydown starts,
  // keyup stops. The Ctrl/Cmd+Shift+Space combo matches the documented default
  // shortcut; the desktop app's user-rebindable accelerator is a Tauri concern.
  useEffect(() => {
    const isCombo = (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'Space';
    const onKeyDown = (e) => {
      if (!isCombo(e)) return;
      e.preventDefault();
      if (!enabledRef.current) return;
      if (state === 'setup') {
        checkAccessibility().then((ok) => {
          if (ok) startRecording();
        });
        return;
      }
      const idle = state === 'idle' || state === 'done' || state === 'error';
      if (modeRef.current === 'toggle') {
        if (idle) startRecording();
        else if (state === 'recording') stopRecording();
      } else if (idle) {
        // Hold mode: holding the combo records; auto-repeat keydowns are
        // ignored because we only start from an idle state.
        startRecording();
      }
    };
    const onKeyUp = (e) => {
      // Hold mode stops as soon as Space (or a modifier) is released.
      if (modeRef.current !== 'hold') return;
      if (e.code !== 'Space' && e.key !== 'Meta' && e.key !== 'Control' && e.key !== 'Shift')
        return;
      if (state === 'recording') stopRecording();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
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

  // Waveform poll: 50 ms ≈ 2–3 worklet frames, so bars visibly move well
  // within ~100 ms of mic start. Only runs while the worklet is feeding us.
  useEffect(() => {
    if (state !== 'recording' || !waveOn) return;
    const id = setInterval(() => setBars(waveRef.current.getBars(WAVE_BARS)), 50);
    return () => clearInterval(id);
  }, [state, waveOn]);

  // Reset the pill to hidden-idle and hide the widget window. Every dismissal
  // (X button, Esc, auto-dismiss) funnels through here.
  const dismiss = useCallback(async () => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    if (aecModeRef.current || sherpaModeRef.current) teardownAec();
    setState('idle');
    setTranscript('');
    setPartialText('');
    setDuration(0);
    setModelStatus(null);
    setErrorInfo(null);
    setDoneKind(null);
    await hideWidgetWindow();
    if (onDismiss) onDismiss();
  }, [teardownAec, onDismiss]);

  // Auto-dismiss after a beat, tracked in a ref so Esc or a fresh session can
  // cancel it (a stale timer must never hide a newly-started recording).
  const scheduleDismiss = useCallback(
    (delay) => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null;
        dismiss();
      }, delay);
    },
    [dismiss],
  );

  // Stop every capture input (recorder / worklet / tracks) without touching
  // the pill state — shared by stop, cancel and the WS error path.
  const stopCaptureGraph = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (aecModeRef.current || sherpaModeRef.current) {
      teardownAec();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [teardownAec]);

  // Esc = abort. Stops capture, discards the audio and any in-flight result
  // (nothing is pasted), closes the socket and hides the pill.
  const cancelSession = useCallback(() => {
    wsHadFinalRef.current = true; // any late final/fallback result is discarded
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) ws.close();
    stopCaptureGraph();
    committedRef.current = [];
    typeChainRef.current = Promise.resolve();
    pasteChainRef.current = Promise.resolve();
    setTrayRecording(false);
    dismiss();
  }, [stopCaptureGraph, dismiss]);

  // Esc cancels in EVERY state (window-level, so it works wherever focus sits
  // inside the widget): recording/transcribing → abort + discard; done/error/
  // setup → dismiss.
  useEffect(() => {
    if (state === 'idle') return;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (state === 'recording' || state === 'transcribing') cancelSession();
      else dismiss();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [state, cancelSession, dismiss]);

  // Apply transcription result → deliver (paste/copy) → show the TRUE outcome
  // → auto-dismiss on success. A failed delivery is an error state (with the
  // Accessibility action when that's the fix), never a fake "Pasted".
  const applyResult = useCallback(
    async (data) => {
      // Wave 2.1: the backend may attach an LLM-refined version of the final
      // text (filler words removed, self-corrections applied). Paste/show the
      // refined text when present; the raw text is kept in history alongside.
      const finalText = data.refined_text || data.text || '';
      setTranscript(finalText);
      setLastEngine(data.engine || '');
      setLastTime(data.transcription_time_s || 0);
      setModelStatus(null);

      if (data.text) {
        addTranscription(data);
      }

      if (!finalText) {
        // No speech — brief notice, then auto-dismiss.
        setDoneKind(null);
        setState('done');
        scheduleDismiss(2500);
        return;
      }

      const res = await deliverText(finalText);
      if (res.ok) {
        setDoneKind(res.kind);
        setState('done');
        scheduleDismiss(1500);
      } else {
        // The transcript did NOT land. deliverText copied it to the clipboard
        // first when it could, but the pill must say what failed — and stay
        // up until the user acts (no auto-dismiss on errors).
        setErrorInfo(res.error);
        setState('error');
      }
    },
    [scheduleDismiss],
  );

  // Finalise a sherpa LIVE-streaming session. The per-utterance finals were
  // already delivered into the focused field as the user paused, so this does
  // NOT re-paste — it shows the authoritative full transcript in the pill,
  // reports any segment that failed to land, and auto-dismisses on success.
  // The EOF-summary `final` (or an early socket close) drives this.
  const finalizeSession = useCallback(
    async (data) => {
      // Wait for in-flight per-utterance deliveries first — the outcome the
      // pill reports must be the settled one, not a hopeful guess.
      await Promise.all([pasteChainRef.current, typeChainRef.current]);
      const fullText = data.refined_text || data.text || '';
      setTranscript(fullText);
      setLastEngine(data.engine || 'sherpa-onnx-asr');
      setLastTime(data.transcription_time_s || 0);
      setModelStatus(null);
      // NB: history was already recorded per-utterance as each `final` was
      // delivered live (see the message handler), so finalisation does NOT
      // re-record — that would duplicate the session.
      setPartialText('');
      committedRef.current = [];
      if (segmentErrorRef.current && fullText) {
        // At least one utterance never reached the target app — the truthful
        // outcome is an error (with the a11y action when relevant).
        setErrorInfo(segmentErrorRef.current);
        setState('error');
        return;
      }
      setDoneKind(fullText ? (inTauri() ? 'pasted' : 'copied') : null);
      setState('done');
      scheduleDismiss(fullText ? 1500 : 2500);
    },
    [scheduleDismiss],
  );

  // Type the recognizer's latest revision of the in-flight utterance into the
  // focused field, reconciling against what we typed before via a prefix diff.
  // Serialised on `typeChainRef` so concurrent partials can't interleave. If the
  // delta typing fails (no Tauri / no a11y grant), latch live-typing off and let
  // the per-utterance paste fallback carry the text instead — never both.
  const liveType = useCallback((nextText) => {
    if (!liveTypingRef.current) return typeChainRef.current;
    const run = async () => {
      if (!liveTypingRef.current) return;
      // Prefix the first delta of a new (non-first) utterance with a separator,
      // tracked inside typedRef so the diff stays self-consistent.
      let target = nextText || '';
      if (pendingSepRef.current && target !== '') {
        target = ' ' + target;
        pendingSepRef.current = false;
      }
      const delta = computeTypeDelta(typedRef.current, target);
      if (delta.noop) return;
      const ok = await typeDelta(delta);
      if (ok) {
        typedRef.current = target;
      } else {
        // Input layer unavailable — stop typing for the rest of the session so
        // we don't half-type. The paste path (pasteSegment on finals) takes over.
        liveTypingRef.current = false;
      }
    };
    typeChainRef.current = typeChainRef.current.then(run, run);
    return typeChainRef.current;
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
      streamRef.current = stream;
      chunksRef.current = [];
      wsPendingRef.current = [];
      wsHadFinalRef.current = false;
      committedRef.current = [];
      segmentErrorRef.current = null;
      typedRef.current = '';
      // Live retract-retype is OPT-IN (visible backspace storms in the target
      // app unnerved users): default sessions insert only committed finals via
      // the paste path; the pref re-enables word-by-word typing.
      liveTypingRef.current = localStorage.getItem(LS_LIVE_TYPING) === '1';
      pendingSepRef.current = false;
      typeChainRef.current = Promise.resolve();
      pasteChainRef.current = Promise.resolve();
      waveRef.current.reset();
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      // Read prefs at start time (avoids stale closures). AEC is opt-in; the
      // sherpa live engine is selected when the persisted dictation model is a
      // sherpa-onnx model — that path streams raw int16 PCM and emits live
      // partials + a `final` per spoken utterance (committed on silence).
      const aecOn = useAppStore.getState().aecEnabled === true;
      const modelId = useAppStore.getState().dictationModelId;
      const sherpaOn = isSherpaModel(modelId);
      aecModeRef.current = aecOn;
      sherpaModeRef.current = sherpaOn;
      // Raw-PCM transport is used whenever AEC or the sherpa live engine is on.
      const pcmMode = aecOn || sherpaOn;

      // Open WebSocket BEFORE starting capture.
      try {
        // Scheme + host + remote api key all derive from the API base
        // (Wave 2.3) — window.location lies inside the Tauri webview.
        //   • sherpa → ?model=<id>&sr=16000  (raw int16 PCM, live partials)
        //   • AEC    → ?aec=1&sr=16000       (tagged raw PCM, NLMS canceller)
        //   • both   → ?model=<id>&aec=1&sr=16000
        //   • neither → /ws/transcribe       (legacy MediaRecorder/WebM)
        const params = [];
        if (sherpaOn) params.push(`model=${encodeURIComponent(modelId)}`);
        if (aecOn) params.push('aec=1');
        if (pcmMode) params.push('sr=16000');
        const wsPath = params.length ? `/ws/transcribe?${params.join('&')}` : '/ws/transcribe';
        const ws = new WebSocket(buildWsUrl(wsPath));
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          for (const buf of wsPendingRef.current) {
            try {
              ws.send(buf);
            } catch (err) {
              // Socket died mid-flush — onclose/onerror handles recovery.
              console.warn('ws flush failed:', err);
              break;
            }
          }
          wsPendingRef.current = [];
        };
        ws.onmessage = (evt) => {
          let msg;
          try {
            msg = JSON.parse(evt.data);
          } catch (err) {
            console.warn('unparseable /ws/transcribe frame:', err);
            return;
          }
          if (msg.type === 'status') {
            // Model lifecycle truthfulness: while the backend fetches/loads
            // the ASR model it streams {stage:"downloading",progress} /
            // {stage:"loading"} / {stage:"ready"} so the pill can say what is
            // actually happening instead of a generic "Listening…".
            setModelStatus(
              msg.stage === 'ready'
                ? null
                : {
                    stage: msg.stage,
                    progress: typeof msg.progress === 'number' ? msg.progress : null,
                  },
            );
          } else if (msg.type === 'partial') {
            // Live interim text — show the running transcript so far plus the
            // in-flight partial, so the pill reads as continuous speech.
            const committed = committedRef.current.join(' ');
            const live = [committed, msg.text || ''].filter(Boolean).join(' ');
            setPartialText(live);
            // …and (opt-in) type the revised in-flight utterance into the
            // focused field word-by-word. The diff handles recognizer
            // self-corrections via backspaces; committed utterances are
            // untouched. Only sherpa live partials drive typing — the legacy
            // WebM path has no partials — and liveType no-ops unless the
            // LS_LIVE_TYPING pref opted in.
            if (sherpaModeRef.current) liveType(msg.text || '');
          } else if (msg.type === 'final') {
            if (sherpaModeRef.current) {
              // Two sherpa `final` shapes:
              //   • STREAMING models emit a `final` per spoken utterance (on
              //     each silence endpoint) THEN a session-summary `final` on
              //     EOF whose text is the join of every utterance.
              //   • OFFLINE models (incl. the default Parakeet v3) emit live
              //     partials then exactly ONE `final` (the whole transcript)
              //     on EOF.
              // Rule: a `final` whose text equals what we've already committed
              // is the authoritative EOF SUMMARY → finalise without re-pasting
              // (its pieces already landed live). Any other `final` is a NEW
              // utterance → paste it live and append. The single offline final
              // is "new" (nothing committed yet) so it pastes once; the socket
              // close then finalises from the committed text.
              // Classify on the RAW text: the EOF summary's `text` is exactly
              // the join of the committed utterances, but its optional LLM
              // `refined_text` is not — classifying on the refined string
              // would misread the summary as a new utterance and re-paste the
              // whole transcript (double insert). Delivery still prefers the
              // refined text where one applies (the single offline final).
              const segText = msg.refined_text || msg.text || '';
              const cls = classifySherpaFinal(msg.text || '', committedRef.current);
              if (cls === 'summary' || cls === 'terminator') {
                // Authoritative EOF (summary text already pasted live, or an
                // empty no-speech terminator) → finalise so the pill resolves.
                wsHadFinalRef.current = true;
                if (fallbackTimerRef.current) {
                  clearTimeout(fallbackTimerRef.current);
                  fallbackTimerRef.current = null;
                }
                finalizeSession(msg);
                ws.close();
              } else if (cls === 'utterance') {
                // A per-utterance commit. Reconcile the focused field to the
                // recognizer's AUTHORITATIVE final for this utterance (it can
                // differ from the last partial — e.g. final punctuation / a
                // late self-correction), then FREEZE it: reset typedRef so the
                // next utterance's partials diff from empty. We never backspace
                // across this boundary. In the default (live typing off) the
                // committed final is pasted instead — never both (no
                // double-insert) — and a failed paste is recorded so the
                // session resolves truthfully.
                committedRef.current.push(segText);
                setPartialText(committedRef.current.join(' '));
                if (msg.text) addTranscription(msg);
                if (liveTypingRef.current) {
                  liveType(segText);
                  typeChainRef.current = typeChainRef.current.then(() => {
                    typedRef.current = '';
                    // Seed the next utterance's typed-state with a separating
                    // space (matching the ' '.join used by the pill/history) so
                    // its first delta types " word" — words never run together,
                    // and there is no trailing space after the LAST utterance.
                    pendingSepRef.current = true;
                  });
                } else {
                  pasteChainRef.current = pasteChainRef.current
                    .then(() => pasteSegment(segText))
                    .then((res) => {
                      if (!res.ok && !segmentErrorRef.current) {
                        segmentErrorRef.current = res.error;
                      }
                    });
                }
              }
            } else {
              // Legacy single-final path (Whisper/WebM) — unchanged.
              wsHadFinalRef.current = true;
              if (fallbackTimerRef.current) {
                clearTimeout(fallbackTimerRef.current);
                fallbackTimerRef.current = null;
              }
              applyResult(msg);
              ws.close();
            }
          } else if (msg.type === 'error') {
            if (fallbackTimerRef.current) {
              clearTimeout(fallbackTimerRef.current);
              fallbackTimerRef.current = null;
            }
            ws.close();
            wsRef.current = null;
            if (sherpaModeRef.current || aecModeRef.current) {
              // Raw-PCM paths have no WebM blob to re-POST — surface the
              // backend's error instead of leaving the pill wedged in
              // "Transcribing…" forever.
              wsHadFinalRef.current = true;
              stopCaptureGraph();
              setTrayRecording(false);
              setModelStatus(null);
              setErrorInfo({ kind: msg.kind || 'server', message: msg.message || '' });
              setState('error');
            } else if (!wsHadFinalRef.current) {
              sendForTranscription();
            }
          }
        };
        ws.onerror = () => {
          wsRef.current = null;
        };
        ws.onclose = () => {
          wsRef.current = null;
          if (sherpaModeRef.current) {
            // Sherpa: nothing to POST (no WebM blob). If the socket dropped
            // before the EOF summary but we committed utterances live, close out
            // the session from what we have so the pill resolves.
            if (!wsHadFinalRef.current && committedRef.current.length) {
              wsHadFinalRef.current = true;
              finalizeSession({ text: committedRef.current.join(' '), engine: 'sherpa-onnx-asr' });
            }
            return;
          }
          if (
            !wsHadFinalRef.current &&
            mediaRecorderRef.current &&
            mediaRecorderRef.current.state === 'inactive'
          ) {
            if (fallbackTimerRef.current) {
              clearTimeout(fallbackTimerRef.current);
              fallbackTimerRef.current = null;
            }
            sendForTranscription();
          }
        };
        wsRef.current = ws;
      } catch (err) {
        wsRef.current = null;
        if (pcmMode) {
          // Raw-PCM has no POST fallback — a socket that can't even be
          // constructed is fatal to the session, so say so instead of
          // recording into the void.
          stream.getTracks().forEach((tr) => tr.stop());
          streamRef.current = null;
          setErrorInfo({ kind: 'server', message: String(err?.message || err) });
          setState('error');
          return;
        }
        // Legacy path continues below: the recorder still buffers chunks and
        // the POST /transcribe fallback delivers the result on stop.
        console.warn('ws open failed — will fall back to POST /transcribe:', err);
      }

      if (pcmMode) {
        // Raw-PCM path: stream int16 mono frames at 16 kHz via the AudioWorklet
        // (no MediaRecorder, no WebM POST fallback — the WS is the only channel).
        //   • sherpa live engine → UNTAGGED int16 frames (the non-AEC sherpa
        //     handler reads plain PCM); the far-end bus is NOT subscribed.
        //   • AEC on → frames are 1-byte tagged (0x00 mic / 0x01 far-end) and the
        //     audio player's output is subscribed as the echo reference.
        // Every mic frame also feeds the waveform ring buffer — the pill's
        // bars are computed client-side from the SAME worklet frames (no
        // second audio pipeline).
        const [{ startMicCapture }, { frameFromFloat, floatToInt16, AEC_NEAR, AEC_FAR }] =
          await Promise.all([import('../utils/aec/micCapture'), import('../utils/aec/pcm')]);
        const sendBuf = (buf) => {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(buf);
            } catch (err) {
              // Socket is going down — onclose finalises/recovers the session.
              console.warn('ws send failed:', err);
            }
          } else {
            wsPendingRef.current.push(buf);
          }
        };
        if (aecOn) {
          // Tagged frames + far-end reference (echo cancellation). Works for the
          // sherpa+AEC combo too — the backend demuxes the tag before the
          // sherpa handler sees the cleaned near-end PCM.
          const { subscribeFarEnd } = await import('../utils/aec/farEndBus');
          const sendTagged = (float32, kind) => sendBuf(frameFromFloat(float32, kind));
          aecStopRef.current = await startMicCapture(
            stream,
            (f) => {
              waveRef.current.push(f);
              sendTagged(f, AEC_NEAR);
            },
            { sampleRate: 16000 },
          );
          farEndUnsubRef.current = subscribeFarEnd((f) => sendTagged(f, AEC_FAR));
        } else {
          // Untagged int16 frames for the plain sherpa live path. Send the
          // Int16Array's underlying buffer verbatim (little-endian on every
          // target platform = numpy's native int16 read on the server).
          aecStopRef.current = await startMicCapture(
            stream,
            (f) => {
              waveRef.current.push(f);
              const i16 = floatToInt16(f);
              sendBuf(i16.buffer.slice(i16.byteOffset, i16.byteOffset + i16.byteLength));
            },
            { sampleRate: 16000 },
          );
        }
        mediaRecorderRef.current = null;
      } else {
        const recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunksRef.current.push(e.data);
            e.data.arrayBuffer().then((buf) => {
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
      setWaveOn(pcmMode);
      setBars(Array.from({ length: WAVE_BARS }, () => 0));
      setState('recording');
      setTranscript('');
      setPartialText('');
      setModelStatus(null);
      setErrorInfo(null);
      setDoneKind(null);
      setDuration(0);
    } catch (err) {
      // Distinguish "permission denied" (→ per-OS settings hint) from
      // "no device" / "device busy" / anything else (#323).
      toast.error(micErrorMessage(t, err), { duration: 6000 });
      setTrayRecording(false);
      setErrorInfo({ kind: 'mic', message: String(err?.message || err) });
      setState('error');
    }
  }, [applyResult, finalizeSession, liveType, stopCaptureGraph, t]);

  const stopRecording = useCallback(() => {
    stopCaptureGraph();
    // Signal EOF to WebSocket
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      const sendEof = () => {
        try {
          ws.send('EOF');
        } catch (err) {
          // Socket died before EOF — the fallback timer / onclose recovers.
          console.warn('ws EOF send failed:', err);
        }
      };
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
          wsRef.current?.close();
          wsRef.current = null;
          sendForTranscription();
        }
      }, ms);
    }
    setTrayRecording(false);
    setState('transcribing');
  }, [stopCaptureGraph]);

  const sendForTranscription = useCallback(async () => {
    if (wsHadFinalRef.current) return;
    // No WebM blob exists on any raw-PCM path (AEC or sherpa live) — the WS is
    // the only result channel there.
    if (aecModeRef.current || sherpaModeRef.current) return;

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
      setErrorInfo({ kind: 'transcription', message: err.message });
      setState('error');
      setTranscript('');
    }
  }, [captureMode, applyResult, t]);

  // Idle: render nothing — pill is hold-to-talk only (Whisper-Flow / Ghost-Pepper
  // style). The tray-dictate listener above stays mounted, so the shortcut still
  // triggers startRecording() which flips state out of 'idle' and remounts the
  // pill DOM with the slide-in animation.
  if (state === 'idle') return null;

  // ── Pill label ──
  let label = '';
  let emoji = '';
  if (state === 'setup') {
    // One-time Accessibility setup — shown instead of pretending to work.
    emoji = '🔒';
    label = t('capture.a11y_setup');
  } else if (modelStatus && (state === 'recording' || state === 'transcribing')) {
    // Backend model lifecycle beats the generic listening/transcribing labels.
    emoji = modelStatus.stage === 'downloading' ? '⏬' : '⏳';
    label =
      modelStatus.stage === 'downloading'
        ? modelStatus.progress != null
          ? t('capture.model_downloading_pct', {
              percent: Math.round(modelStatus.progress * 100),
            })
          : t('capture.model_downloading')
        : t('capture.model_loading');
  } else if (state === 'recording') {
    emoji = '🎙️';
    label = partialText || t('capture.listening_label');
  } else if (state === 'transcribing') {
    emoji = '📝';
    label = partialText || t('capture.transcribing_label');
  } else if (state === 'done' && transcript) {
    emoji = '✅';
    label = doneKind === 'copied' ? t('capture.copied') : t('capture.pasted');
  } else if (state === 'done' && !transcript) {
    emoji = '⚠️';
    label = t('capture.no_speech');
  } else if (state === 'error') {
    emoji = '❌';
    label = errorLabel(t, errorInfo);
  }

  const showA11yAction = state === 'setup' || (state === 'error' && errorInfo?.kind === 'a11y');

  return (
    <div className={`capture-pill capture-pill--${state}`} role="status" aria-live="polite">
      {/* Live waveform while the worklet feeds us; pulsing dot otherwise */}
      {state === 'recording' && waveOn && !modelStatus ? (
        <div className="capture-pill__wave" aria-hidden="true">
          {bars.map((v, i) => (
            <span
              key={i}
              className="capture-pill__wave-bar"
              style={{ height: `${Math.round(12 + v * 88)}%` }}
            />
          ))}
        </div>
      ) : (
        <span className="capture-pill__dot" />
      )}

      {/* Content */}
      <div className="min-w-0 flex-1 overflow-hidden">
        <span
          className="block overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium tracking-[0.01em]"
          title={state === 'error' ? errorInfo?.message || undefined : undefined}
        >
          {emoji} {label}
        </span>
      </div>

      {/* Timer */}
      {(state === 'recording' || state === 'transcribing') && !modelStatus && (
        <span className="shrink-0 font-mono text-[11px] font-medium tracking-[0.03em] text-white/50">
          {formatElapsed(duration)}
        </span>
      )}

      {/* Spinner while transcribing or while the model downloads/loads */}
      {(state === 'transcribing' || (state === 'recording' && modelStatus)) && (
        <Loader size={14} className="shrink-0 text-white/40 motion-safe:animate-spin" />
      )}

      {/* Accessibility action — setup state and a11y-kind paste errors */}
      {showA11yAction && (
        <button
          className="shrink-0 cursor-pointer whitespace-nowrap rounded-full border-0 bg-white/[0.1] px-2.5 py-1 text-[11px] font-medium text-white/90 transition-[background] duration-[0.15s] hover:bg-white/[0.18]"
          onClick={openA11ySettings}
        >
          {t('capture.open_a11y_settings')}
        </button>
      )}

      {/* Dismiss — done/error/setup */}
      {(state === 'done' || state === 'error' || state === 'setup') && (
        <button
          className="flex h-[20px] w-[20px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-white/[0.06] p-0 text-white/40 transition-[background,color] duration-[0.15s] hover:bg-white/[0.12] hover:text-white/80"
          onClick={dismiss}
          aria-label={t('common.dismiss')}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
