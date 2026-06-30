import {
  Sparkles,
  Loader,
  ChevronDown,
  ChevronUp,
  Globe,
  UserSquare2,
  Languages,
  Wand2,
} from 'lucide-react';
import { Button, Segmented, Progress } from '../../ui';
import WaveformTimeline from '../WaveformTimeline';
import MultiLangPicker from '../MultiLangPicker';
import { API } from '../../api/client';
import { LANG_CODES } from '../../utils/languages';
import ALL_LANGUAGES from '../../languages.json';
import { POPULAR_LANGS, PRESETS } from '../../utils/constants';
import { dialectOptionsFor, dialectLabel, dialectMatchesLang } from '../../api/dialects';
import toast from 'react-hot-toast';

// ── Translation-settings bar utility class clusters ──────────────────────
const SETTINGS_SUMMARY =
  'flex items-center gap-[var(--space-2)] px-[var(--space-3)] py-[3px] mb-[3px] bg-[var(--chrome-bg)] border border-[var(--chrome-border)] rounded-[var(--chrome-radius-pill)] font-[family-name:var(--font-sans)] text-[0.66rem] text-[var(--chrome-fg-muted)]';
const SUMMARY_TRIGGER =
  'inline-flex items-center gap-[5px] flex-1 min-w-0 bg-transparent border-none text-fg-muted cursor-pointer py-[2px] px-0 [font:inherit] text-left';
const SETTINGS_BAR =
  'flex flex-col gap-[3px] max-[900px]:gap-[6px] mb-[4px] px-[8px] py-[4px] bg-[var(--chrome-bg)] border border-[var(--chrome-border)] rounded-[var(--chrome-radius-pill)]';
const FIELD = 'flex flex-col gap-[1px] min-w-0';
const FIELD_RESP = 'max-[960px]:basis-full max-[960px]:min-w-0';
const FIELD_LABEL =
  'label-row !text-[0.58rem] !text-fg-muted !m-0 whitespace-nowrap overflow-hidden text-ellipsis';
const FIELD_INPUT = 'input-base !w-full !text-[0.65rem] !px-[5px] !py-[3px]';
const ENGINE_CHIP =
  'ml-[6px] px-[6px] py-[1px] text-[0.55rem] leading-[1.4] bg-[rgba(211,134,155,0.14)] border border-[rgba(211,134,155,0.35)] text-[#d3869b] rounded-[999px] whitespace-nowrap transition-colors';

