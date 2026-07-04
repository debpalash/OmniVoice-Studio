import { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Loader,
  ChevronDown,
  ChevronUp,
  Globe,
  UserSquare2,
  Languages,
  Wand2,
  Download,
  Copy,
  ExternalLink,
  ArrowRightLeft,
} from 'lucide-react';
import { Button, Segmented, Progress } from '../../ui';
import { useAppStore } from '../../store';
import WaveformTimeline from '../WaveformTimeline';
import MultiLangPicker from '../MultiLangPicker';
import { API } from '../../api/client';
import { dubListTracks } from '../../api/dub';
import { LANG_CODES } from '../../utils/languages';
import ALL_LANGUAGES from '../../languages.json';
import { POPULAR_LANGS, PRESETS } from '../../utils/constants';
import { dialectOptionsFor, dialectLabel, dialectMatchesLang } from '../../api/dialects';
import { copyText } from '../../utils/copyText';
import { openExternal } from '../../api/external';
import { TRANSLATION_ENGINES_DOCS } from '../../utils/errorDocsMap';
import toast from 'react-hot-toast';

// ── Translation-settings bar utility class clusters ──────────────────────
const SETTINGS_SUMMARY =
  'flex items-center gap-[var(--space-2)] px-[var(--space-3)] py-[3px] mb-[3px] bg-[var(--chrome-bg)] border border-transparent rounded-[var(--chrome-radius-pill)] font-[family-name:var(--font-sans)] text-[0.66rem] text-[var(--chrome-fg-muted)]';
const SUMMARY_TRIGGER =
  'inline-flex items-center gap-[5px] flex-1 min-w-0 bg-transparent border-none text-fg-muted cursor-pointer py-[2px] px-0 [font:inherit] text-left';
const SETTINGS_BAR =
  'flex flex-col gap-[3px] max-[900px]:gap-[6px] mb-[4px] px-[8px] py-[4px] bg-[var(--chrome-bg)] border border-transparent rounded-[var(--chrome-radius-pill)]';
const FIELD = 'flex flex-col gap-[1px] min-w-0';
const FIELD_RESP = 'max-[960px]:basis-full max-[960px]:min-w-0';
const FIELD_LABEL =
  'label-row !text-[0.58rem] !text-fg-muted !m-0 whitespace-nowrap overflow-hidden text-ellipsis';
const FIELD_INPUT = 'input-base !w-full !text-[0.65rem] !px-[5px] !py-[3px]';
const ENGINE_CHIP =
  'ml-[6px] px-[6px] py-[1px] text-[0.55rem] leading-[1.4] bg-[color-mix(in_srgb,var(--color-brand)_14%,transparent)] border border-transparent text-[var(--color-brand)] rounded-[var(--radius-pill)] whitespace-nowrap transition-colors';
