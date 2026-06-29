import { Film, Save, RotateCcw, AlertCircle, Sparkles, FileText, Loader, Users, UploadCloud, Link2, Globe, ChevronUp, ChevronDown, UserSquare2, Languages, Trash2, Play, Download } from 'lucide-react';
import { Button, Badge } from '../../ui';
import WaveformTimeline from '../WaveformTimeline';
import DubbingDemo from '../DubbingDemo';
import DubFailureNotice from './DubFailureNotice';
import PrepOverlay from './PrepOverlay';
import TranscribeOverlay from './TranscribeOverlay';
import { LANG_CODES } from '../../utils/languages';

export default function IdleSkeleton({ t, dubVideoFile, activeProjectName, dubFilename, dubError, dubJobId, dubStep, dubFailure, handleDubRetryTranscribe, handleDubImportSrt, dubLocalBlobUrl, dubPrepStage, dubPrepProgress, handleDubAbort, transcribeElapsed, dubDuration, dubNumSpeakers, setDubNumSpeakers, handleDubUpload, demoDismissed, dismissDubDemo, setDubVideoFile, setDubInputType, setDubStep, fileToMediaUrl, setDubLocalBlobUrl, ingestUrl, setIngestUrl, onIngestUrl, fetchYtSubs, setFetchYtSubs, dubLangCode, setDubLangCode, setDubLang, landingAdvOpen, setLandingAdvOpen, dubInstruct, setDubInstruct }) {
  return (
        <div className="dub-col">
          {/* Header bar */}
          <div className="dub-head">
            <div className="label-row dub-head__title">
                <Film className="label-icon" size={11} />
                <span className="dub-head__filename">{dubVideoFile ? dubVideoFile.name : t('dub.video_dubbing_studio')}</span>
              {dubVideoFile && <span className="dub-head__meta">· {(dubVideoFile.size / 1024 / 1024).toFixed(1)} MB</span>}
              {activeProjectName && activeProjectName !== dubFilename && (
                <span className="dub-head__project">— {activeProjectName}</span>
              )}
            </div>
            <div className="dub-head__actions">
              <Button variant="subtle" size="sm" disabled title={t('dub.save')} aria-label={t('dub.save')}><Save size={12} /></Button>
              <Button variant="ghost" size="sm" disabled title={t('dub.reset')} aria-label={t('dub.reset')}><RotateCcw size={12} /></Button>
            </div>
          </div>

          {/* Transcription failure banner — shown in the idle state when a
              job exists but transcription produced zero segments (or threw).
              Surfaces the backend error detail and offers one-click retry,
              which re-runs the ASR stream on the same job without re-uploading. */}
          {dubError && dubJobId && dubStep === 'idle' && (
            <div className="dub-footer-banner">
              <Badge tone="danger">
                <AlertCircle size={11} /> {dubError}
              </Badge>
              <DubFailureNotice failure={dubFailure} />
              {handleDubRetryTranscribe && (
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={handleDubRetryTranscribe}
                  leading={<Sparkles size={10} />}
                >
                  {t('dub.retry_transcription')}
                </Button>
              )}
              {handleDubImportSrt && (
                <label
                  htmlFor="srt-import-banner-input"
                  className="dub-idle-upload-label"
                  title={t('dub.import_srt')}
                  style={{ cursor: 'pointer' }}
                >
                  <FileText size={11} /> {t('dub.import_srt_alt')}
                  <input
                    id="srt-import-banner-input"
                    type="file"
                    accept=".srt,text/srt,text/plain"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleDubImportSrt(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
          )}

          {/* SPLIT LAYOUT skeleton */}
          <div className={`dub-split-grid ${dubVideoFile ? 'dub-split-2' : 'dub-split-1'}`}>
            {/* LEFT */}
            <div className="studio-panel dub-panel-col">
              {dubVideoFile ? (
                <>
                  <WaveformTimeline
                    audioSrc={dubLocalBlobUrl?.audioUrl}
                    videoSrc={dubLocalBlobUrl?.videoUrl}
                    segments={[]}
                    disabled={true}
                    overlayContent={
                      dubStep === 'uploading' ? (
                        <PrepOverlay stage={dubPrepStage} progress={dubPrepProgress} onAbort={handleDubAbort} />
                      ) : dubStep === 'transcribing' ? (
                        <TranscribeOverlay
                          elapsed={transcribeElapsed}
                          duration={dubDuration}
                          onAbort={handleDubAbort}
                        />
                      ) : null
                    }
                  />
                  <div className="dub-change-row">
                    <label htmlFor="video-upload" className="dub-idle-upload-label">
                      <Film size={13} /> {t('dub.change_file')}
                    </label>
                    {dubJobId && handleDubImportSrt && (
                      <label
                        htmlFor="srt-import-input"
                        className="dub-idle-upload-label"
                        title={t('dub.import_srt')}
                        style={{ cursor: 'pointer' }}
                      >
                        <FileText size={13} /> {t('dub.import_srt')}
                        <input
                          id="srt-import-input"
                          type="file"
                          accept=".srt,text/srt,text/plain"
                          hidden
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleDubImportSrt(f);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    )}
                    <label className="dub-speakers-hint" title={t('dub.num_speakers_help')}>
                      <Users size={13} /> {t('dub.num_speakers_label')}
                      <input
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        className="dub-speakers-input"
                        placeholder={t('dub.num_speakers_auto')}
                        value={dubNumSpeakers ?? ''}
                        disabled={dubStep === 'uploading' || dubStep === 'transcribing'}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          setDubNumSpeakers(Number.isFinite(v) && v > 0 ? Math.min(v, 20) : null);
                        }}
                      />
                    </label>
                    <button className="btn-primary dub-change-row__cta"
                      onClick={handleDubUpload}
                      disabled={dubStep === 'uploading' || dubStep === 'transcribing'}>
                      {dubStep === 'uploading' || dubStep === 'transcribing'
                        ? <><Loader className="spinner" size={14} /> {t('common.loading')}</>
                        : <><Sparkles size={14} /> {t('dub.upload_transcribe')}</>}
                    </button>
                  </div>
                </>
              ) : dubStep === 'uploading' ? (
                <PrepOverlay stage={dubPrepStage} progress={dubPrepProgress} onAbort={handleDubAbort} large />
              ) : (
                <>
                  {!demoDismissed && (
                    <DubbingDemo onDismiss={dismissDubDemo} />
                  )}
                  <label htmlFor="video-upload" className="dub-idle-drop"
                  onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('is-dragging'); }}
                  onDragLeave={e => { e.currentTarget.classList.remove('is-dragging'); }}
                  onDrop={e => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('is-dragging');
                    const file = e.dataTransfer.files[0];
                    if (file && (file.type.startsWith('video/') || file.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i.test(file.name))) {
                      setDubVideoFile(file);
                      // #119: an audio file → audio-only dubbing (skip video work, output audio).
                      setDubInputType(file.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i.test(file.name) ? 'audio' : 'video');
                      setDubStep('idle');
                      fileToMediaUrl(file, null).then(urls => setDubLocalBlobUrl(urls));
                    }
                  }}>
                  <div className="dub-idle-drop__puck">
                    <UploadCloud color="#d3869b" size={28} />
                  </div>
                  <div className="dub-idle-drop__lines">
                    <div className="dub-idle-drop__title">{t('dub.drop_here')}</div>
                    <div className="dub-idle-drop__sub">{t('dub.supported_formats')}</div>
                  </div>
                  <div
                    className="dub-ingest-row"
                    onClick={e => e.preventDefault()}
                  >
                    <Link2 size={13} color="#a89984" />
                    <input
                      type="text"
                      placeholder={t('dub.paste_url')}
                      value={ingestUrl}
                      onChange={e => setIngestUrl(e.target.value)}
                      onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onIngestUrl(); } }}
                      className="dub-ingest-row__input"
                    />
                    <button
                      type="button"
                      onClick={e => { e.preventDefault(); e.stopPropagation(); onIngestUrl(); }}
                      disabled={!ingestUrl.trim()}
                      className={`dub-ingest-row__cta ${ingestUrl.trim() ? 'is-ready' : ''}`}
                    >
                      {t('dub.ingest')}
                    </button>
                  </div>
                  <label
                    className="dub-ingest-sub-opt"
                    title={t('dub.pull_captions_title')}
                    onClick={e => { e.stopPropagation(); }}
                  >
                    <input
                      type="checkbox"
                      checked={fetchYtSubs}
                      onChange={e => setFetchYtSubs(e.target.checked)}
                      onClick={e => e.stopPropagation()}
                    />
                    <span>{t('dub.pull_captions')}</span>
                  </label>
                </label>

                {/* One decision up front: the target language. Everything else
                    (speakers, style) hides behind Advanced — ElevenLabs-style
                    flow, OmniVoice chrome. The pick pre-seeds the editor. */}
                <div className="dub-landing-opts">
                  <label className="dub-landing-opts__lang">
                    <Globe size={13} />
                    <span className="dub-landing-opts__label">{t('dub.target_language', { defaultValue: 'Dub into' })}</span>
                    <select
                      className="input-base input-base--xs"
                      value={dubLangCode}
                      onChange={(e) => {
                        const lc = LANG_CODES.find(l => l.code === e.target.value);
                        setDubLangCode(e.target.value);
                        if (lc) setDubLang(lc.label);
                      }}
                    >
                      {LANG_CODES.map(lc => (
                        <option key={lc.code} value={lc.code}>{lc.label} — {lc.code}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="dub-landing-opts__adv"
                    onClick={() => setLandingAdvOpen(o => !o)}
                    aria-expanded={landingAdvOpen}
                  >
                    {t('dub.advanced', { defaultValue: 'Advanced' })}
                    {landingAdvOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </button>
                </div>
                {landingAdvOpen && (
                  <div className="dub-landing-adv">
                    <label className="dub-landing-adv__field" title={t('dub.num_speakers_help')}>
                      <Users size={12} /> {t('dub.num_speakers_label')}
                      <input
                        type="number" min={1} max={20} step={1}
                        className="input-base input-base--xs dub-speakers-input"
                        placeholder={t('dub.num_speakers_auto')}
                        value={dubNumSpeakers ?? ''}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          setDubNumSpeakers(Number.isFinite(v) && v > 0 ? Math.min(v, 20) : null);
                        }}
                      />
                    </label>
                    <label className="dub-landing-adv__field dub-landing-adv__field--grow">
                      <UserSquare2 size={12} /> {t('dub.style')}
                      <input
                        type="text"
                        className="input-base input-base--xs"
                        placeholder={t('dub.style_placeholder')}
                        value={dubInstruct}
                        onChange={(e) => setDubInstruct(e.target.value)}
                      />
                    </label>
                  </div>
                )}
                </>
              )}

              <input type="file" accept="video/*,audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma" id="video-upload" className="dub-hidden-file"
                onChange={e => {
                  const file = e.target.files[0];
                  if (!file) return;
                  setDubVideoFile(file);
                  // #119: an audio file → audio-only dubbing (skip video work, output audio).
                  setDubInputType(file.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i.test(file.name) ? 'audio' : 'video');
                  setDubStep('idle');
                  setDubLocalBlobUrl(prev => { fileToMediaUrl(file, prev).then(urls => setDubLocalBlobUrl(urls)); return prev; });
                }} />

              {dubVideoFile && (
                <div className="dub-cast dub-cast--muted">
                  <div className="dub-cast__row">
                    <span className="dub-cast__kicker">{t('dub.cast')}</span>
                    <span className="dub-cast__label">{t('dub.speaker', { n: 1 })}</span>
                    <span className="dub-cast--muted__chip">{t('dub.default')}</span>
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT: Ghost settings + segment table (only when video loaded) */}
            {dubVideoFile ? (
            <div className="studio-panel dub-panel-col">
              <div className="dub-skel-settings">
                <div className="dub-skel-field">
                  <div className="label-row"><Globe className="label-icon" size={9} /> {t('dub.language')}</div>
                  <select className="input-base input-base--xs" disabled>
                    <option>{t('dub.auto')}</option>
                  </select>
                </div>
                <div className="dub-skel-field--sm">
                  <div className="label-row">{t('dub.iso_code')}</div>
                  <select className="input-base input-base--xs" disabled>
                    <option>en — {t('dub.original_audio')}</option>
                  </select>
                </div>
                <div className="dub-skel-field">
                  <div className="label-row"><UserSquare2 className="label-icon" size={9} /> {t('dub.style')}</div>
                  <input className="input-base input-base--xs" disabled placeholder={t('dub.style_placeholder')} />
                </div>
                <button disabled className="dub-skel-translate-btn">
                  <Languages size={10} /> {t('dub.translate_all')}
                </button>
              </div>
              <div className="dub-skel-transcript-toggle">
                <div className="override-toggle dub-skel-transcript-toggle__inner">
                  <span><FileText size={10} className="dub-inline-icon" /> {t('dub.transcript')}</span>
                  <ChevronDown size={10} />
                </div>
              </div>
              <div className="segment-table dub-skel-table">
                <div className="segment-header">
                  <span className="dub-skel-header-time">{t('dub.time_col')}</span>
                  <span className="dub-skel-header-spkr">{t('dub.spkr_col')}</span>
                  <span className="dub-skel-header-text">{t('dub.text_col')}</span>
                  <span className="dub-skel-header-voice">{t('dub.voice_col')}</span>
                  <span className="dub-skel-header-acts"></span>
                </div>
                {[1, 2, 3, 4, 5, 6].map(i => (
                  <div key={i} className="segment-row dub-skel-row" style={{ opacity: 0.5 + (0.07 * (6 - i)) }}>
                    <span className="dub-skel-cell-time dub-skel-bar" />
                    <span className="dub-skel-cell-spkr dub-skel-bar" />
                    <div className="dub-skel-cell-text dub-skel-bar" />
                    <span className="dub-skel-cell-voice dub-skel-bar" />
                    <div className="dub-skel-cell-acts">
                      <span className="segment-del dub-skel-cell-acts__icon"><Trash2 size={9} /></span>
                    </div>
                  </div>
                ))}
                <div className="dub-skel-hint">{t('dub.transcript_after_extract', { defaultValue: 'Transcript appears after extraction.' })}</div>
              </div>
            </div>
            ) : null}
          </div>

          {/* Ghost footer — only once a file is in play; the bare landing stays
              clean. Generate is the lone primary, exports demoted to one menu. */}
          {dubVideoFile && (
            <div className="studio-panel dub-ghost-footer">
              <div className="dub-skel-gen-row">
                <button className="btn-primary dub-skel-gen-btn" disabled>
                  <Play size={11} /> {t('dub.generate_dub')}
                </button>
                <button className="dub-skel-gen-btn dub-skel-gen-btn--secondary" disabled>
                  <Download size={11} /> {t('dub.export_btn', { defaultValue: 'Export' })} <ChevronDown size={10} />
                </button>
              </div>
            </div>
          )}
        </div>
  );
}
