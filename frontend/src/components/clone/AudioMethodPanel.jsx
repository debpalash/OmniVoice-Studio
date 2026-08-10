import { useSyncExternalStore } from 'react';
import { UploadCloud, X, Save, Dice5 } from 'lucide-react';
import { Button, Input, Select } from '../../ui';
import MicButton from './MicButton';
import WaveformPlayer from '../WaveformPlayer';

const EMPTY_LEVEL_STORE = {
  getSnapshot: () => 0,
  subscribe: () => () => {},
};

export default function AudioMethodPanel({
  t,
  selectedProfile,
  setSelectedProfile,
  profiles,
  ingestRefAudio,
  refAudio,
  isCleaning,
  isRecording,
  recordingTime,
  audioInputs = [],
  selectedAudioInputId = '',
  setSelectedAudioInputId,
  channelMode = 'auto',
  setChannelMode,
  inputLevelStore = EMPTY_LEVEL_STORE,
  startRecording,
  stopRecording,
  refText,
  setRefText,
  instruct,
  setInstruct,
  defineMethod,
  designSeed,
  setDesignSeed,
  keepSeed,
  setKeepSeed,
  showSaveProfile,
  setShowSaveProfile,
  profileName,
  setProfileName,
  handleSaveProfile,
}) {
  const inputLevel = useSyncExternalStore(inputLevelStore.subscribe, inputLevelStore.getSnapshot);
  return (
    <div>
      {/* Saved voices now live in the right-side WorkspaceVoices panel. */}

      {!selectedProfile && (
        <>
          <div className="flex gap-[8px] items-stretch">
            <input
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
              onChange={(e) => {
                const f = e.target.files[0];
                ingestRefAudio(f);
                e.target.value = '';
              }}
              className="dub-hidden-file"
              id="audio-upload"
            />
            <label
              htmlFor="audio-upload"
              // Migrated `.file-drag` + the old `.clone-drop-zone` padding override →
              // utilities (fast shadcn, CloneDesignTab.css deleted). `is-dragging` stays
              // a JS-toggled state marker, matched via the `[&.is-dragging]:` variant.
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
                if (okType) ingestRefAudio(file);
              }}
            >
              <UploadCloud color="#a89984" size={18} />
              <p className="m-0 text-[0.72rem] text-[color:var(--chrome-fg-muted)] font-[family-name:var(--font-sans)] font-medium">
                {refAudio ? (
                  <span className="text-fg">{refAudio.name}</span>
                ) : (
                  t('clone.drop_audio')
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
          <div className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2 max-[520px]:grid-cols-1">
            <label className="min-w-0 text-[length:var(--text-xs)] text-fg-muted">
              <span className="mb-1 block">{t('recording.input_device')}</span>
              <Select
                size="sm"
                className="w-full"
                value={selectedAudioInputId}
                onChange={(event) => setSelectedAudioInputId?.(event.target.value)}
                disabled={isRecording || isCleaning}
              >
                <option value="">{t('recording.default_input')}</option>
                {audioInputs.map((device, index) => (
                  <option key={device.deviceId || `input-${index}`} value={device.deviceId}>
                    {device.label || t('recording.microphone_number', { number: index + 1 })}
                  </option>
                ))}
              </Select>
            </label>
            <label className="min-w-0 text-[length:var(--text-xs)] text-fg-muted">
              <span className="mb-1 block">{t('recording.channels')}</span>
              <Select
                size="sm"
                className="w-full"
                value={channelMode}
                onChange={(event) => setChannelMode?.(event.target.value)}
                disabled={isRecording || isCleaning}
              >
                <option value="auto">{t('recording.channels_auto')}</option>
                <option value="mono">{t('recording.channels_mono')}</option>
                <option value="stereo">{t('recording.channels_stereo')}</option>
              </Select>
            </label>
          </div>
          {isRecording && (
            <div
              className="mt-2 flex items-center gap-2 text-[length:var(--text-xs)]"
              role="status"
              aria-live="polite"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${inputLevel >= 0.025 ? 'bg-success' : 'bg-fg-muted'}`}
                aria-hidden="true"
              />
              <meter
                className="h-2 min-w-0 flex-1 accent-[var(--color-success)]"
                min="0"
                max="1"
                value={inputLevel}
                aria-label={t('recording.input_level')}
              />
              <span className={inputLevel >= 0.025 ? 'text-success' : 'text-fg-muted'}>
                {inputLevel >= 0.025
                  ? t('recording.input_detected')
                  : t('recording.no_input_detected')}
              </span>
            </div>
          )}
        </>
      )}

      {refAudio && !selectedProfile && (
        <WaveformPlayer
          src={refAudio}
          source="clone-reference"
          height={34}
          compact
          className="mt-2"
        />
      )}

      {selectedProfile && (
        <div className="p-[var(--space-4)] bg-[rgba(142,192,124,0.08)] [border:1px_solid_rgba(142,192,124,0.2)] rounded-lg text-[var(--text-md)] mb-[var(--space-4)] flex items-center gap-[var(--space-4)]">
          <span className="text-success flex-1">
            {t('clone.using_profile', {
              name: profiles.find((p) => p.id === selectedProfile)?.name,
            })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedProfile(null)}
            leading={<X size={11} />}
          >
            {t('clone.clear')}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-[6px] max-[700px]:grid-cols-1 mt-[6px]">
        <div>
          <div className="label-row">{t('clone.transcript')}</div>
          <input
            type="text"
            className="input-base"
            value={refText}
            onChange={(e) => setRefText(e.target.value)}
            placeholder={t('clone.optional')}
          />
        </div>
        <div>
          <div className="label-row">{t('clone.style')}</div>
          <input
            type="text"
            className="input-base"
            value={instruct}
            onChange={(e) => setInstruct(e.target.value)}
            placeholder={t('clone.style_placeholder')}
          />
        </div>
      </div>

      {/* #526: voice-design seed — show + pin + re-roll so tweaks can
                stay on the same base timbre. Design mode only. */}
      {defineMethod === 'design' && (
        <div className="mt-[var(--space-3)]">
          <div className="label-row">{t('clone.seed_label')}</div>
          <div className="flex gap-[var(--space-3)] items-center">
            <input
              type="number"
              className="input-base w-[9rem] flex-none"
              value={designSeed ?? ''}
              placeholder={t('clone.seed_placeholder')}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === '') {
                  setDesignSeed(null);
                  return;
                }
                const n = parseInt(v, 10);
                if (Number.isInteger(n)) {
                  setDesignSeed(n);
                  setKeepSeed(true);
                }
              }}
            />
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                setDesignSeed(Math.floor(Math.random() * 2147483647));
                setKeepSeed(true);
              }}
              leading={<Dice5 size={12} />}
              title={t('clone.seed_reroll_hint')}
            >
              {t('clone.seed_reroll')}
            </Button>
            <label className="inline-flex items-center gap-[6px] text-[0.85em] text-fg-muted cursor-pointer select-none whitespace-nowrap">
              <input
                type="checkbox"
                checked={keepSeed}
                onChange={(e) => setKeepSeed(e.target.checked)}
              />
              <span>{t('clone.seed_keep')}</span>
            </label>
          </div>
        </div>
      )}

      {/* Save as profile */}
      {refAudio && !selectedProfile && (
        <div className="mt-[var(--space-4)]">
          {!showSaveProfile ? (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setShowSaveProfile(true)}
              leading={<Save size={12} />}
            >
              {t('clone.save_as_profile')}
            </Button>
          ) : (
            <div className="flex gap-[var(--space-3)] items-center [&>:first-child]:flex-1">
              <Input
                size="sm"
                placeholder={t('clone.profile_name')}
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
              />
              <Button variant="subtle" size="sm" onClick={handleSaveProfile}>
                {t('clone.save')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowSaveProfile(false)}>
                {t('clone.cancel')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