// Highlighted accent Install affordance — brand-filled pill, deliberately louder
// than ENGINE_CHIP so an uninstalled selected engine is an obvious call to action
// rather than a muted footnote.
const ENGINE_INSTALL_BTN =
  'inline-flex items-center gap-[3px] ml-[6px] px-[7px] py-[1px] text-[0.55rem] font-semibold leading-[1.5] bg-[var(--color-brand)] hover:bg-[var(--color-brand-hover)] text-[var(--color-fg-inverse)] border border-transparent rounded-[var(--radius-pill)] whitespace-nowrap cursor-pointer transition-colors shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-brand)_25%,transparent)] disabled:opacity-60 disabled:cursor-default';

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
  // High-quality (Cinematic/Autofit) translation needs an LLM. When one isn't
  // configured, we route the user straight to the LLM Providers setup instead
  // of dead-ending on a toast (#838).
  const openSettingsTab = useAppStore((s) => s.openSettingsTab);
  // Frozen-build (packaged/signed, read-only site-packages) escape-hatch
  // popover: pip install is impossible, so we surface the copyable command +
  // a one-click switch to the always-bundled Argos engine + a docs deeplink.
  const [installPopoverOpen, setInstallPopoverOpen] = useState(false);
  const installPopoverRef = useRef(null);
  useEffect(() => {
    if (!installPopoverOpen) return undefined;
    const onDown = (e) => {
      if (installPopoverRef.current && !installPopoverRef.current.contains(e.target)) {
        setInstallPopoverOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setInstallPopoverOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [installPopoverOpen]);
  // Command shown/copied in the frozen popover — single-sourced from the
  // backend registry (activeEngineEntry.install_command), with a defensive
  // fallback so the popover is never empty for a known-uninstalled engine.
  const installCmd =
    activeEngineEntry?.install_command ||
    (activeEngineEntry?.pip_package ? `uv pip install ${activeEngineEntry.pip_package}` : '');
  const copyInstallCmd = async () => {
    if (!installCmd) return;
    const ok = await copyText(installCmd);
    if (ok) toast.success(t('dub.install_cmd_copied'));
    else toast.error(t('dub.copy_failed'));
  };

  // Per-track metadata (duration + timing strategy) for the pill tooltips.
  // The store only carries the track codes, so hydrate lazily from the
  // existing GET /dub/tracks/{job_id} once the editor shows tracks (re-runs
  // when a new language finishes and dubTracks changes). Failure-silent:
  // the pills render fine without tooltips.
  const [trackInfo, setTrackInfo] = useState({});
  useEffect(() => {
    if (!hasDubbedTrack || !dubJobId) return undefined;
    let cancelled = false;
    dubListTracks(dubJobId)
      .then((tracks) => {
        if (!cancelled) setTrackInfo(tracks || {});
      })
      .catch(() => {
        /* tooltip enrichment only — never block or toast */
      });
    return () => {
      cancelled = true;
    };
  }, [hasDubbedTrack, dubJobId, dubTracks]);
  const trackTooltip = (code) => {
    const info = trackInfo[code];
    if (!info) return undefined;
    const parts = [];
    if (Number.isFinite(info.duration) && info.duration > 0) {
      parts.push(
        t('dub.track_tip_duration', {
          duration: fmtDur(Math.round(info.duration)),
          defaultValue: 'Duration {{duration}}',
        }),
      );
    }
    if (info.timing_strategy) {
      // Reuse the timing-strategy display names where they exist
      // (dub.timing_<id>); unknown/future strategies fall back to the raw id.
      const strategy = t(`dub.timing_${info.timing_strategy}`, {
        defaultValue: info.timing_strategy,
      });
      parts.push(t('dub.track_tip_timing', { strategy, defaultValue: 'Timing {{strategy}}' }));
    }
    return parts.length ? parts.join(' · ') : undefined;
  };

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
                title={trackTooltip(code)}
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
        <div className="mt-[2px] px-[var(--space-3)] py-[3px] bg-[var(--chrome-bg)] rounded-[var(--chrome-radius-pill)] border border-transparent">
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
              <div className={`${FIELD_LABEL} !overflow-visible flex items-center`}>
                {t('dub.engine_label')}
                {/* FROM-SOURCE lane: pip install works (uv pip install runs
                    in-process). Promote the muted chip to a highlighted accent
                    Install button so an uninstalled selected engine is an
                    obvious call to action. Keys off translateProvider, so
                    picking any uninstalled engine surfaces it immediately. */}
                {activeEngineUnavailable && !enginesSandboxed && (
                  <button
                    type="button"
                    className={ENGINE_INSTALL_BTN}
                    onClick={() => handleInstallEngine(translateProvider)}
                    disabled={engineInstalling === translateProvider}
                    title={t('dub.install_engine')}
                  >
                    {engineInstalling === translateProvider ? (
                      <>
                        <Loader className="spinner" size={9} /> {t('dub.installing_engine')}
                      </>
                    ) : (
                      <>
                        <Download size={9} />{' '}
                        {t('dub.install_engine_pkg', {
                          pkg: activeEngineEntry?.pip_package || '',
                        })}
                      </>
                    )}
                  </button>
                )}
                {/* FROZEN lane: packaged build, site-packages is read-only +
                    signed, so pip install is impossible. Offer a highlighted
                    button that opens a popover with the copyable command, a
                    one-click switch to bundled Argos, and a docs deeplink. */}
                {activeEngineUnavailable && enginesSandboxed && (
                  <span className="relative inline-flex" ref={installPopoverRef}>
                    <button
                      type="button"
                      className={ENGINE_INSTALL_BTN}
                      onClick={() => setInstallPopoverOpen((o) => !o)}
                      aria-haspopup="dialog"
                      aria-expanded={installPopoverOpen}
                      title={t('dub.install_disabled_title')}
                    >
                      <Download size={9} /> {t('dub.needs_install_short')}
                    </button>
                    {installPopoverOpen && (
                      <div
                        role="dialog"
                        aria-label={t('dub.install_popover_title')}
                        className="absolute z-20 top-[calc(100%+6px)] left-0 w-[290px] max-w-[80vw] p-[10px] flex flex-col gap-[8px] bg-[var(--chrome-bg,#282828)] border border-transparent rounded-[8px] shadow-[0_8px_24px_rgba(0,0,0,0.45)] normal-case text-left"
                      >
                        <div className="text-[0.68rem] font-semibold text-[var(--chrome-fg,#ebdbb2)] normal-case tracking-normal">
                          {t('dub.install_popover_title')}
                        </div>
                        <p className="text-[0.62rem] leading-[1.4] text-[var(--chrome-fg-muted,#a89984)] m-0">
                          {t('dub.install_popover_frozen_body')}
                        </p>
                        {installCmd && (
                          <div className="flex items-stretch gap-[4px]">
                            <code className="flex-1 min-w-0 px-[6px] py-[4px] text-[0.6rem] leading-[1.4] font-[family-name:var(--chrome-font-mono,monospace)] text-[var(--chrome-fg,#ebdbb2)] bg-[rgba(0,0,0,0.35)] border border-transparent rounded-[5px] overflow-x-auto whitespace-nowrap">
                              {installCmd}
                            </code>
                            <button
                              type="button"
                              className="shrink-0 inline-flex items-center justify-center px-[6px] rounded-[5px] border border-transparent text-[var(--chrome-fg-muted,#a89984)] hover:text-[var(--chrome-fg,#ebdbb2)] hover:border-transparent cursor-pointer bg-transparent"
                              onClick={copyInstallCmd}
                              title={t('dub.copy_command')}
                              aria-label={t('dub.copy_command')}
                            >
                              <Copy size={11} />
                            </button>
                          </div>
                        )}
                        <button
                          type="button"
                          className="inline-flex items-center justify-center gap-[5px] px-[8px] py-[5px] text-[0.64rem] font-semibold bg-[var(--color-brand)] hover:bg-[var(--color-brand-hover)] text-[var(--color-fg-inverse)] border-none rounded-[var(--radius-lg)] cursor-pointer transition-colors"
                          onClick={() => {
                            setTranslateProvider('argos');
                            setInstallPopoverOpen(false);
                          }}
                        >
                          <ArrowRightLeft size={11} /> {t('dub.switch_to_argos')}
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-[5px] self-start text-[0.6rem] text-[var(--chrome-fg-muted,#a89984)] hover:text-[var(--chrome-fg,#ebdbb2)] bg-transparent border-none cursor-pointer p-0"
                          onClick={() => openExternal(TRANSLATION_ENGINES_DOCS)}
                        >
                          <ExternalLink size={10} /> {t('dub.open_docs')}
                        </button>
                      </div>
                    )}
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
                  // #372/#838: Cinematic AND Autofit need an LLM (Autofit rewrites
                  // each line to fit its segment's time budget). If none is
                  // configured, don't dead-end — offer a one-click jump to the
                  // LLM Providers setup and point at the timing payoff.
                  const needsLLM = v === 'cinematic' || v === 'autofit';
                  if (needsLLM && llmEndpoint && !llmEndpoint.available) {
                    toast(
                      (tt) => (
                        <span className="flex items-center gap-[10px]">
                          {t('dub.hq_needs_llm_hint', {
                            defaultValue:
                              'High-quality translation fits each line to its segment time using a local or cloud LLM. Set one up to enable it.',
                          })}
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              toast.dismiss(tt.id);
                              openSettingsTab('llm-providers');
                            }}
                          >
                            {t('dub.set_up_llm', { defaultValue: 'Set up' })}
                          </Button>
                        </span>
                      ),
                      { icon: 'ℹ️', duration: 10000 },
                    );
                    return;
                  }
                  setTranslateQuality(v);
                }}
                items={[
                  { value: 'fast', label: t('dub.fast_quality') },
                  {
                    value: 'autofit',
                    label: t('dub.autofit_quality', { defaultValue: 'Autofit' }),
                  },
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
            <div className={`${FIELD} basis-full pt-[3px] border-t border-transparent mt-[1px]`}>
              <label className="flex items-center gap-[6px] text-[0.65rem] text-[var(--chrome-fg-muted)] cursor-pointer mb-[2px]">
                <input
                  type="checkbox"
                  className="accent-[var(--color-brand)] cursor-pointer"
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
