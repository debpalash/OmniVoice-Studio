// frontend/src/components/UpdatesPanel.jsx
// Update management panel — lives under Settings → Updates. Shows live update
// status, channel switcher, and GitHub releases (changelog/history) list.
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RotateCw, AlertTriangle, RefreshCw, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store';
import { installUpdate, checkForUpdate } from '../utils/updater';
import { prepareReleases } from '../utils/updatePresentation';
import { setChannel } from '../utils/channelControl';
import './UpdatesPanel.css';

export default function UpdatesPanel() {
  const { t } = useTranslation();
  const status = useAppStore((s) => s.updateStatus);
  const version = useAppStore((s) => s.updateVersion);
  const error = useAppStore((s) => s.updateError);
  const progress = useAppStore((s) => s.updateProgress);
  const appVersion = useAppStore((s) => s.appVersion);
  const channel = useAppStore((s) => s.updateChannel);
  const releases = useAppStore((s) => s.releases);
  const releasesStatus = useAppStore((s) => s.releasesStatus);
  const loadReleases = useAppStore((s) => s.loadReleases);
  const dismissUpdate = useAppStore((s) => s.dismissUpdate);
  const dubStep = useAppStore((s) => s.dubStep);

  useEffect(() => { loadReleases(channel); }, [channel, loadReleases]);

  const busy = dubStep === 'generating';
  const onInstall = () => {
    if (busy) { toast(t('update.busy'), { icon: '⏳' }); return; }
    installUpdate(useAppStore.getState());
  };
  const rows = prepareReleases(releases, channel, appVersion);

  return (
    <div className="updates-panel">
      <div className="updates-panel__live">
        {status === 'available' && (
          <button className="updates-panel__cta" onClick={onInstall}>
            <Download size={13} /> {t('update.available', { version: version || '' })} · {t('update.install')}
          </button>
        )}
        {status === 'downloading' && (
          <span className="updates-panel__progress">
            {t('update.downloading', { pct: Math.round(progress) })}
            <span className="updates-panel__bar"><span style={{ width: `${progress}%` }} /></span>
          </span>
        )}
        {status === 'ready' && (
          <button className="updates-panel__cta" onClick={onInstall}>
            <RotateCw size={13} /> {t('update.restart')}
          </button>
        )}
        {status === 'error' && (
          <span className="updates-panel__err">
            <AlertTriangle size={13} /> {error || t('update.failed')}
            <button className="updates-panel__link" onClick={onInstall}>{t('update.retry')}</button>
            <button className="updates-panel__icon" onClick={dismissUpdate} aria-label={t('update.dismiss')}><X size={13} /></button>
          </span>
        )}
        {(status === 'idle' || status === 'checking') && (
          <span className="updates-panel__ok">
            {t('updates.up_to_date', { version: appVersion || '' })}
            <button className="updates-panel__link" onClick={() => checkForUpdate(useAppStore.getState())}>
              <RefreshCw size={12} /> {t('updates.check_now')}
            </button>
          </span>
        )}
      </div>

      <div className="updates-panel__channel">
        <span>{t('about.update_channel')}</span>
        <div className="updates-panel__seg" role="radiogroup" aria-label={t('about.update_channel')}>
          {['stable', 'preview'].map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={channel === c}
              className={`updates-panel__segbtn ${channel === c ? 'is-active' : ''}`}
              onClick={() => setChannel(useAppStore.getState(), c).catch((e) => toast(t('settings.channel_set_failed', { message: e?.message || e }), { icon: '⚠️' }))}
            >
              {t(`about.channel_${c}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="updates-panel__releases">
        <div className="updates-panel__rel-head">{t('updates.releases')}</div>
        {releasesStatus === 'error' && (
          <div className="updates-panel__rel-empty">
            {t('updates.load_error')}
            <button className="updates-panel__link" onClick={() => loadReleases(channel)}>{t('updates.retry_load')}</button>
          </div>
        )}
        {releasesStatus === 'loading' && <div className="updates-panel__rel-empty">{t('updates.loading')}</div>}
        {releasesStatus === 'loaded' && rows.length === 0 && (
          <div className="updates-panel__rel-empty">{t('updates.none')}</div>
        )}
        {rows.map((r) => (
          <div key={r.name || r.version} className={`updates-panel__rel ${r.current ? 'is-current' : ''}`}>
            <div className="updates-panel__rel-row">
              <span className="updates-panel__rel-ver">v{r.version}</span>
              {r.current && <span className="updates-panel__rel-tag">{t('updates.current')}</span>}
              {r.prerelease && <span className="updates-panel__rel-pre">{t('updates.prerelease')}</span>}
              <span className="updates-panel__rel-date">{r.date}</span>
            </div>
            {r.notes && <pre className="updates-panel__rel-notes">{r.notes}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}
