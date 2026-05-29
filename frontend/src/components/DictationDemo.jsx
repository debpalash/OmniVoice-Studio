/**
 * DictationDemo — guided walkthrough for the real-time dictation feature.
 *
 * What this surfaces:
 *   1. Active hotkey display (read from the dictation_shortcut Tauri command).
 *   2. Three script cards — short utterances the user can read aloud OR
 *      replay from a bundled WAV. The replay path posts the bundled audio
 *      to POST /transcribe and renders the recognized text below the card
 *      so dictation can be demoed even when the user hasn't granted mic
 *      permission yet, or is on a headless / VM / CI box.
 *   3. Hotkey verification status — subscribes to the `tray-dictate` and
 *      `tray-dictate-stop` Tauri events so we can show "verified" the
 *      moment the user presses the shortcut for the first time.
 *
 * Cross-platform: the replay path uses the existing backend transcribe
 * endpoint and works identically on macOS / Windows / Linux. The hotkey
 * verification path requires Tauri (gracefully no-ops in the web UI).
 *
 * Where this is mounted:
 *   - Settings → Capture & Dictation (above HotkeyTab) — always available
 *   - SetupWizard step 4 — first-run onboarding
 */
import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Keyboard, Mic, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { API } from '../api/client';
import { Button } from '../ui';
import './DictationDemo.css';

