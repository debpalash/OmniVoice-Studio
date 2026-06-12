// frontend/src/components/UpdateStatusChip.jsx
// Persistent update indicator that lives in the LogsFooter bar (replaces the
// old floating UpdateBadge). Shows current version when idle; morphs into
// available / downloading / ready / error. Click opens the Updates panel.
import { useTranslation } from 'react-i18next';
import { Check, ArrowUp, Loader, RotateCw, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../store';
import { chipPresentation } from '../utils/updatePresentation';
import { installUpdate } from '../utils/updater';
import toast from 'react-hot-toast';
import './UpdateStatusChip.css';

const ICONS = { check: Check, up: ArrowUp, spin: Loader, restart: RotateCw, alert: AlertTriangle };

export default function UpdateStatusChip({ onOpen, active = false }) {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.updateStatus);
  const version = useAppStore((s) => s.updateVersion);
  const appVersion = useAppStore((s) => s.appVersion);
  const progress = useAppStore((s) => s.updateProgress);
  const dubStep = useAppStore((s) => s.dubStep);

  const p = chipPresentation(status, { appVersion, version, progress });
  if (!p) return null;
  const Icon = ICONS[p.icon] || Check;

  const labelText = {
    idle: p.label,
    available: t('update.available', { version: p.label }),
    downloading: t('update.downloading', { pct: p.label.replace('%', '') }),
    ready: t('update.restart'),
    error: t('update.failed'),
  }[p.variant];

  // ready stays one-click (preserve today's behavior); others open the panel.
  const onClick = () => {
    if (p.variant === 'ready') {
      // Don't relaunch out from under an in-flight dub/transcription job.
      if (dubStep === 'generating') { toast(t('update.busy'), { icon: '⏳' }); return; }
      installUpdate(useAppStore.getState());
      return;
    }
    onOpen?.();
  };

  return (
    <button
      type="button"
      className={`update-chip update-chip--${p.variant} ${active ? 'update-chip--active' : ''}`}
      onClick={onClick}
      title={t('updates.tab')}
    >
      <Icon size={12} className={p.icon === 'spin' ? 'spinner' : ''} />
      <span className="update-chip__label">{labelText}</span>
    </button>
  );
}