export default function DubLeftColumn({
  hasDubbedTrack,
  t,
  previewMode,
  setPreviewMode,
  dubTracks,
  videoSrc,
  waveformRef,
  dubJobId,
  dubSegments,
  timelineOnsets,
  timelineSelSegId,
  setTimelineSelSegId,
  incrementalPlan,
  segmentMoveResize,
  segmentDelete,
  onTimelinePreviewSegment,
  dubStep,
  dubProgress,
  fmtDur,
  genElapsed,
  genRemaining,
  speakerClones,
  setDubSegments,
  profiles,
  settingsOpen,
  setSettingsOpen,
  dubLang,
  dubLangCode,
  translateQuality,
  activeEngineUnavailable,
  translateProvider,
  dubInstruct,
  setDubInstruct,
  handleTranslateAll,
  isTranslating,
  hasAnyTranslation,
  handleCleanupSegments,
  setDubLang,
  setDubLangCode,
  dubDialect,
  setDubDialect,
  i18n,
  enginesSandboxed,
  handleInstallEngine,
  engineInstalling,
  activeEngineEntry,
  engines,
  setTranslateProvider,
  setTranslateQuality,
  llmEndpoint,
  multiLangMode,
  setMultiLangMode,
  multiLangs,
  setMultiLangs,
  editSegments,
}) {
  return (
    <div className="studio-panel dub-panel-col">
      {hasDubbedTrack && (
        <div
          className="dub-lang-switch"
          role="radiogroup"
          aria-label={t('dub.preview_language', { defaultValue: 'Preview language' })}
        >
          <button
            type="button"
            role="radio"
            aria-checked={previewMode === 'original'}
            className={`dub-lang-pill ${previewMode === 'original' ? 'is-active' : ''}`}
            onClick={() => setPreviewMode('original')}
          >
            {t('dub.original_audio')}
          </button>
          {dubTracks.map((code) => {
            const label = LANG_CODES.find((lc) => lc.code === code)?.label || code.toUpperCase();
            return (
              <button
                key={code}
                type="button"
                role="radio"
                aria-checked={previewMode === code}
                className={`dub-lang-pill ${previewMode === code ? 'is-active' : ''}`}
                onClick={() => setPreviewMode(code)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <WaveformTimeline
        key={videoSrc}
        ref={waveformRef}
        audioSrc={`${API}/dub/audio/${dubJobId}`}
        videoSrc={videoSrc}
        segments={dubSegments}
        onsets={timelineOnsets}
        selectedSegId={timelineSelSegId}
        onSelectSeg={setTimelineSelSegId}
        incrementalPlan={incrementalPlan}
        onSegmentCommit={segmentMoveResize}
        onSegmentDelete={segmentDelete}
        onPreviewSegment={onTimelinePreviewSegment}
        disabled={dubStep === 'generating' || dubStep === 'stopping'}
        overlayContent={
          dubStep === 'generating' || dubStep === 'stopping' ? (
            <div className="flex flex-col items-center gap-[6px] w-full p-[10px] backdrop-blur-[2px]">
              <div className="flex items-center gap-[6px]">
                {dubStep === 'stopping' ? (
                  <Loader className="spinner" size={14} color="#a89984" />
                ) : (
                  <Sparkles className="spinner" size={14} color="#d3869b" />
                )}
                <span
                  className={`font-semibold text-[0.75rem] [font-variant-numeric:tabular-nums] tracking-[0.01em] ${dubStep === 'stopping' ? 'text-fg-muted' : 'text-fg'}`}
                >
                  {dubStep === 'stopping'
                    ? t('dub.stopping')
                    : t('dub.generate_dub') + ` ${dubProgress.current}/${dubProgress.total}…`}
                </span>
              </div>
              {dubStep === 'generating' && (
                <>
                  <div className="flex gap-[var(--space-4)] text-[0.65rem] text-fg-muted [font-variant-numeric:tabular-nums]">
                    <span>
                      ⏱ {fmtDur(genElapsed)} {t('dub.elapsed')}
                    </span>
                    {genRemaining !== null && (
                      <span>
                        ~{fmtDur(genRemaining)} {t('dub.remaining')}
                      </span>
                    )}
                  </div>
                  <div className="w-[80%] max-w-[240px] my-[1px]">
                    <Progress
                      value={
                        dubProgress.total ? (dubProgress.current / dubProgress.total) * 100 : 0
                      }
                      tone="brand"
                      size="sm"
                    />
                  </div>
                  {dubProgress.text && (
                    <span className="text-[0.62rem] text-fg-muted">{dubProgress.text}</span>
                  )}
                </>
              )}
            </div>
          ) : null
        }
      />

      {/* Cast — per-speaker voice assignment. When the auto-clone
                  extractor found a usable passage per speaker (≥5s from the
                  isolated vocals), that option becomes first-class in the
                  dropdown. It's also pre-selected on the segments so "new
                  language = same speaker's voice" works by default. */}
      {dubSegments.some((s) => s.speaker_id) && (
        <div className="mt-[2px] px-[var(--space-3)] py-[3px] bg-[var(--chrome-bg)] rounded-[var(--chrome-radius-pill)] border border-[var(--chrome-border)]">
          <div className="flex gap-[var(--space-2)] items-center flex-wrap">
            <span
              className="font-[family-name:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] text-[var(--chrome-fg-muted)] tracking-[var(--chrome-label-track)] uppercase font-semibold"
              title={t('dub.cast_title')}
            >
              {t('dub.cast')}
            </span>
            {[...new Set(dubSegments.map((s) => s.speaker_id).filter(Boolean))].map((spk) => {
              const autoId = `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}`;
              const clone = speakerClones[spk];
              return (
                <div key={spk} className="dub-cast__pair">
                  <span className="font-[family-name:var(--chrome-font-mono)] text-[0.62rem] text-[var(--chrome-fg)]">
                    {spk}:
                  </span>
                  <select
                    className="input-base dub-cast__select"
                    value={dubSegments.find((s) => s.speaker_id === spk)?.profile_id || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDubSegments(
                        dubSegments.map((s) =>
                          s.speaker_id === spk ? { ...s, profile_id: val } : s,
                        ),
                      );
                    }}
                  >
                    {clone && (
                      <option value={autoId}>
                        {t('dub.from_video', { duration: clone.duration.toFixed(1) })}
                      </option>
                    )}
                    <option value="">{t('dub.default')}</option>
                    {profiles.length > 0 && (
                      <optgroup label={t('dub.clone_profiles')}>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {PRESETS.length > 0 && (
                      <optgroup label={t('dub.design_presets')}>
                        {PRESETS.map((p) => (
                          <option key={p.id} value={`preset:${p.id}`}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Translation settings — collapsed or expanded */}
      {!settingsOpen && (
        <div className={SETTINGS_SUMMARY}>
          <button
            type="button"
            className={SUMMARY_TRIGGER}
            onClick={() => setSettingsOpen(true)}
            title={t('dub.edit_settings')}
          >
            <ChevronDown size={10} />
            <span>
              <strong className="text-[var(--chrome-fg)] font-semibold">{dubLang}</strong> ·{' '}
              {dubLangCode} · {translateQuality} ·{' '}
              <span style={{ color: activeEngineUnavailable ? '#fb4934' : '#b8bb26' }}>●</span>{' '}
              {translateProvider}
            </span>
            {dubInstruct && (
              <span className="text-[var(--chrome-fg-dim)] italic ml-[var(--space-2)]">
                {t('dub.style_label_prefix')}
                {dubInstruct}
              </span>
            )}
          </button>
          <Button
            variant="subtle"
            size="sm"
            onClick={handleTranslateAll}
            disabled={isTranslating || !dubSegments.length}
            loading={isTranslating}
            leading={!isTranslating && <Languages size={10} />}
          >
            {isTranslating
              ? t('dub.translating')
              : hasAnyTranslation
                ? t('dub.retranslate')
                : t('dub.translate_all')}
          </Button>
          <Button
            variant="subtle"
            size="sm"
            onClick={handleCleanupSegments}
            disabled={!dubSegments.length || !dubJobId}
            title={t('dub.clean_up_title')}
            leading={<Wand2 size={10} />}
          >
            {t('dub.clean_up')}
          </Button>
        </div>
      )}
      {settingsOpen && (
        <div className={SETTINGS_BAR}>
          <div className="flex flex-wrap gap-x-[6px] gap-y-[4px] items-end">
            <button
              type="button"
              className={`${SUMMARY_TRIGGER} flex-[0_0_auto] !px-[4px] self-center`}
              onClick={() => setSettingsOpen(false)}
              title={t('dub.collapse_settings')}
            >
              <ChevronUp size={10} />
            </button>
            <div className={`${FIELD} flex-[1_1_100px] min-w-[70px] ${FIELD_RESP}`}>
              <div className={FIELD_LABEL}>
                <Globe className="label-icon" size={9} /> {t('dub.language')}
              </div>
              <select
                className={FIELD_INPUT}
                value={dubLang}
                onChange={(e) => {
                  const lang = e.target.value;
                  setDubLang(lang);
                  const match = LANG_CODES.find(
                    (lc) => lc.label.toLowerCase() === lang.toLowerCase(),
                  );
                  if (match) {
                    setDubLangCode(match.code);
                    // #280: a dialect belongs to one language — clear it
                    // whenever the new target doesn't match.
                    if (!dialectMatchesLang(dubDialect, match.code)) setDubDialect('');
                  }
                }}
              >
                <optgroup label={t('dub.popular')}>
                  {POPULAR_LANGS.map((l) => (
                    <option key={`p-${l}`} value={l}>
                      {l}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={t('dub.all_languages')}>
                  {ALL_LANGUAGES.filter((l) => !POPULAR_LANGS.includes(l)).map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className={`${FIELD} flex-[0_1_72px] min-w-[52px] ${FIELD_RESP}`}>
              <div className={FIELD_LABEL}>{t('dub.iso_code')}</div>
              <select
                className={FIELD_INPUT}
                value={dubLangCode}
                onChange={(e) => {
                  const code = e.target.value;
                  setDubLangCode(code);
                  if (!dialectMatchesLang(dubDialect, code)) setDubDialect('');
                }}
              >
                {LANG_CODES.map((lc) => (
                  <option key={lc.code} value={lc.code}>
                    {lc.code} — {lc.label}
                  </option>
                ))}
              </select>
            </div>
            {/* #280: regional dialect / vocabulary. Only rendered for
                      languages with curated variants; region names come from
                      Intl.DisplayNames so they localize with the UI for free. */}
            {dialectOptionsFor(dubLangCode).length > 0 && (
              <div className={`${FIELD} flex-[0_1_110px] min-w-[80px] ${FIELD_RESP}`}>
                <div className={FIELD_LABEL} title={t('dub.dialect_title')}>
                  {t('dub.dialect_label')}
                </div>
                <select
                  className={FIELD_INPUT}
                  value={dialectMatchesLang(dubDialect, dubLangCode) ? dubDialect : ''}
                  onChange={(e) => setDubDialect(e.target.value)}
                >
                  <option value="">{t('dub.dialect_default')}</option>
                  {dialectOptionsFor(dubLangCode).map((d) => (
                    <option key={d} value={d}>
                      {dialectLabel(d, i18n.language)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className={`${FIELD} flex-[1.4_1_130px] min-w-[90px] ${FIELD_RESP}`}>
              <div className={FIELD_LABEL}>
                {t('dub.engine_label')}
                {activeEngineUnavailable && !enginesSandboxed && (
                  <button
                    type="button"
                    className={`${ENGINE_CHIP} cursor-pointer hover:bg-[rgba(211,134,155,0.22)] disabled:opacity-55 disabled:cursor-default disabled:italic`}
                    onClick={() => handleInstallEngine(translateProvider)}
                    disabled={engineInstalling === translateProvider}
                    title={t('dub.install_engine')}
                  >
                    {engineInstalling === translateProvider
                      ? t('dub.installing_engine')
                      : `+ install ${activeEngineEntry?.pip_package || ''}`}
                  </button>
                )}
                {activeEngineUnavailable && enginesSandboxed && (
                  <span
                    className={`${ENGINE_CHIP} opacity-55 cursor-default italic`}
                    title={t('dub.install_disabled_title')}
                  >
                    {t('dub.needs_dev_install')}
                  </span>
                )}
              </div>
              <select
                className={FIELD_INPUT}
                value={translateProvider}
                onChange={(e) => setTranslateProvider(e.target.value)}
              >
                {(engines.length ? engines : []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.installed
                      ? p.display_name
                      : `${p.display_name}${t('dub.needs_install_suffix')}`}
                  </option>
                ))}
              </select>
            </div>
            <div className={`${FIELD} flex-[0_1_auto] min-w-[80px] ${FIELD_RESP}`}>
              <div className={FIELD_LABEL} title={t('dub.quality_title')}>
                {t('dub.quality_label')}
              </div>
              <Segmented
                className="w-full"
                size="sm"
                value={translateQuality}
                onChange={(v) => {
                  // #372: picking Cinematic with no LLM configured used to
                  // bounce the user between two warnings forever. Block the
                  // pick at the source and point at the actual fix.
                  if (v === 'cinematic' && llmEndpoint && !llmEndpoint.available) {
                    toast(
                      t('dub.cinematic_needs_llm_hint', {
                        defaultValue:
                          'Cinematic needs an LLM. Configure one in Settings → Credentials → LLM endpoint (Ollama runs locally, no key needed).',
                      }),
                      { icon: 'ℹ️', duration: 8000 },
                    );
                    return;
                  }
                  setTranslateQuality(v);
                }}
                items={[
                  { value: 'fast', label: t('dub.fast_quality') },
                  { value: 'cinematic', label: t('dub.cinematic_quality') },
                ]}
              />
            </div>
            <div className={`${FIELD} flex-[1_1_90px] min-w-[64px] ${FIELD_RESP}`}>
              <div className={FIELD_LABEL}>
                <UserSquare2 className="label-icon" size={9} /> {t('dub.style')}{' '}
                <span className="text-[0.52rem] text-fg-subtle italic ml-[2px]">
                  {t('dub.optional')}
                </span>
              </div>
              <input
                className={FIELD_INPUT}
                placeholder={t('dub.style_placeholder')}
                value={dubInstruct}
                onChange={(e) => setDubInstruct(e.target.value)}
              />
            </div>
            <div
              className={`${FIELD} basis-full pt-[3px] border-t border-[var(--chrome-border)] mt-[1px]`}
            >
              <label className="flex items-center gap-[6px] text-[0.65rem] text-[var(--chrome-fg-muted)] cursor-pointer mb-[2px]">
                <input
                  type="checkbox"
                  className="accent-[var(--chrome-accent)] cursor-pointer"
                  checked={multiLangMode}
                  onChange={(e) => setMultiLangMode(e.target.checked)}
                />
                <span>{t('dub.multi_lang')}</span>
              </label>
              {multiLangMode && (
                <MultiLangPicker
                  selected={multiLangs}
                  onChange={setMultiLangs}
                  disabled={dubStep === 'generating'}
                />
              )}
            </div>
          </div>
          <div className="flex justify-end gap-[6px] flex-wrap">
            <Button
              variant="subtle"
              size="sm"
              onClick={() =>
                editSegments(
                  dubSegments.map((s) => ({
                    ...s,
                    text: s.text_original || s.text,
                    translate_error: undefined,
                  })),
                )
              }
              disabled={!dubSegments.some((s) => s.text_original && s.text_original !== s.text)}
              title={t('dub.restore_title')}
            >
              {t('dub.restore')}
            </Button>
            <Button
              variant="subtle"
              size="sm"
              onClick={handleCleanupSegments}
              disabled={!dubSegments.length || !dubJobId}
              title={t('dub.clean_up_title')}
              leading={<Wand2 size={10} />}
            >
              {t('dub.clean_up')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleTranslateAll}
              disabled={isTranslating || !dubSegments.length}
              loading={isTranslating}
              leading={!isTranslating && <Languages size={10} />}
            >
              {isTranslating ? t('dub.translating') : t('dub.translate_all')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
