// Non-blocking auto-update surface: a small pill that appears when an update is
// available / downloading / ready / failed. Replaces the old blocking ask()
// dialog so an update never interrupts in-flight work — the user installs when
// they choose, sees what's new first, and the action is gated while a dub job
// is running. A failed install surfaces a retry instead of vanishing silently.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader, RotateCw, AlertTriangle, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store';
import { installUpdate } from '../utils/updater';
import './UpdateBadge.css';

export default function UpdateBadge() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.updateStatus);
  const version = useAppStore((s) => s.updateVersion);
  const notes = useAppStore((s) => s.updateNotes);
  const progress = useAppStore((s) => s.updateProgress);
  const error = useAppStore((s) => s.updateError);
  const dubStep = useAppStore((s) => s.dubStep);
  const [notesOpen, setNotesOpen] = useState(false);

  if (status === 'idle' || status === 'checking') return null;

  const busy = dubStep === 'generating';
  const onInstall = () => {
    if (busy) { toast(t('update.busy'), { icon: '⏳' }); return; }
    installUpdate(useAppStore.getState());
  };

  return (
    <div className="update-badge" role="status">
      {status === 'available' && (
        <div className="update-badge__avail">
          <button type="button" className="update-badge__btn" onClick={onInstall} title={t('update.install_hint')}>
            <Download size={12} /> {t('update.available', { version: version || '' })} · {t('update.install')}
          </button>
          {notes && (
            <button
              type="button"
              className={`update-badge__more ${notesOpen ? 'is-open' : ''}`}
              onClick={() => setNotesOpen((v) => !v)}
              aria-expanded={notesOpen}
              aria-controls="update-badge-notes"
            >
              <ChevronDown size={12} /> {t('update.whats_new')}
            </button>
          )}
          {notes && <div id="update-badge-notes" className="update-badge__notes" hidden={!notesOpen}>{notes}</div>}
        </div>
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
      {status === 'error' && (
        <button
          type="button"
          className="update-badge__btn update-badge__btn--error"
          onClick={onInstall}
          title={error || t('update.failed')}
        >
          <AlertTriangle size={12} /> {t('update.failed')} · {t('update.retry')}
        </button>
      )}
    </div>
  );
}
