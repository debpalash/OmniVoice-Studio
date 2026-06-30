import React, { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '../utils/copyText';
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
  } catch {
    /* not in Tauri */
  }
}

const LS_CAPTURE_MODE = 'omni_capture_mode';

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

// Best-effort live paste of a committed utterance into whatever app has focus.
// Reuses the same native clipboard+⌘V/Ctrl+V path as the session final, so each
// silence-endpoint utterance lands in the target field as the user pauses —
// that's what makes streaming dictation feel live (text appears as you speak,
// committing on pauses) rather than only at the very end.
async function pasteSegment(text) {
  if (!text) return;
  try {
    await copyText(text);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('simulate_paste', { text });
    } catch {
      /* not in Tauri — WebView clipboard copy above already ran */
    }
  } catch {
    /* clipboard unavailable */
  }
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
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('simulate_type', { text, backspaces });
    return true;
  } catch {
    return false; // not in Tauri, or simulate_type errored (e.g. no a11y grant)
  }
}

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
  const [captureMode] = useState(() => localStorage.getItem(LS_CAPTURE_MODE) || 'fast');
  const [, setLastEngine] = useState('');
  const [, setLastTime] = useState(0);
  const [partialText, setPartialText] = useState('');

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
  // '' each time an utterance is committed. `liveTypingRef` latches off if a
  // simulate_type call fails so the rest of the session uses the paste fallback
  // instead of typing-then-also-pasting (which would double-insert).
  const typedRef = useRef('');
  const liveTypingRef = useRef(true);
  // Set after an utterance commits: the next utterance's first typed delta is
  // prefixed with a single separating space (so we don't trail a space after the
  // final utterance, and words across utterances don't run together).
  const pendingSepRef = useRef(false);
  // Serialise simulate_type calls: partials can arrive faster than the OS input
  // queue drains; chaining on this promise keeps backspaces/types strictly
  // ordered so a late delta can't interleave and corrupt the field.
  const typeChainRef = useRef(Promise.resolve());

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
  const aecStopRef = useRef(null); // async teardown of the mic worklet graph
  const farEndUnsubRef = useRef(null); // unsubscribe from the far-end bus

  const teardownAec = useCallback(async () => {
    try {
      farEndUnsubRef.current?.();
    } catch {
      /* ignore */
    }
    farEndUnsubRef.current = null;
    const stop = aecStopRef.current;
    aecStopRef.current = null;
    try {
      await stop?.();
    } catch {
      /* ignore */
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

  // ── Tray hotkey: tray-dictate (start) + tray-dictate-stop (release) ──
  // Toggle mode: tray-dictate flips start↔stop, tray-dictate-stop is ignored
  //   (Tauri only emits tray-dictate-stop on key *release* in hold registration;
  //   in toggle registration the backend emits tray-dictate on each press).
  // Hold mode: tray-dictate starts, tray-dictate-stop stops.
  // Both branches are gated on `enabled` so a disabled toggle makes the hotkey
  // inert. Behaviour is identical on macOS / Windows / Linux.
  useEffect(() => {
    let unlistenStart, unlistenStop;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenStart = await listen('tray-dictate', () => {
          if (!enabledRef.current) return;
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
      } catch {
        /* not in Tauri */
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

  // Apply transcription result → auto-paste → auto-dismiss
  const applyResult = useCallback(
    async (data) => {
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
          } catch {
            /* not in Tauri */
          }
        } catch {
          /* clipboard API may fail */
        }

        // Auto-dismiss after 1.5s
        setTimeout(async () => {
          setState('idle');
          setTranscript('');
          setDuration(0);
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().hide();
          } catch {
            /* not in Tauri */
          }
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
          } catch {
            /* not in Tauri */
          }
          if (onDismiss) onDismiss();
        }, 2500);
      }
    },
    [onDismiss],
  );

  // Finalise a sherpa LIVE-streaming session. The per-utterance finals were
  // already pasted into the focused field as the user paused, so this does NOT
  // re-paste — it shows the authoritative full transcript in the pill, records
  // it in history, and auto-dismisses. The EOF-summary `final` (or an early
  // socket close) drives this.
  const finalizeSession = useCallback(
    async (data) => {
      const fullText = data.refined_text || data.text || '';
      setTranscript(fullText);
      setLastEngine(data.engine || 'sherpa-onnx-asr');
      setLastTime(data.transcription_time_s || 0);
      setState('done');
      // NB: history was already recorded per-utterance as each `final` was pasted
      // live (see the message handler), so finalisation does NOT re-record — that
      // would duplicate the session. It only resolves the pill + auto-dismisses.
      setPartialText('');
      committedRef.current = [];
      const delay = fullText ? 1500 : 2500;
      setTimeout(async () => {
        setState('idle');
        setTranscript('');
        setDuration(0);
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().hide();
        } catch {
          /* not in Tauri */
        }
        if (onDismiss) onDismiss();
      }, delay);
    },
    [onDismiss],
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
      typedRef.current = '';
      liveTypingRef.current = true;
      pendingSepRef.current = false;
      typeChainRef.current = Promise.resolve();
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
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
            } catch {}
          }
          wsPendingRef.current = [];
        };
        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.type === 'partial') {
              // Live interim text — show the running transcript so far plus the
              // in-flight partial, so the pill reads as continuous speech.
              const committed = committedRef.current.join(' ');
              const live = [committed, msg.text || ''].filter(Boolean).join(' ');
              setPartialText(live);
              // …and type the revised in-flight utterance into the focused field
              // word-by-word (the native-dictation experience). The diff handles
              // recognizer self-corrections via backspaces; committed utterances
              // are untouched. Only sherpa live partials drive typing — the
              // legacy WebM path has no partials.
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
                const segText = msg.refined_text || msg.text || '';
                const cls = classifySherpaFinal(segText, committedRef.current);
                if (cls === 'summary' || cls === 'terminator') {
                  // Authoritative EOF (summary text already pasted live, or an
                  // empty no-speech terminator) → finalise so the pill resolves.
                  wsHadFinalRef.current = true;
                  if (fallbackTimerRef.current) {
                    clearTimeout(fallbackTimerRef.current);
                    fallbackTimerRef.current = null;
                  }
                  finalizeSession(msg);
                  try {
                    ws.close();
                  } catch {}
                } else if (cls === 'utterance') {
                  // A per-utterance commit. Reconcile the focused field to the
                  // recognizer's AUTHORITATIVE final for this utterance (it can
                  // differ from the last partial — e.g. final punctuation / a
                  // late self-correction), then FREEZE it: reset typedRef so the
                  // next utterance's partials diff from empty. We never backspace
                  // across this boundary. If live typing is unavailable, fall
                  // back to pasting the segment — never do both (no double-insert).
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
                    pasteSegment(segText);
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
                try {
                  ws.close();
                } catch {}
              }
            } else if (msg.type === 'error') {
              if (fallbackTimerRef.current) {
                clearTimeout(fallbackTimerRef.current);
                fallbackTimerRef.current = null;
              }
              try {
                ws.close();
              } catch {}
              wsRef.current = null;
              if (!wsHadFinalRef.current) sendForTranscription();
            }
          } catch {}
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
      } catch {
        wsRef.current = null;
      }

      if (pcmMode) {
        // Raw-PCM path: stream int16 mono frames at 16 kHz via the AudioWorklet
        // (no MediaRecorder, no WebM POST fallback — the WS is the only channel).
        //   • sherpa live engine → UNTAGGED int16 frames (the non-AEC sherpa
        //     handler reads plain PCM); the far-end bus is NOT subscribed.
        //   • AEC on → frames are 1-byte tagged (0x00 mic / 0x01 far-end) and the
        //     audio player's output is subscribed as the echo reference.
        const [{ startMicCapture }, { frameFromFloat, floatToInt16, AEC_NEAR, AEC_FAR }] =
          await Promise.all([import('../utils/aec/micCapture'), import('../utils/aec/pcm')]);
        const sendBuf = (buf) => {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(buf);
            } catch {
              /* ignore */
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
          aecStopRef.current = await startMicCapture(stream, (f) => sendTagged(f, AEC_NEAR), {
            sampleRate: 16000,
          });
          farEndUnsubRef.current = subscribeFarEnd((f) => sendTagged(f, AEC_FAR));
        } else {
          // Untagged int16 frames for the plain sherpa live path. Send the
          // Int16Array's underlying buffer verbatim (little-endian on every
          // target platform = numpy's native int16 read on the server).
          aecStopRef.current = await startMicCapture(
            stream,
            (f) => {
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
  }, [applyResult, finalizeSession, t]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    // Any raw-PCM mode (AEC and/or sherpa live): stop the mic worklet + far-end
    // subscription before EOF so no stray frames arrive after the end-of-stream
    // signal. teardownAec no-ops the far-end unsub when there isn't one.
    if (aecModeRef.current || sherpaModeRef.current) {
      teardownAec();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    // Signal EOF to WebSocket
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      const sendEof = () => {
        try {
          ws.send('EOF');
        } catch {}
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
          try {
            wsRef.current?.close();
          } catch {}
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
      setState('error');
      setTranscript('');
    }
  }, [captureMode, applyResult]);

  const dismiss = async () => {
    if (aecModeRef.current || sherpaModeRef.current) teardownAec();
    setState('idle');
    setTranscript('');
    setDuration(0);
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    } catch {
      /* not in Tauri */
    }
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
      <div className="min-w-0 flex-1 overflow-hidden">
        <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium tracking-[0.01em]">
          {emoji} {label}
        </span>
      </div>

      {/* Timer */}
      {(state === 'recording' || state === 'transcribing') && (
        <span className="shrink-0 font-mono text-[11px] font-medium tracking-[0.03em] text-white/50">
          {formatElapsed(duration)}
        </span>
      )}

      {/* Transcribing spinner */}
      {state === 'transcribing' && (
        <Loader size={14} className="shrink-0 text-white/40 motion-safe:animate-spin" />
      )}

      {/* Dismiss — only on done/error */}
      {(state === 'done' || state === 'error') && (
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