const SCRIPTS = [
  {
    id: 'en_conversational',
    label: 'Conversational',
    language: 'English',
    text: 'Schedule a meeting with Pat for Tuesday at three PM and remind me to bring the quarterly report.',
    wav: '/demo_audio/dictation/en_conversational.wav',
  },
  {
    id: 'en_technical',
    label: 'Technical vocabulary',
    language: 'English',
    text: 'Patch the WebGPU shader in renderer.tsx, then bump pnpm to nine point fifteen and rerun the Vitest suite.',
    wav: '/demo_audio/dictation/en_technical.wav',
  },
  {
    id: 'fr_reservation',
    label: 'Non-English (French)',
    language: 'French',
    text: 'Bonjour, je voudrais réserver une table pour deux personnes à vingt heures.',
    wav: '/demo_audio/dictation/fr_reservation.wav',
  },
];

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export default function DictationDemo({ embedded = false }) {
  const { t } = useTranslation();
  const [shortcut, setShortcut] = useState('');
  const [hotkeyState, setHotkeyState] = useState('unknown'); // unknown | registered | verified
  const [playingId, setPlayingId] = useState(null);
  const [transcripts, setTranscripts] = useState({}); // {scriptId: {state, text, error}}
  // null = probing, true/false once the demo assets are confirmed present.
  // The sample WAVs are rendered by scripts/build_demos.sh and may be absent
  // (e.g. source checkout without a render step). When absent we hide the demo
  // rather than show cards that fail on click (#119/#124 follow-up).
  const [assetsAvailable, setAssetsAvailable] = useState(null);
  const audioRef = useRef(null);

  // Probe whether the bundled dictation samples actually exist; hide the whole
  // demo if not, mirroring DubbingDemo's missing-manifest behavior.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}${SCRIPTS[0].wav}`, { method: 'HEAD' })
      .then((r) => { if (!cancelled) setAssetsAvailable(r.ok); })
      .catch(() => { if (!cancelled) setAssetsAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  // Read the registered hotkey on mount.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const v = await invoke('get_dictation_shortcut');
        if (!cancelled) {
          setShortcut(v || '');
          setHotkeyState(v ? 'registered' : 'unknown');
        }
      } catch {
        if (!cancelled) setHotkeyState('unknown');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Subscribe to dictation events: the moment the user presses their
  // hotkey while this panel is mounted, flip to verified.
  useEffect(() => {
    if (!isTauri()) return;
    let unlistenStart, unlistenStop;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenStart = await listen('tray-dictate', () => {
          setHotkeyState('verified');
        });
        unlistenStop = await listen('tray-dictate-stop', () => {
          setHotkeyState('verified');
        });
      } catch {
        // Tauri event API unavailable — leave state alone.
      }
    })();
    return () => {
      try { unlistenStart && unlistenStart(); } catch { /* noop */ }
      try { unlistenStop && unlistenStop(); } catch { /* noop */ }
    };
  }, []);

  const togglePlay = (script) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === script.id) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    audio.src = `${API}${script.wav}`;
    audio.currentTime = 0;
    audio.play()
      .then(() => setPlayingId(script.id))
      .catch((e) => {
        console.warn('Sample playback failed:', e);
        setPlayingId(null);
      });
  };

  // Replay path: fetch the bundled WAV, post it to the transcribe endpoint,
  // render what the engine heard. Demonstrates the full dictation pipeline
  // without requiring mic permission or a hotkey press.
  const replay = async (script) => {
    setTranscripts((prev) => ({
      ...prev,
      [script.id]: { state: 'loading', text: '', error: '' },
    }));
    try {
      const wavRes = await fetch(`${API}${script.wav}`);
      if (!wavRes.ok) throw new Error(`Could not fetch sample: ${wavRes.status}`);
      const blob = await wavRes.blob();
      const fd = new FormData();
      fd.append('audio', blob, `${script.id}.wav`);
      const tRes = await fetch(`${API}/transcribe`, { method: 'POST', body: fd });
      if (!tRes.ok) {
        const errBody = await tRes.text().catch(() => '');
        throw new Error(`Transcribe failed (${tRes.status}): ${errBody.slice(0, 120)}`);
      }
      const json = await tRes.json();
      setTranscripts((prev) => ({
        ...prev,
        [script.id]: { state: 'ok', text: json.text || '', error: '' },
      }));
    } catch (e) {
      setTranscripts((prev) => ({
        ...prev,
        [script.id]: { state: 'fail', text: '', error: e?.message || String(e) },
      }));
    }
  };

  const statusBadge = (() => {
    switch (hotkeyState) {
      case 'verified':
        return (
          <span className="dictation-demo__status dictation-demo__status--ok">
            <CheckCircle2 size={12} /> {t('demo.dictation_status_ok')}
          </span>
        );
      case 'registered':
        return (
          <span className="dictation-demo__status dictation-demo__status--pending">
            <Keyboard size={12} /> {t('demo.dictation_status_pending')} <code>{shortcut}</code>
          </span>
        );
      default:
        return (
          <span className="dictation-demo__status dictation-demo__status--warn">
            <AlertTriangle size={12} /> {t('demo.dictation_status_warn')}
          </span>
        );
    }
  })();

  // No bundled samples on disk → don't render a demo that can't work.
  if (assetsAvailable === false) return null;

  return (
    <section className={`dictation-demo ${embedded ? 'dictation-demo--embedded' : ''}`}>
      <header className="dictation-demo__head">
        <h3 className="dictation-demo__title">
          <Mic size={14} /> {t('demo.dictation_title')}
        </h3>
        {statusBadge}
      </header>

      <p className="dictation-demo__lede">{t('demo.dictation_lede')}</p>

      <audio ref={audioRef} onEnded={() => setPlayingId(null)} preload="none" />

      <div className="dictation-demo__scripts">
        {SCRIPTS.map((s) => {
          const isPlaying = playingId === s.id;
          const tx = transcripts[s.id] || {};
          return (
            <div key={s.id} className="dictation-demo__card">
              <div className="dictation-demo__card-head">
                <span className="dictation-demo__lang">{s.language}</span>
                <span className="dictation-demo__card-label">{s.label}</span>
              </div>
              <blockquote className="dictation-demo__script">{s.text}</blockquote>
              <div className="dictation-demo__card-actions">
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => togglePlay(s)}
                  leading={isPlaying ? <Pause size={11} /> : <Play size={11} />}
                  aria-label={isPlaying ? `Pause ${s.label}` : `Hear ${s.label}`}
                >
                  {isPlaying ? t('demo.dictation_stop') : t('demo.dictation_hear')}
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => replay(s)}
                  loading={tx.state === 'loading'}
                  leading={tx.state !== 'loading' && <Mic size={11} />}
                  aria-label={`Replay ${s.label} through transcriber`}
                >
                  {tx.state === 'loading' ? t('demo.dictation_transcribing') : t('demo.dictation_replay')}
                </Button>
              </div>
              {tx.state === 'ok' && (
                <div className="dictation-demo__result dictation-demo__result--ok">
                  <CheckCircle2 size={11} /> <em>{tx.text}</em>
                </div>
              )}
              {tx.state === 'fail' && (
                <div className="dictation-demo__result dictation-demo__result--fail">
                  <AlertTriangle size={11} /> {tx.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
