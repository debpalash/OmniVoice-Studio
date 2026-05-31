// Non-blocking auto-update surface: a small pill that appears when an update is
// available / downloading / ready. Replaces the old blocking ask() dialog so an
// update never interrupts in-flight work — the user installs when they choose,
// and the action is gated while a dub job is running.
import { useTranslation } from 'react-i18next';
import { Download, Loader, RotateCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store';
import { installUpdate } from '../utils/updater';
import './UpdateBadge.css';

export default function UpdateBadge() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.updateStatus);
  const version = useAppStore((s) => s.updateVersion);
  const progress = useAppStore((s) => s.updateProgress);
  const dubStep = useAppStore((s) => s.dubStep);

  if (status === 'idle' || status === 'checking' || status === 'error') return null;

  const busy = dubStep === 'generating';
  const onInstall = () => {
    if (busy) { toast(t('update.busy'), { icon: '⏳' }); return; }
    installUpdate(useAppStore.getState());
  };

  return (
    <div className="update-badge" role="status">
      {status === 'available' && (
        <button type="button" className="update-badge__btn" onClick={onInstall} title={t('update.install_hint')}>
          <Download size={12} /> {t('update.available', { version: version || '' })} · {t('update.install')}
        </button>
      )}
      {status === 'downloading' && (
        <span className="update-badge__progress">
          <Loader size={12} className="spinner" /> {t('update.downloading', { pct: Math.round(progress) })}
          <span className="update-badge__bar"><span style={{ width: `${progress}%` }} /></span>
        </span>
      )}
      {status === 'ready' && (
        <button type="button" className="update-badge__btn update-badge__btn--ready" onClick={onInstall}>
          <RotateCw size={12} /> {t('update.restart')}
        </button>
      )}
    </div>
  );
}
