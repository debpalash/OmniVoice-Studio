import { Suspense, lazy } from 'react';
import { ChevronUp, ChevronDown, FileText } from 'lucide-react';
import { Button, Segmented } from '../../ui';
import GlossaryPanel from '../GlossaryPanel';
import CheckpointBanner from '../CheckpointBanner';
import { LANG_CODES } from '../../utils/languages';

const DubSegmentTable = lazy(() => import('../DubSegmentTable'));

const LazyFallback = () => <div className="p-[12px] text-[#6b6657] text-[0.7rem]">Loading…</div>;

// ── Output-options + bulk-select utility clusters ────────────────────────
const OUT_ROW =
  'flex items-center gap-[var(--space-3)] mb-[2px] px-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)] font-[family-name:var(--font-sans)] flex-wrap';
const OUT_LABEL =
  'flex items-center gap-[var(--space-2)] cursor-pointer hover:text-[var(--chrome-fg)]';
const OUT_TITLE =
  'font-[family-name:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] tracking-[var(--chrome-label-track)] uppercase text-[var(--chrome-fg-muted)] font-semibold';
const CHK = 'accent-[var(--chrome-accent)]';
const BULK_SELECT = 'input-base !text-[0.62rem] !px-[4px] !py-[2px]';

export default function DubRightColumn({
  t,
  preserveBg,
  setPreserveBg,
  dualSubs,
  setDualSubs,
  burnSubs,
  setBurnSubs,
  defaultTrack,
  setDefaultTrack,
  dubLangCode,
  dubTracks,
  timingStrategy,
  setTimingStrategy,
  dubTranscript,
  showTranscript,
  setShowTranscript,
  dubJobId,
  glossaryVisible,
  setGlossaryOpen,
  setGlossaryHidden,
  glossaryTermCount,
  dubLang,
  dubSegments,
  onGlossaryChange,
  selectedSegIds,
  bulkApplyToSelected,
  speakerClones,
  profiles,
  clearSegSelection,
  bulkDeleteSelected,
  showCheckpoint,
  checkpointStage,
  onCheckpointContinue,
  onCheckpointDismiss,
  isTranslating,
  segmentPreviewLoading,
  toggleSegSelect,
  selectAllSegs,
  segmentEditField,
  segmentDelete,
  segmentRestoreOriginal,
  handleSegmentPreview,
  onDirectSegment,
  segmentSplit,
  segmentMerge,
  seekWaveform,
  timelineSelSegId,
  dubStep,
  dubProgress,
}) {
  return (
    <div className="studio-panel dub-panel-col">
      {/* Output options + timing — moved to the top of the right section. */}
      <div>
        <div className={OUT_ROW}>
          <span className={OUT_TITLE}>{t('dub.output_options')}</span>
          <label className={OUT_LABEL}>
            <input
              type="checkbox"
              className={CHK}
              checked={preserveBg}
              onChange={(e) => setPreserveBg(e.target.checked)}
            />{' '}
            {t('dub.mix_bg_audio')}
          </label>
          <label className={OUT_LABEL} title={t('dub.dual_subs_title')}>
            <input
              type="checkbox"
              className={CHK}
              checked={!!dualSubs}
              onChange={(e) => setDualSubs(e.target.checked)}
            />{' '}
            {t('dub.dual_subs')}
          </label>
          <label className={OUT_LABEL} title={t('dub.burn_subs_title')}>
            <input
              type="checkbox"
              className={CHK}
              checked={!!burnSubs}
              onChange={(e) => setBurnSubs(e.target.checked)}
            />{' '}
            {t('dub.burn_subs')}
          </label>
          <label className={OUT_LABEL}>
            {t('dub.default_track')}
            <select
              className="input-base !text-[0.6rem] !px-[4px] !py-[2px] !w-[120px]"
              value={defaultTrack}
              onChange={(e) => setDefaultTrack(e.target.value)}
            >
              <option value="original">{t('dub.original_track')}</option>
              {dubLangCode && (
                <option value={dubLangCode}>{t('dub.selected_dub', { code: dubLangCode })}</option>
              )}
              {dubTracks
                .filter((tr) => tr !== dubLangCode)
                .map((tr) => (
                  <option key={tr} value={tr}>
                    {t('dub.dub_track', { code: tr })}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div
          className={OUT_ROW}
          title="Timing strategy — how the dub reconciles natural-rate TTS with the original timeline."
        >
          <span className={OUT_TITLE}>Timing:</span>
          <Segmented
            value={timingStrategy}
            onChange={setTimingStrategy}
            items={[
              {
                value: 'concise',
                label: 'Concise',
                title:
                  'Translator trims text to fit at natural rate. Overflows surface in the row badge so you can shorten the segment.',
              },
              {
                value: 'smart_fit',
                label: t('dub.timing_smart_fit'),
                title: t('dub.timing_smart_fit_title'),
              },
              {
                value: 'stretch_video',
                label: 'Stretch Video',
                title:
                  'Audio plays at natural rate; each segment of the video is stretched (per-segment ffmpeg setpts) to fit. Total video duration grows. Requires a re-encode pass.',
              },
              {
                value: 'strict_slot',
                label: 'Strict slot',
                title:
                  'Legacy: compress audio to fit the original timing. Can sound rushed/chipmunky on high-density target languages.',
              },
            ]}
          />
        </div>
      </div>

      {dubTranscript && (
        <div className="mb-[4px]">
          <div
            className="override-toggle dub-transcript-toggle__inner"
            onClick={() => setShowTranscript(!showTranscript)}
          >
            <span>
              <FileText size={10} className="align-middle mr-[3px]" /> {t('dub.transcript')}
            </span>
            {showTranscript ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
          {showTranscript && (
            <div className="bg-[var(--chrome-bg)] border border-[var(--chrome-border)] border-t-0 rounded-b-[var(--chrome-radius-pill)] p-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)] leading-[1.5] max-h-[80px] overflow-y-auto">
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
          className="inline-flex items-center px-[var(--space-3)] py-[3px] mb-[4px] font-[family-name:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] tracking-[var(--chrome-label-track)] uppercase text-[var(--chrome-fg-muted)] bg-transparent border border-[var(--chrome-border)] rounded-[var(--chrome-radius-pill)] cursor-pointer transition-colors hover:bg-[var(--chrome-hover-bg)] hover:border-[var(--chrome-border-strong)] hover:text-[var(--chrome-fg)]"
          onClick={() => {
            setGlossaryOpen(true);
            setGlossaryHidden(false);
          }}
          title={t('dub.glossary_title')}
        >
          {t('dub.glossary_btn', { count: glossaryTermCount })}
        </button>
      )}
      {dubJobId && glossaryVisible && (
        <div className="mb-[4px]">
          <GlossaryPanel
            projectId={dubJobId}
            sourceLang={dubLangCode && dubLang ? dubLang.slice(0, 2).toLowerCase() || 'en' : 'en'}
            targetLang={dubLangCode}
            segments={dubSegments}
            onChange={onGlossaryChange}
            onClose={() => {
              setGlossaryHidden(true);
              setGlossaryOpen(false);
            }}
          />
        </div>
      )}

      {/* "Apply Voice to All" row removed 2026-04-21 — redundant
                  with the CAST strip in the left column, which does the same
                  thing per-speaker (and handles the multi-speaker case cleanly). */}

      {selectedSegIds.size > 0 && (
        <div className="flex items-center gap-[var(--space-3)] px-[6px] py-[3px] rounded-[var(--radius-md)] mb-[var(--space-2)] text-[length:var(--text-xs)] bg-[rgba(211,134,155,0.08)] border border-[rgba(211,134,155,0.25)]">
          <span className="text-brand font-bold whitespace-nowrap">
            {t('dub.selected_count', { count: selectedSegIds.size })}
          </span>
          <select
            className={`${BULK_SELECT} min-w-[72px] flex-[1_1_100px]`}
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__clear__') bulkApplyToSelected({ profile_id: '' });
              else if (v) bulkApplyToSelected({ profile_id: v });
            }}
          >
            <option value="">{t('dub.set_voice')}</option>
            <option value="__clear__">{t('dub.clear_voice')}</option>
            {speakerClones && Object.keys(speakerClones).length > 0 && (
              <optgroup label={t('dub.cast')}>
                {Object.keys(speakerClones).map((spk) => {
                  const autoId = `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}`;
                  return (
                    <option key={autoId} value={autoId}>
                      🎤 {spk}
                    </option>
                  );
                })}
              </optgroup>
            )}
            {profiles.filter((p) => !p.instruct).length > 0 && (
              <optgroup label={t('dub.clone_profiles')}>
                {profiles
                  .filter((p) => !p.instruct)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </optgroup>
            )}
            {profiles.filter((p) => !!p.instruct).length > 0 && (
              <optgroup label={t('dub.design_presets')}>
                {profiles
                  .filter((p) => !!p.instruct)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
          <select
            className={`${BULK_SELECT} !w-auto min-w-[64px] flex-[0_1_90px]`}
            value=""
            onChange={(e) => {
              if (e.target.value === '__def__') bulkApplyToSelected({ target_lang: null });
              else if (e.target.value) bulkApplyToSelected({ target_lang: e.target.value });
            }}
          >
            <option value="">{t('dub.set_lang')}</option>
            <option value="__def__">{t('dub.default_lang')}</option>
            {LANG_CODES.map((lc) => (
              <option key={lc.code} value={lc.code}>
                {lc.code.toUpperCase()}
              </option>
            ))}
          </select>
          <Button variant="danger" size="sm" onClick={bulkDeleteSelected}>
            {t('dub.delete_selected')}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSegSelection} className="ml-auto">
            {t('dub.clear_selection')}
          </Button>
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
