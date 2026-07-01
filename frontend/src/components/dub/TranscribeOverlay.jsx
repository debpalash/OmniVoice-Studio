import { useTranslation } from 'react-i18next';
import { Loader, Square } from 'lucide-react';
import { Button, Progress } from '../../ui';

/**
 * TranscribeOverlay — Whisper progress + ETA while transcribing.
 */
function TranscribeOverlay({ elapsed, duration, onAbort }) {
  const { t } = useTranslation();
  const est = duration > 0 ? Math.max(10, Math.ceil(duration / 60) * 3 + 8) : 0;
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <div className="flex flex-col items-center gap-[var(--space-5)] w-full">
      <div className="flex items-center gap-[var(--space-4)]">
        <Loader className="spinner" size={18} color="#d3869b" />
        <span className="text-fg font-medium text-[var(--text-lg)]">{t('dub.transcribing')}</span>
      </div>
      <div className="flex gap-[var(--space-6)] text-[length:var(--text-md)] text-fg-muted [font-variant-numeric:tabular-nums_slashed-zero]">
        <span>
          ⏱ {mm}:{ss} {t('dub.elapsed')}
        </span>
        {est > 0 && (
          <span>
            ~{Math.max(0, est - elapsed)}
            {t('dub.remaining')}
          </span>
        )}
      </div>
      {duration > 0 && (
        <div className="w-[80%] max-w-[340px]">
          <Progress value={Math.min(95, (elapsed / est) * 100)} tone="brand" size="sm" />
        </div>
      )}
      <Button variant="danger" size="sm" onClick={onAbort} leading={<Square size={11} />}>
        {t('dub.prep_stop')}
      </Button>
    </div>
  );
}

export default TranscribeOverlay;
