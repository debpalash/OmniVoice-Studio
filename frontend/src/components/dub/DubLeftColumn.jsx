import { Sparkles, Loader, ChevronDown, ChevronUp, Globe, UserSquare2, Languages, Wand2 } from 'lucide-react';
import { Button, Segmented, Progress } from '../../ui';
import WaveformTimeline from '../WaveformTimeline';
import MultiLangPicker from '../MultiLangPicker';
import { API } from '../../api/client';
import { LANG_CODES } from '../../utils/languages';
import ALL_LANGUAGES from '../../languages.json';
import { POPULAR_LANGS, PRESETS } from '../../utils/constants';
import { dialectOptionsFor, dialectLabel, dialectMatchesLang } from '../../api/dialects';
import toast from 'react-hot-toast';

export default function DubLeftColumn({ hasDubbedTrack, t, previewMode, setPreviewMode, dubTracks, videoSrc, waveformRef, dubJobId, dubSegments, timelineOnsets, timelineSelSegId, setTimelineSelSegId, incrementalPlan, segmentMoveResize, segmentDelete, onTimelinePreviewSegment, dubStep, dubProgress, fmtDur, genElapsed, genRemaining, speakerClones, setDubSegments, profiles, settingsOpen, setSettingsOpen, dubLang, dubLangCode, translateQuality, activeEngineUnavailable, translateProvider, dubInstruct, setDubInstruct, handleTranslateAll, isTranslating, hasAnyTranslation, handleCleanupSegments, setDubLang, setDubLangCode, dubDialect, setDubDialect, i18n, enginesSandboxed, handleInstallEngine, engineInstalling, activeEngineEntry, engines, setTranslateProvider, setTranslateQuality, llmEndpoint, multiLangMode, setMultiLangMode, multiLangs, setMultiLangs, editSegments }) {
  return (
            <div className="studio-panel dub-panel-col">
              {hasDubbedTrack && (
                <div className="dub-lang-switch" role="radiogroup" aria-label={t('dub.preview_language', { defaultValue: 'Preview language' })}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={previewMode === 'original'}
                    className={`dub-lang-pill ${previewMode === 'original' ? 'is-active' : ''}`}
                    onClick={() => setPreviewMode('original')}
                  >
                    {t('dub.original_audio')}
                  </button>
                  {dubTracks.map(code => {
                    const label = LANG_CODES.find(lc => lc.code === code)?.label || code.toUpperCase();
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
                overlayContent={(dubStep === 'generating' || dubStep === 'stopping') ? (
                  <div className="dub-gen-overlay">
                    <div className="dub-gen-overlay__head">
                      {dubStep === 'stopping' ? <Loader className="spinner" size={14} color="#a89984" /> : <Sparkles className="spinner" size={14} color="#d3869b" />}
                      <span className={`dub-gen-overlay__title ${dubStep === 'stopping' ? 'is-stopping' : ''}`}>
                        {dubStep === 'stopping' ? t('dub.stopping') : t('dub.generate_dub') + ` ${dubProgress.current}/${dubProgress.total}…`}
                      </span>
                    </div>
                    {dubStep === 'generating' && (
                      <>
                        <div className="dub-gen-overlay__stats">
                          <span>⏱ {fmtDur(genElapsed)} {t('dub.elapsed')}</span>
                          {genRemaining !== null && <span>~{fmtDur(genRemaining)} {t('dub.remaining')}</span>}
                        </div>
                        <div className="dub-gen-overlay__bar">
                          <Progress
                            value={dubProgress.total ? (dubProgress.current / dubProgress.total) * 100 : 0}
                            tone="brand"
                            size="sm"
                          />
                        </div>
                        {dubProgress.text && <span className="dub-gen-overlay__text">{dubProgress.text}</span>}
                      </>
                    )}
                  </div>
                ) : null}
              />

              {/* Cast — per-speaker voice assignment. When the auto-clone
                  extractor found a usable passage per speaker (≥5s from the
                  isolated vocals), that option becomes first-class in the
                  dropdown. It's also pre-selected on the segments so "new
                  language = same speaker's voice" works by default. */}
              {dubSegments.some(s => s.speaker_id) && (
                <div className="dub-cast">
                  <div className="dub-cast__row">
                    <span className="dub-cast__kicker" title={t('dub.cast_title')}>{t('dub.cast')}</span>
                    {[...new Set(dubSegments.map(s => s.speaker_id).filter(Boolean))].map(spk => {
                      const autoId = `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}`;
                      const clone = speakerClones[spk];
                      return (
                        <div key={spk} className="dub-cast__pair">
                          <span className="dub-cast__label">{spk}:</span>
                          <select className="input-base dub-cast__select"
                            value={dubSegments.find(s => s.speaker_id === spk)?.profile_id || ''}
                            onChange={e => {
                              const val = e.target.value;
                              setDubSegments(dubSegments.map(s => s.speaker_id === spk ? { ...s, profile_id: val } : s));
                            }}>
                            {clone && (
                              <option value={autoId}>{t('dub.from_video', { duration: clone.duration.toFixed(1) })}</option>
                            )}
                            <option value="">{t('dub.default')}</option>
                            {profiles.length > 0 && (
                              <optgroup label={t('dub.clone_profiles')}>
                                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </optgroup>
                            )}
                            {PRESETS.length > 0 && (
                              <optgroup label={t('dub.design_presets')}>
                                {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>)}
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
                <div className="dub-settings-summary">
                  <button
                    type="button"
                    className="dub-settings-summary__trigger"
                    onClick={() => setSettingsOpen(true)}
                    title={t('dub.edit_settings')}
                  >
                    <ChevronDown size={10} />
                    <span><strong>{dubLang}</strong> · {dubLangCode} · {translateQuality} · <span style={{ color: activeEngineUnavailable ? '#fb4934' : '#b8bb26' }}>●</span> {translateProvider}</span>
                    {dubInstruct && <span className="dub-settings-summary__style">{t('dub.style_label_prefix')}{dubInstruct}</span>}
                  </button>
                  <Button
                    variant="subtle" size="sm"
                    onClick={handleTranslateAll}
                    disabled={isTranslating || !dubSegments.length}
                    loading={isTranslating}
                    leading={!isTranslating && <Languages size={10} />}
                  >
                    {isTranslating ? t('dub.translating') : hasAnyTranslation ? t('dub.retranslate') : t('dub.translate_all')}
                  </Button>
                  <Button
                    variant="subtle" size="sm"
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
              <div className="dub-settings-bar">
                <div className="dub-settings-bar__fields">
                  <button
                    type="button"
                    className="dub-settings-summary__trigger dub-settings-close"
                    onClick={() => setSettingsOpen(false)}
                    title={t('dub.collapse_settings')}
                  >
                    <ChevronUp size={10} />
                  </button>
                  <div className="dub-settings-field dub-settings-field--lang">
                    <div className="label-row"><Globe className="label-icon" size={9} /> {t('dub.language')}</div>
                    <select
                      className="input-base dub-cast__select"
                      value={dubLang}
                      onChange={(e) => {
                        const lang = e.target.value;
                        setDubLang(lang);
                        const match = LANG_CODES.find(lc => lc.label.toLowerCase() === lang.toLowerCase());
                        if (match) {
                          setDubLangCode(match.code);
                          // #280: a dialect belongs to one language — clear it
                          // whenever the new target doesn't match.
                          if (!dialectMatchesLang(dubDialect, match.code)) setDubDialect('');
                        }
                      }}
                    >
                      <optgroup label={t('dub.popular')}>
                        {POPULAR_LANGS.map(l => <option key={`p-${l}`} value={l}>{l}</option>)}
                      </optgroup>
                      <optgroup label={t('dub.all_languages')}>
                        {ALL_LANGUAGES
                          .filter(l => !POPULAR_LANGS.includes(l))
                          .map(l => <option key={l} value={l}>{l}</option>)}
                      </optgroup>
                    </select>
                  </div>
                  <div className="dub-settings-field dub-settings-field--iso">
                    <div className="label-row">{t('dub.iso_code')}</div>
                    <select
                      className="input-base dub-cast__select"
                      value={dubLangCode}
                      onChange={(e) => {
                        const code = e.target.value;
                        setDubLangCode(code);
                        if (!dialectMatchesLang(dubDialect, code)) setDubDialect('');
                      }}
                    >
                      {LANG_CODES.map(lc => (
                        <option key={lc.code} value={lc.code}>{lc.code} — {lc.label}</option>
                      ))}
                    </select>
                  </div>
                  {/* #280: regional dialect / vocabulary. Only rendered for
                      languages with curated variants; region names come from
                      Intl.DisplayNames so they localize with the UI for free. */}
                  {dialectOptionsFor(dubLangCode).length > 0 && (
                    <div className="dub-settings-field dub-settings-field--dialect">
                      <div className="label-row" title={t('dub.dialect_title')}>{t('dub.dialect_label')}</div>
                      <select
                        className="input-base dub-cast__select"
                        value={dialectMatchesLang(dubDialect, dubLangCode) ? dubDialect : ''}
                        onChange={(e) => setDubDialect(e.target.value)}
                      >
                        <option value="">{t('dub.dialect_default')}</option>
                        {dialectOptionsFor(dubLangCode).map(d => (
                          <option key={d} value={d}>{dialectLabel(d, i18n.language)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="dub-settings-field dub-settings-field--engine">
                    <div className="label-row">
                      {t('dub.engine_label')}
                      {activeEngineUnavailable && !enginesSandboxed && (
                        <button
                          type="button"
                          className="dub-engine-install-chip"
                          onClick={() => handleInstallEngine(translateProvider)}
                          disabled={engineInstalling === translateProvider}
                          title={t('dub.install_engine')}
                        >
                          {engineInstalling === translateProvider ? t('dub.installing_engine') : `+ install ${activeEngineEntry?.pip_package || ''}`}
                        </button>
                      )}
                      {activeEngineUnavailable && enginesSandboxed && (
                        <span className="dub-engine-install-chip dub-engine-install-chip--disabled" title={t('dub.install_disabled_title')}>
                          {t('dub.needs_dev_install')}
                        </span>
                      )}
                    </div>
                    <select className="input-base dub-engine-select" value={translateProvider} onChange={e => setTranslateProvider(e.target.value)}>
                      {(engines.length ? engines : []).map(p => (
                        <option key={p.id} value={p.id}>
                          {p.installed ? p.display_name : `${p.display_name}${t('dub.needs_install_suffix')}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="dub-settings-field dub-settings-field--quality">
                    <div className="label-row" title={t('dub.quality_title')}>{t('dub.quality_label')}</div>
                    <Segmented
                      size="sm"
                      value={translateQuality}
                      onChange={(v) => {
                        // #372: picking Cinematic with no LLM configured used to
                        // bounce the user between two warnings forever. Block the
                        // pick at the source and point at the actual fix.
                        if (v === 'cinematic' && llmEndpoint && !llmEndpoint.available) {
                          toast(t('dub.cinematic_needs_llm_hint', { defaultValue: 'Cinematic needs an LLM. Configure one in Settings → Credentials → LLM endpoint (Ollama runs locally, no key needed).' }), { icon: 'ℹ️', duration: 8000 });
                          return;
                        }
                        setTranslateQuality(v);
                      }}
                      items={[
                        { value: 'fast',      label: t('dub.fast_quality') },
                        { value: 'cinematic', label: t('dub.cinematic_quality') },
                      ]}
                    />
                  </div>
                  <div className="dub-settings-field dub-settings-field--style">
                    <div className="label-row"><UserSquare2 className="label-icon" size={9} /> {t('dub.style')} <span className="dub-settings-field__hint">{t('dub.optional')}</span></div>
                    <input className="input-base input-base--xs" placeholder={t('dub.style_placeholder')} value={dubInstruct} onChange={e => setDubInstruct(e.target.value)} />
                  </div>
                  <div className="dub-settings-field dub-settings-field--multi">
                    <label className="dub-multi-toggle">
                      <input
                        type="checkbox"
                        checked={multiLangMode}
                        onChange={e => setMultiLangMode(e.target.checked)}
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
                <div className="dub-settings-bar__actions">
                  <Button
                    variant="subtle" size="sm"
                    onClick={() => editSegments(dubSegments.map(s => ({ ...s, text: s.text_original || s.text, translate_error: undefined })))}
                    disabled={!dubSegments.some(s => s.text_original && s.text_original !== s.text)}
                    title={t('dub.restore_title')}
                  >
                    {t('dub.restore')}
                  </Button>
                  <Button
                    variant="subtle" size="sm"
                    onClick={handleCleanupSegments}
                    disabled={!dubSegments.length || !dubJobId}
                    title={t('dub.clean_up_title')}
                    leading={<Wand2 size={10} />}
                  >
                    {t('dub.clean_up')}
                  </Button>
                  <Button
                    variant="primary" size="sm"
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
