import { Check, AlertCircle } from 'lucide-react';
import { Badge } from '../../ui';
import DubFailureNotice from './DubFailureNotice';

export default function DubFooter({ t, dubStep, dubTracks, incrementalPlan, dubError, dubFailure, exportTracks, setExportTracks, dubSegments, translateQuality }) {
  return (
          <div className="studio-panel dub-footer-panel">
            {dubStep === 'done' && (
              <div className="dub-footer-banner">
                <Badge tone="success">
                  <Check size={11} /> {t('dub.tracks_done', { tracks: dubTracks.join(', ') })}
                </Badge>
                {incrementalPlan && incrementalPlan.stale?.length > 0 && (
                  <Badge tone="warn" className="dub-footer-banner__badge-gap">
                    {t('dub.segments_changed', { count: incrementalPlan.stale.length })}
                  </Badge>
                )}
                {incrementalPlan && incrementalPlan.stale?.length === 0 && incrementalPlan.fresh?.length > 0 && (
                  <Badge tone="neutral" className="dub-footer-banner__badge-gap">
                    {t('dub.all_up_to_date', { count: incrementalPlan.fresh.length })}
                  </Badge>
                )}
              </div>
            )}
            {dubError && (
              <div className="dub-footer-banner">
                <Badge tone="danger">
                  <AlertCircle size={11} /> {dubError}
                </Badge>
                <DubFailureNotice failure={dubFailure} />
              </div>
            )}
            {/* Output options + Timing moved to the top of the right (transcript) section. */}
            {dubTracks.length > 0 && (
              <div className="dub-tracks-row">
                <span className="dub-tracks-row__title">{t('dub.export_tracks')}</span>
                <label className={exportTracks['original'] !== false ? 'is-on' : 'is-off'}>
                  <input type="checkbox" checked={exportTracks['original'] !== false} onChange={e => setExportTracks(prev => ({ ...prev, original: e.target.checked }))} />
                  <span>{t('dub.original_track')}</span>
                </label>
                {dubTracks.map(t => (
                  <label key={t} className={exportTracks[t] !== false ? 'is-on is-success' : 'is-off'}>
                    <input type="checkbox" checked={exportTracks[t] !== false} onChange={e => setExportTracks(prev => ({ ...prev, [t]: e.target.checked }))} />
                    <span className="code">{t}</span>
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
              const hot = dubSegments.filter(s => (s.rate_ratio || 0) > 1.3);
              if (hot.length === 0 || !dubSegments.length) return null;
              const pctHot = Math.round((hot.length / dubSegments.length) * 100);
              if (pctHot < 10) return null;
              const worst = hot.reduce((a, b) => (a.rate_ratio > b.rate_ratio ? a : b));
              return (
                <div className="dub-compression-warn" role="status">
                  <span className="dub-compression-warn__icon">⚠</span>
                  <span className="dub-compression-warn__body">
                    <strong>{hot.length} of {dubSegments.length}</strong> segments need {'>'}1.3× compression
                    (worst: <span style={{ fontVariantNumeric: 'tabular-nums' }}>{worst.rate_ratio.toFixed(2)}×</span>).
                    Output will be intelligible (pitch-preserving stretch) but stressed —
                    {translateQuality === 'fast' ? ' switch to Cinematic and Re-translate' : ' shorten the worst segments'}
                    {' '}for cleaner audio.
                  </span>
                </div>
              );
            })()}
            {/* Generate / Export / Stop actions moved to the header bar (dub-head__primary). */}
          </div>
  );
}
