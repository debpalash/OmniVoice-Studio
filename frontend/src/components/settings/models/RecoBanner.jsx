import React from 'react';
import { RefreshCw, CheckCircle } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Button } from '../../../ui';

/**
 * Recommendation banner — shows the device's recommended model set and lets the
 * user kick off the required / all installs. Purely presentational; all state
 * and mutations are supplied by the host ModelStoreTab.
 */
export default function RecoBanner({
  reco,
  t,
  installMutation,
  installingReco,
  setInstallingReco,
  onInstallRecommended,
}) {
  if (!reco) return null;
  if (reco.all_installed) {
    return (
      <div className="reco-banner reco-banner--ok">
        <CheckCircle size={12} color="#8ec07c" />
        <span className="flex-1">
          {t('models.reco_installed_for', { device: reco.device.label })}
        </span>
        <span className="reco-banner__gb">{reco.total_gb} GB</span>
      </div>
    );
  }
  return (
    <div className="reco-banner reco-banner--pending">
      <div className="reco-banner__top">
        <span className="reco-banner__title">
          {t('models.reco_for', { device: reco.device.label })}
        </span>
        <div className="reco-banner__btns">
          {(() => {
            const requiredMissing = reco.models.filter((m) => m.required && !m.installed);
            const requiredGb = requiredMissing.reduce((s, m) => s + m.size_gb, 0);
            if (requiredMissing.length === 0) return null;
            return (
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  setInstallingReco(true);
                  try {
                    await Promise.all(
                      requiredMissing.map((m) => installMutation.mutateAsync(m.repo_id)),
                    );
                    toast.success(
                      t('models.started_downloading_required', { count: requiredMissing.length }),
                    );
                  } catch (e) {
                    toast.error(t('models.install_failed', { message: e.message || e }));
                  } finally {
                    setInstallingReco(false);
                  }
                }}
                disabled={installingReco}
                leading={installingReco ? <RefreshCw size={12} className="spinner" /> : null}
              >
                {installingReco
                  ? t('models.starting')
                  : t('models.required_size', { size: requiredGb.toFixed(1) })}
              </Button>
            );
          })()}
          <Button
            variant="subtle"
            size="sm"
            onClick={onInstallRecommended}
            disabled={installingReco}
          >
            {t('models.all_size', { size: reco.download_gb_remaining })}
          </Button>
        </div>
      </div>
      <div className="reco-banner__grid">
        {reco.models.map((m) => (
          <span
            key={m.repo_id}
            className={`reco-banner__model ${m.installed ? 'reco-banner__model--ok' : ''}`}
          >
            {m.installed ? '✓' : '○'} {m.label}
            <span className="reco-banner__model-size">{m.size_gb}</span>
            {m.required && <span className="reco-banner__req">{t('models.req_tag')}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
