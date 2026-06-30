/**
 * Settings → Capture → Echo cancellation panel (parity program Action 8).
 *
 * Opt-in toggle for dictate-over-playback AEC. When on, dictation streams raw
 * PCM through the backend's server-side NLMS canceller (`/ws/transcribe?aec=1`)
 * and the audio player taps its output as the echo reference, so dictating
 * while OmniVoice plays audio doesn't transcribe the playback. Off by default —
 * dictation uses the standard MediaRecorder path and behaves identically on
 * every platform. The pref is the zustand `aecEnabled` flag (persisted); no
 * backend round-trip needed.
 */
import React from 'react';
import { Volume2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { SettingsSection, SettingRow, SettingsToggle } from './primitives';

export default function AecPanel() {
  const aecEnabled = useAppStore((s) => s.aecEnabled);
  const setAecEnabled = useAppStore((s) => s.setAecEnabled);

  return (
    <SettingsSection
      icon={Volume2}
      title="Dictate while audio plays"
      description="Cancel OmniVoice's own playback out of the microphone."
    >
      <SettingRow
        title="Enable echo cancellation for dictation"
        subtitle="experimental"
        hint={
          <>
            Cancels OmniVoice's own playback out of the microphone so you can dictate while a
            preview, dub, or video is playing — without the transcript picking up what the app is
            saying. Adds a small amount of audio processing; leave it off if you never dictate over
            playback.
          </>
        }
        control={
          <SettingsToggle
            checked={aecEnabled}
            onChange={setAecEnabled}
            aria-label="Enable echo cancellation for dictation"
          />
        }
      />
    </SettingsSection>
  );
}
