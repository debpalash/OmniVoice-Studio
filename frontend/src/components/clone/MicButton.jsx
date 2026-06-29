import { useTranslation } from 'react-i18next';
import { Sparkles, Square, Mic } from 'lucide-react';

export default function MicButton({ isCleaning, isRecording, recordingTime, onStart, onStop }) {
  const { t } = useTranslation();
  if (isCleaning) {
    return (
      <div className="mic-btn mic-btn--cleaning">
        <Sparkles size={18} className="spinner" />
        <span>{t('clone.cleaning')}</span>
      </div>
    );
  }
  if (isRecording) {
    return (
      <button type="button" onClick={onStop} className="mic-btn mic-btn--recording">
        <Square size={18} fill="currentColor" />
        <span>{recordingTime}s</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={onStart} className="mic-btn mic-btn--idle" title={t('clone.record')}>
      <Mic size={18} />
      <span>{t('clone.record')}</span>
    </button>
  );
}
