import { useState } from 'react';
import { UploadCloud, X, ArrowRightLeft, Loader } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Button } from '../../ui';
import { API } from '../../api/client';
import { convertSpeech } from '../../api/convert';
import { asrMissingPayload, toastAsrModelMissing } from '../../utils/asrModelMissing';
import useRecording from '../../hooks/useRecording';
import MicButton from './MicButton';
import VoiceSelector from '../VoiceSelector';
import WaveformPlayer from '../WaveformPlayer';

/**
 * Studio "Convert" method — speech-to-speech voice changer.
 *
 * Drop or record a source clip, pick an existing voice profile, Convert:
 * the backend transcribes the clip with the active ASR engine and re-says
 * it with the active TTS engine in the chosen profile's voice
 * (POST /convert). "Match source duration" (default on) time-stretches the
 * take — pitch preserved — to land near the source clip's length.
 *
 * Self-contained on purpose: unlike the audio/design methods it doesn't use
 * ScriptPanel (the script IS the source clip) or the shared ActionBar, so it
 * owns its source file, target voice, and result state locally.
 */
export default function ConvertMethodPanel({ t, profiles = [] }) {
  const [sourceFile, setSourceFile] = useState(null);
  const [voiceId, setVoiceId] = useState('');
  const [matchDuration, setMatchDuration] = useState(true);
  const [isConverting, setIsConverting] = useState(false);
  const [result, setResult] = useState(null);

  // Own mic instance: a convert source is not the clone reference, so it
  // must never overwrite the audio method's refAudio.
  const { isRecording, isCleaning, recordingTime, startRecording, stopRecording } = useRecording(
    async (file) => {
      setSourceFile(file);
      setResult(null);
    },
  );

  const ingestSource = (file) => {
    if (!file) return;
    setSourceFile(file);
    setResult(null);
  };

  const canConvert = !!sourceFile && !!voiceId && !isConverting;

  const handleConvert = async () => {
    if (!canConvert) return;
    setIsConverting(true);
    setResult(null);
    try {
      const fd = new FormData();
      // Re-wrap the File as a fresh Blob — same Tauri/WebKit quirk workaround
      // as useTTS's ref_audio append (a stale File handle can upload empty).
      const buf = await sourceFile.arrayBuffer();
      fd.append(
        'audio',
        new Blob([buf], { type: sourceFile.type || 'audio/wav' }),
        sourceFile.name || 'source.wav',
      );
      fd.append('profile_id', voiceId);
      fd.append('match_duration', matchDuration ? '1' : '0');
      setResult(await convertSpeech(fd));
    } catch (e) {
      const missing = asrMissingPayload(e);
      if (missing) {
        // Same one-click "Download {model}" CTA every other ASR consumer shows.
        toastAsrModelMissing(missing);
      } else {
        toast.error(e?.message || String(e), { duration: 8000 });
      }
    } finally {
      setIsConverting(false);
    }
  };

  return (
    <div data-testid="convert-method-panel">
      {/* ── Source clip: drop / pick / record ── */}
      <div className="label-row mt-[6px]">{t('convert.source_kicker')}</div>
      <div className="flex gap-[8px] items-stretch">
        <input
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
          onChange={(e) => {
            ingestSource(e.target.files[0]);
            e.target.value = '';
          }}
          className="dub-hidden-file"
          id="convert-audio-upload"
        />
        <label
          htmlFor="convert-audio-upload"
          className="flex-1 [border:1px_dashed_var(--chrome-border-strong)] rounded-[var(--chrome-radius-pill)] p-[6px] text-center cursor-pointer flex flex-col items-center gap-[4px] bg-transparent [transition:border-color_var(--dur-fast),background_var(--dur-fast)] hover:[border-color:var(--chrome-accent)] hover:bg-[var(--chrome-accent-bg)] [&.is-dragging]:[border-color:var(--chrome-accent)] [&.is-dragging]:bg-[var(--chrome-accent-bg)]"
          onDragOver={(e) => {
            e.preventDefault();
            e.currentTarget.classList.add('is-dragging');
          }}
          onDragLeave={(e) => {
            e.currentTarget.classList.remove('is-dragging');
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('is-dragging');
            const file = e.dataTransfer.files[0];
            const okType =
              file &&
              (file.type.startsWith('audio/') ||
                /\.(mp3|wav|m4a|flac|ogg|aac|webm)$/i.test(file.name));
            if (okType) ingestSource(file);
          }}
        >
          <UploadCloud color="#a89984" size={18} />
          <p className="m-0 text-[0.72rem] text-[color:var(--chrome-fg-muted)] font-[family-name:var(--font-sans)] font-medium">
            {sourceFile ? (
              <span className="text-fg">{sourceFile.name}</span>
            ) : (
              t('convert.drop_audio')
            )}
          </p>
        </label>
        <MicButton
          isCleaning={isCleaning}
          isRecording={isRecording}
          recordingTime={recordingTime}
          onStart={startRecording}
          onStop={stopRecording}
        />
      </div>

      {sourceFile && (
        <div className="mt-2 flex items-center gap-[8px]">
          <div className="flex-1 min-w-0">
            <WaveformPlayer src={sourceFile} source="convert-source" height={34} compact />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSourceFile(null);
              setResult(null);
            }}
            leading={<X size={11} />}
          >
            {t('clone.clear')}
          </Button>
        </div>
      )}

      {/* ── Target voice ── */}
      <div className="label-row mt-[var(--space-4)]">{t('convert.target_voice')}</div>
      <VoiceSelector
        value={voiceId}
        onChange={setVoiceId}
        profiles={profiles}
        engineDefault={false}
        gallery={false}
        placeholder={t('convert.pick_voice')}
        ariaLabel={t('convert.target_voice')}
        recentsKey="convert-target"
      />

      {/* ── Options + action ── */}
      <div className="mt-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-4)]">
        <label
          className="inline-flex items-center gap-[6px] text-[0.85em] text-fg-muted cursor-pointer select-none whitespace-nowrap"
          title={t('convert.match_duration_hint')}
        >
          <input
            type="checkbox"
            checked={matchDuration}
            onChange={(e) => setMatchDuration(e.target.checked)}
          />
          <span>{t('convert.match_duration')}</span>
        </label>
        <Button
          variant="primary"
          size="sm"
          onClick={handleConvert}
          disabled={!canConvert}
          leading={
            isConverting ? (
              <Loader size={12} className="animate-[spin_1s_linear_infinite]" />
            ) : (
              <ArrowRightLeft size={12} />
            )
          }
        >
          {isConverting ? t('convert.converting') : t('convert.convert')}
        </Button>
        {!sourceFile || !voiceId ? (
          <span className="text-[0.72rem] text-fg-muted">{t('convert.need_source_and_voice')}</span>
        ) : null}
      </div>

      {/* ── Result: converted take + what the ASR heard ── */}
      {result && (
        <div className="mt-[var(--space-4)]" data-testid="convert-result">
          <div className="label-row">{t('convert.result_kicker')}</div>
          <WaveformPlayer src={`${API}${result.audio_url}`} source="output" height={40} autoPlay />
          <div className="mt-2 text-[0.78rem] text-fg-muted">
            <span className="font-medium">{t('convert.transcript')}:</span> {result.text}
          </div>
        </div>
      )}
    </div>
  );
}
