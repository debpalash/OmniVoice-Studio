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
    <div className="dub-trans-overlay">
      <div className="dub-trans-overlay__head">
        <Loader className="spinner" size={18} color="#d3869b" />
        <span className="dub-trans-overlay__title">{t('dub.transcribing')}</span>
      </div>
      <div className="dub-trans-overlay__stats">
        <span>⏱ {mm}:{ss} {t('dub.elapsed')}</span>
        {est > 0 && <span>~{Math.max(0, est - elapsed)}{t('dub.remaining')}</span>}
      </div>
      {duration > 0 && (
        <div className="dub-trans-overlay__bar">
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
