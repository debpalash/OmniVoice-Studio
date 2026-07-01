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
      <div className="mb-[var(--space-2)] flex items-center gap-[var(--space-3)] rounded-[var(--chrome-radius-pill)] [border:1px_solid] [border-left-width:2px] [border-color:color-mix(in_srgb,#8ec07c_30%,transparent)] [border-left-color:#8ec07c] bg-[color-mix(in_srgb,#8ec07c_4%,transparent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)]">
        <CheckCircle size={12} color="#8ec07c" />
        <span className="flex-1">
          {t('models.reco_installed_for', { device: reco.device.label })}
        </span>
        <span className="text-[length:var(--text-2xs)] text-[var(--chrome-fg-dim)]">
          {reco.total_gb} GB
        </span>
      </div>
    );
  }
  return (
    <div className="mb-[var(--space-2)] flex flex-col items-stretch gap-[var(--space-2)] rounded-[var(--chrome-radius-pill)] [border:1px_solid] [border-left-width:2px] [border-color:color-mix(in_srgb,#f3a5b6_25%,transparent)] [border-left-color:#f3a5b6] bg-[linear-gradient(135deg,color-mix(in_srgb,#f3a5b6_4%,transparent),color-mix(in_srgb,#d3869b_2%,transparent))] px-[var(--space-4)] pb-[var(--space-4)] pt-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)] shadow-[0_0_12px_color-mix(in_srgb,#f3a5b6_6%,transparent)]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[length:var(--text-md)] font-semibold text-[var(--chrome-fg)]">
          {t('models.reco_for', { device: reco.device.label })}
        </span>
        <div className="flex flex-shrink-0 gap-1">
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
      <div className="grid grid-cols-2 gap-x-[var(--space-5)] gap-y-0 text-[length:var(--text-sm)] leading-[1.6]">
        {reco.models.map((m) => (
          <span
            key={m.repo_id}
            className={`inline-flex items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap ${
              m.installed ? 'text-[var(--chrome-fg)]' : 'text-[var(--chrome-fg-muted)]'
            }`}
          >
            {m.installed ? '✓' : '○'} {m.label}
            <span className="font-[family-name:var(--chrome-font-mono)] text-[length:var(--text-2xs)] text-[var(--chrome-fg-dim)]">
              {m.size_gb}
            </span>
            {m.required && (
              <span className="rounded-[999px] [border:1px_solid_color-mix(in_srgb,#d3869b_30%,transparent)] px-[3px] py-0 text-[length:var(--text-2xs)] uppercase leading-[1.5] tracking-[0.04em] text-[#d3869b]">
                {t('models.req_tag')}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
