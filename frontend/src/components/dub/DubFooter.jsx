import { Check, AlertCircle } from 'lucide-react';
import { Badge } from '../../ui';
import DubFailureNotice from './DubFailureNotice';

// Export-track toggle chips: flat pill outline, tinted by on/off/success state.
const TRACK_LABEL =
  'inline-flex items-center gap-[4px] px-[8px] py-[2px] border border-transparent rounded-[var(--chrome-radius-pill)] cursor-pointer transition-colors';
const TRACK_ON =
  'text-[var(--chrome-fg)] border-[var(--chrome-border-strong)] bg-[var(--chrome-hover-bg)]';
const TRACK_OFF = 'text-[var(--chrome-fg-dim)]';
const TRACK_ON_SUCCESS =
  'text-[var(--chrome-severity-ok)] border-[color-mix(in_srgb,var(--chrome-severity-ok)_45%,transparent)] bg-[color-mix(in_srgb,var(--chrome-severity-ok)_10%,transparent)]';

export default function DubFooter({
  t,
  dubStep,
  dubTracks,
  incrementalPlan,
  dubError,
  dubFailure,
  exportTracks,
  setExportTracks,
  dubSegments,
  translateQuality,
}) {
  return (
    <div className="px-[var(--space-3)] py-[4px] shrink-0 bg-[var(--chrome-bg)] border border-[var(--chrome-border)]">
      {dubStep === 'done' && (
        <div className="mb-[var(--space-2)]">
          <Badge tone="success">
            <Check size={11} /> {t('dub.tracks_done', { tracks: dubTracks.join(', ') })}
          </Badge>
          {incrementalPlan && incrementalPlan.stale?.length > 0 && (
            <Badge tone="warn" className="ml-[6px]">
              {t('dub.segments_changed', { count: incrementalPlan.stale.length })}
            </Badge>
          )}
          {incrementalPlan &&
            incrementalPlan.stale?.length === 0 &&
            incrementalPlan.fresh?.length > 0 && (
              <Badge tone="neutral" className="ml-[6px]">
                {t('dub.all_up_to_date', { count: incrementalPlan.fresh.length })}
              </Badge>
            )}
        </div>
      )}
      {dubError && (
        <div className="mb-[var(--space-2)]">
          <Badge tone="danger">
            <AlertCircle size={11} /> {dubError}
          </Badge>
          <DubFailureNotice failure={dubFailure} />
        </div>
      )}
      {/* Output options + Timing moved to the top of the right (transcript) section. */}
      {dubTracks.length > 0 && (
        <div className="flex items-center gap-[var(--space-2)] mb-[2px] px-[var(--space-3)] py-[3px] text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)] font-[family-name:var(--font-sans)] bg-[var(--chrome-bg)] rounded-[var(--chrome-radius-pill)] border border-[var(--chrome-border)] flex-wrap">
          <span className="font-[family-name:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] tracking-[var(--chrome-label-track)] uppercase text-[var(--chrome-fg-muted)] font-semibold">
            {t('dub.export_tracks')}
          </span>
          <label
            className={`${TRACK_LABEL} ${exportTracks['original'] !== false ? TRACK_ON : TRACK_OFF}`}
          >
            <input
              type="checkbox"
              className="accent-[var(--chrome-accent)]"
              checked={exportTracks['original'] !== false}
              onChange={(e) => setExportTracks((prev) => ({ ...prev, original: e.target.checked }))}
            />
            <span>{t('dub.original_track')}</span>
          </label>
          {dubTracks.map((t) => (
            <label
              key={t}
              className={`${TRACK_LABEL} ${exportTracks[t] !== false ? TRACK_ON_SUCCESS : TRACK_OFF}`}
            >
              <input
                type="checkbox"
                className="accent-[var(--chrome-accent)]"
                checked={exportTracks[t] !== false}
                onChange={(e) => setExportTracks((prev) => ({ ...prev, [t]: e.target.checked }))}
              />
              <span className="uppercase tracking-[0.04em]">{t}</span>
            </label>
          ))}
        </div>
      )}
      {(() => {
        // Pre-generation compression warning. Predicted by the
        // translate response (see services/speech_rate.rate_ratio
        // + dub_translate._maybe_cinematic), populated whenever
        // segments carry a slot_seconds and translated text.
        // Surfaces here so the user can act (re-translate in
        // Cinematic, edit text, allow longer slots) before
        // committing to a full Generate Dub run.
        const hot = dubSegments.filter((s) => (s.rate_ratio || 0) > 1.3);
        if (hot.length === 0 || !dubSegments.length) return null;
        const pctHot = Math.round((hot.length / dubSegments.length) * 100);
        if (pctHot < 10) return null;
        const worst = hot.reduce((a, b) => (a.rate_ratio > b.rate_ratio ? a : b));
        return (
          <div
            className="flex items-start gap-[8px] px-[10px] py-[6px] my-[4px] bg-[color-mix(in_srgb,#fabd2f_12%,transparent)] border border-[color-mix(in_srgb,#fabd2f_35%,transparent)] border-l-2 border-l-[#fabd2f] rounded-[var(--chrome-radius-pill)] text-[0.72rem] text-[var(--chrome-fg)] leading-[1.35]"
            role="status"
          >
            <span className="text-[#fabd2f] text-[0.9rem] leading-none shrink-0">⚠</span>
            <span className="flex-1">
              <strong className="text-[#fabd2f] font-semibold">
                {hot.length} of {dubSegments.length}
              </strong>{' '}
              segments need {'>'}1.3× compression (worst:{' '}
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {worst.rate_ratio.toFixed(2)}×
              </span>
              ). Output will be intelligible (pitch-preserving stretch) but stressed —
              {translateQuality === 'fast'
                ? ' switch to Cinematic and Re-translate'
                : ' shorten the worst segments'}{' '}
              for cleaner audio.
            </span>
          </div>
        );
      })()}
      {/* Generate / Export / Stop actions moved to the header bar (dub-head__primary). */}
    </div>
  );
}
