import { Suspense, lazy } from 'react';
import { ChevronUp, ChevronDown, FileText } from 'lucide-react';
import { Button, Segmented } from '../../ui';
import GlossaryPanel from '../GlossaryPanel';
import CheckpointBanner from '../CheckpointBanner';
import { LANG_CODES } from '../../utils/languages';

const DubSegmentTable = lazy(() => import('../DubSegmentTable'));

const LazyFallback = () => (
  <div className="dub-lazy-fallback">Loading…</div>
);

export default function DubRightColumn({ t, preserveBg, setPreserveBg, dualSubs, setDualSubs, burnSubs, setBurnSubs, defaultTrack, setDefaultTrack, dubLangCode, dubTracks, timingStrategy, setTimingStrategy, dubTranscript, showTranscript, setShowTranscript, dubJobId, glossaryVisible, setGlossaryOpen, setGlossaryHidden, glossaryTermCount, dubLang, dubSegments, onGlossaryChange, selectedSegIds, bulkApplyToSelected, speakerClones, profiles, clearSegSelection, bulkDeleteSelected, showCheckpoint, checkpointStage, onCheckpointContinue, onCheckpointDismiss, isTranslating, segmentPreviewLoading, toggleSegSelect, selectAllSegs, segmentEditField, segmentDelete, segmentRestoreOriginal, handleSegmentPreview, onDirectSegment, segmentSplit, segmentMerge, seekWaveform, timelineSelSegId, dubStep, dubProgress }) {
  return (
            <div className="studio-panel dub-panel-col">

              {/* Output options + timing — moved to the top of the right section. */}
              <div className="dub-right-outputs">
                <div className="dub-outputs-row">
                  <span className="dub-outputs-title-strong">{t('dub.output_options')}</span>
                  <label>
                    <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} /> {t('dub.mix_bg_audio')}
                  </label>
                  <label title={t('dub.dual_subs_title')}>
                    <input type="checkbox" checked={!!dualSubs} onChange={e => setDualSubs(e.target.checked)} /> {t('dub.dual_subs')}
                  </label>
                  <label title={t('dub.burn_subs_title')}>
                    <input type="checkbox" checked={!!burnSubs} onChange={e => setBurnSubs(e.target.checked)} /> {t('dub.burn_subs')}
                  </label>
                  <label>
                    {t('dub.default_track')}
                    <select className="input-base dub-outputs-default" value={defaultTrack} onChange={e => setDefaultTrack(e.target.value)}>
                      <option value="original">{t('dub.original_track')}</option>
                      {dubLangCode && <option value={dubLangCode}>{t('dub.selected_dub', { code: dubLangCode })}</option>}
                      {dubTracks.filter(tr => tr !== dubLangCode).map(tr => (
                        <option key={tr} value={tr}>{t('dub.dub_track', { code: tr })}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="dub-outputs-row" title="Timing strategy — how the dub reconciles natural-rate TTS with the original timeline.">
                  <span className="dub-outputs-title-strong">Timing:</span>
                  <Segmented
                    value={timingStrategy}
                    onChange={setTimingStrategy}
                    items={[
                      { value: 'concise',       label: 'Concise',        title: 'Translator trims text to fit at natural rate. Overflows surface in the row badge so you can shorten the segment.' },
                      { value: 'smart_fit',     label: t('dub.timing_smart_fit'), title: t('dub.timing_smart_fit_title') },
                      { value: 'stretch_video', label: 'Stretch Video',  title: 'Audio plays at natural rate; each segment of the video is stretched (per-segment ffmpeg setpts) to fit. Total video duration grows. Requires a re-encode pass.' },
                      { value: 'strict_slot',   label: 'Strict slot',    title: 'Legacy: compress audio to fit the original timing. Can sound rushed/chipmunky on high-density target languages.' },
                    ]}
                  />
                </div>
              </div>

              {dubTranscript && (
                <div className="dub-transcript-toggle-wrap">
                  <div className="override-toggle dub-transcript-toggle__inner" onClick={() => setShowTranscript(!showTranscript)}>
                    <span><FileText size={10} className="dub-inline-icon" /> {t('dub.transcript')}</span>
                    {showTranscript ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </div>
                  {showTranscript && (
                    <div className="dub-transcript-body">
                      {dubTranscript}
                    </div>
                  )}
                </div>
              )}

              {/* Phase 1.3 — Project glossary. Hidden behind a chip until
                  the user wants it (or terms already exist). */}
              {dubJobId && !glossaryVisible && (
                <button
                  type="button"
                  className="dub-glossary-chip"
                  onClick={() => { setGlossaryOpen(true); setGlossaryHidden(false); }}
                  title={t('dub.glossary_title')}
                >
                  {t('dub.glossary_btn', { count: glossaryTermCount })}
                </button>
              )}
              {dubJobId && glossaryVisible && (
                <div className="dub-glossary-wrap">
                  <GlossaryPanel
                    projectId={dubJobId}
                    sourceLang={dubLangCode && dubLang ? (dubLang.slice(0, 2).toLowerCase() || 'en') : 'en'}
                    targetLang={dubLangCode}
                    segments={dubSegments}
                    onChange={onGlossaryChange}
                    onClose={() => { setGlossaryHidden(true); setGlossaryOpen(false); }}
                  />
                </div>
              )}

              {/* "Apply Voice to All" row removed 2026-04-21 — redundant
                  with the CAST strip in the left column, which does the same
                  thing per-speaker (and handles the multi-speaker case cleanly). */}

              {selectedSegIds.size > 0 && (
                <div className="dub-bulk-row dub-bulk-row--select">
                  <span className="dub-bulk-row__label-brand">{t('dub.selected_count', { count: selectedSegIds.size })}</span>
                  <select className="input-base dub-bulk-select dub-bulk-select--voice"
                    value="" onChange={(e) => { const v = e.target.value; if (v === '__clear__') bulkApplyToSelected({ profile_id: '' }); else if (v) bulkApplyToSelected({ profile_id: v }); }}>
                    <option value="">{t('dub.set_voice')}</option>
                    <option value="__clear__">{t('dub.clear_voice')}</option>
                    {speakerClones && Object.keys(speakerClones).length > 0 && (
                      <optgroup label={t('dub.cast')}>
                        {Object.keys(speakerClones).map(spk => {
                          const autoId = `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}`;
                          return <option key={autoId} value={autoId}>🎤 {spk}</option>;
                        })}
                      </optgroup>
                    )}
                    {profiles.filter(p => !p.instruct).length > 0 && (
                      <optgroup label={t('dub.clone_profiles')}>
                        {profiles.filter(p => !p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                    {profiles.filter(p => !!p.instruct).length > 0 && (
                      <optgroup label={t('dub.design_presets')}>
                        {profiles.filter(p => !!p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                  </select>
                  <select className="input-base dub-bulk-select dub-bulk-select--lang"
                    value="" onChange={(e) => { if (e.target.value === '__def__') bulkApplyToSelected({ target_lang: null }); else if (e.target.value) bulkApplyToSelected({ target_lang: e.target.value }); }}>
                    <option value="">{t('dub.set_lang')}</option>
                    <option value="__def__">{t('dub.default_lang')}</option>
                    {LANG_CODES.map(lc => <option key={lc.code} value={lc.code}>{lc.code.toUpperCase()}</option>)}
                  </select>
                  <Button variant="danger" size="sm" onClick={bulkDeleteSelected}>{t('dub.delete_selected')}</Button>
                  <Button variant="ghost"  size="sm" onClick={clearSegSelection} className="dub-bulk-row__clear">{t('dub.clear_selection')}</Button>
                </div>
              )}

              {showCheckpoint && (
                <CheckpointBanner
                  stage={checkpointStage}
                  count={dubSegments.length}
                  onContinue={checkpointStage === 'done' ? null : onCheckpointContinue}
                  onDismiss={onCheckpointDismiss}
                  continueLoading={isTranslating}
                />
              )}

              <Suspense fallback={<LazyFallback />}>
                <DubSegmentTable
                  segments={dubSegments}
                  profiles={profiles}
                  speakerClones={speakerClones}
                  dubStep={dubStep}
                  dubProgress={dubProgress}
                  previewLoadingId={segmentPreviewLoading}
                  selectedIds={selectedSegIds}
                  onSelect={toggleSegSelect}
                  onSelectAll={selectAllSegs}
                  onClearSelection={clearSegSelection}
                  onEditField={segmentEditField}
                  onDelete={segmentDelete}
                  onRestore={segmentRestoreOriginal}
                  onPreview={handleSegmentPreview}
                  onDirect={onDirectSegment}
                  onSplit={segmentSplit}
                  onMerge={segmentMerge}
                  onSeek={seekWaveform}
                  timelineSelectedId={timelineSelSegId}
                />
              </Suspense>
            </div>
  );
}
