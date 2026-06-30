import {
  Film,
  Save,
  RotateCcw,
  AlertCircle,
  Sparkles,
  FileText,
  Loader,
  Users,
  UploadCloud,
  Link2,
  Globe,
  ChevronUp,
  ChevronDown,
  UserSquare2,
  Languages,
  Trash2,
  Play,
  Download,
} from 'lucide-react';
import { Button, Badge } from '../../ui';
import WaveformTimeline from '../WaveformTimeline';
import DubbingDemo from '../DubbingDemo';
import DubFailureNotice from './DubFailureNotice';
import PrepOverlay from './PrepOverlay';
import TranscribeOverlay from './TranscribeOverlay';
import { LANG_CODES } from '../../utils/languages';

const SPEAKERS_INPUT =
  'w-[52px] ml-[4px] px-[6px] py-[4px] rounded-[6px] border border-[var(--border,#3c3836)] bg-[var(--input-bg,#282828)] text-inherit text-[12px]';

export default function IdleSkeleton({
  t,
  dubVideoFile,
  activeProjectName,
  dubFilename,
  dubError,
  dubJobId,
  dubStep,
  dubFailure,
  handleDubRetryTranscribe,
  handleDubImportSrt,
  dubLocalBlobUrl,
  dubPrepStage,
  dubPrepProgress,
  handleDubAbort,
  transcribeElapsed,
  dubDuration,
  dubNumSpeakers,
  setDubNumSpeakers,
  handleDubUpload,
  demoDismissed,
  dismissDubDemo,
  setDubVideoFile,
  setDubInputType,
  setDubStep,
  fileToMediaUrl,
  setDubLocalBlobUrl,
  ingestUrl,
  setIngestUrl,
  onIngestUrl,
  fetchYtSubs,
  setFetchYtSubs,
  dubLangCode,
  setDubLangCode,
  setDubLang,
  landingAdvOpen,
  setLandingAdvOpen,
  dubInstruct,
  setDubInstruct,
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header bar */}
      <div className="flex justify-between items-center px-[12px] py-[5px] shrink-0 bg-[rgba(255,255,255,0.015)] [border:1px_solid_rgba(255,255,255,0.04)] rounded-md mb-[2px]">
        <div className="label-row dub-head__title">
          <Film className="label-icon" size={11} />
          <span className="font-semibold text-[0.85rem] overflow-hidden text-ellipsis whitespace-nowrap text-fg">
            {dubVideoFile ? dubVideoFile.name : t('dub.video_dubbing_studio')}
          </span>
          {dubVideoFile && (
            <span className="text-fg-muted font-normal whitespace-nowrap text-[0.72rem]">
              · {(dubVideoFile.size / 1024 / 1024).toFixed(1)} MB
            </span>
          )}
          {activeProjectName && activeProjectName !== dubFilename && (
            <span className="text-[#b8bb26] ml-[var(--space-3)] whitespace-nowrap text-[0.72rem]">
              — {activeProjectName}
            </span>
          )}
        </div>
        <div className="flex gap-[var(--space-2)] items-center shrink-0">
          <Button
            variant="subtle"
            size="sm"
            disabled
            title={t('dub.save')}
            aria-label={t('dub.save')}
          >
            <Save size={12} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled
            title={t('dub.reset')}
            aria-label={t('dub.reset')}
          >
            <RotateCcw size={12} />
          </Button>
        </div>
      </div>

      {/* Transcription failure banner — shown in the idle state when a
              job exists but transcription produced zero segments (or threw).
              Surfaces the backend error detail and offers one-click retry,
              which re-runs the ASR stream on the same job without re-uploading. */}
      {dubError && dubJobId && dubStep === 'idle' && (
        <div className="mb-[var(--space-2)]">
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
              className="flex items-center gap-[6px] px-[12px] py-[6px] bg-[rgba(255,255,255,0.05)] [border:1px_solid_rgba(255,255,255,0.1)] rounded-[6px] cursor-pointer text-[0.8rem] text-fg-muted"
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
      <div
        className={
          dubVideoFile
            ? 'grid grid-cols-2 max-[1000px]:grid-cols-1 max-[1000px]:grid-rows-[auto_1fr] gap-[6px] flex-1 min-h-0 overflow-hidden'
            : 'grid grid-cols-1 gap-[6px] flex-1 min-h-0'
        }
      >
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
                    <PrepOverlay
                      stage={dubPrepStage}
                      progress={dubPrepProgress}
                      onAbort={handleDubAbort}
                    />
                  ) : dubStep === 'transcribing' ? (
                    <TranscribeOverlay
                      elapsed={transcribeElapsed}
                      duration={dubDuration}
                      onAbort={handleDubAbort}
                    />
                  ) : null
                }
              />
              <div className="flex gap-[8px] mt-[8px] items-center">
                <label
                  htmlFor="video-upload"
                  className="flex items-center gap-[6px] px-[12px] py-[6px] bg-[rgba(255,255,255,0.05)] [border:1px_solid_rgba(255,255,255,0.1)] rounded-[6px] cursor-pointer text-[0.8rem] text-fg-muted"
                >
                  <Film size={13} /> {t('dub.change_file')}
                </label>
                {dubJobId && handleDubImportSrt && (
                  <label
                    htmlFor="srt-import-input"
                    className="flex items-center gap-[6px] px-[12px] py-[6px] bg-[rgba(255,255,255,0.05)] [border:1px_solid_rgba(255,255,255,0.1)] rounded-[6px] cursor-pointer text-[0.8rem] text-fg-muted"
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
                <label
                  className="inline-flex items-center gap-[5px] text-[12px] text-[var(--muted,#a89984)] whitespace-nowrap"
                  title={t('dub.num_speakers_help')}
                >
                  <Users size={13} /> {t('dub.num_speakers_label')}
                  <input
                    type="number"
                    min={1}
                    max={20}
                    step={1}
                    className={SPEAKERS_INPUT}
                    placeholder={t('dub.num_speakers_auto')}
                    value={dubNumSpeakers ?? ''}
                    disabled={dubStep === 'uploading' || dubStep === 'transcribing'}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setDubNumSpeakers(Number.isFinite(v) && v > 0 ? Math.min(v, 20) : null);
                    }}
                  />
                </label>
                <Button
                  variant="primary"
                  className="flex-1"
                  onClick={handleDubUpload}
                  disabled={dubStep === 'uploading' || dubStep === 'transcribing'}
                >
                  {dubStep === 'uploading' || dubStep === 'transcribing' ? (
                    <>
                      <Loader className="spinner" size={14} /> {t('common.loading')}
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} /> {t('dub.upload_transcribe')}
                    </>
                  )}
                </Button>
              </div>
            </>
          ) : dubStep === 'uploading' ? (
            <PrepOverlay
              stage={dubPrepStage}
              progress={dubPrepProgress}
              onAbort={handleDubAbort}
              large
            />
          ) : (
            <>
              {!demoDismissed && <DubbingDemo onDismiss={dismissDubDemo} />}
              <label
                htmlFor="video-upload"
                className="dub-idle-drop"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.add('is-dragging');
                }}
                onDragLeave={(e) => {
                  e.currentTarget.classList.remove('is-dragging');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('is-dragging');
                  const file = e.dataTransfer.files[0];
                  if (
                    file &&
                    (file.type.startsWith('video/') ||
                      file.type.startsWith('audio/') ||
                      /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i.test(file.name))
                  ) {
                    setDubVideoFile(file);
                    // #119: an audio file → audio-only dubbing (skip video work, output audio).
                    setDubInputType(
                      file.type.startsWith('audio/') ||
                        /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i.test(file.name)
                        ? 'audio'
                        : 'video',
                    );
                    setDubStep('idle');
                    fileToMediaUrl(file, null).then((urls) => setDubLocalBlobUrl(urls));
                  }
                }}
              >
                <div className="dub-idle-drop__puck">
                  <UploadCloud color="#d3869b" size={28} />
                </div>
                <div className="text-center">
                  <div className="text-[0.9rem] text-fg font-medium mb-[4px]">
                    {t('dub.drop_here')}
                  </div>
                  <div className="text-[0.7rem] text-[#665c54]">{t('dub.supported_formats')}</div>
                </div>
                <div
                  className="flex gap-[6px] items-center px-[10px] py-[6px] mt-[10px] bg-[rgba(255,255,255,0.02)] [border:1px_solid_rgba(255,255,255,0.06)] rounded-[6px] w-[min(420px,80%)]"
                  onClick={(e) => e.preventDefault()}
                >
                  <Link2 size={13} color="#a89984" />
                  <input
                    type="text"
                    placeholder={t('dub.paste_url')}
                    value={ingestUrl}
                    onChange={(e) => setIngestUrl(e.target.value)}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        onIngestUrl();
                      }
                    }}
                    className="flex-1 bg-transparent border-none outline-none text-fg text-[0.75rem]"
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onIngestUrl();
                    }}
                    disabled={!ingestUrl.trim()}
                    className={`dub-ingest-row__cta ${ingestUrl.trim() ? 'is-ready' : ''}`}
                  >
                    {t('dub.ingest')}
                  </button>
                </div>
                <label
                  className="flex items-center gap-[6px] mt-[6px] px-[6px] py-[4px] text-[0.62rem] text-fg-muted cursor-pointer rounded-[4px] bg-[rgba(255,255,255,0.02)] hover:text-fg hover:bg-[rgba(255,255,255,0.05)]"
                  title={t('dub.pull_captions_title')}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <input
                    type="checkbox"
                    className="m-0 accent-[#d3869b]"
                    checked={fetchYtSubs}
                    onChange={(e) => setFetchYtSubs(e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span>{t('dub.pull_captions')}</span>
                </label>
              </label>

              {/* One decision up front: the target language. Everything else
                    (speakers, style) hides behind Advanced — ElevenLabs-style
                    flow, OmniVoice chrome. The pick pre-seeds the editor. */}
              <div className="flex items-center justify-between gap-[10px] mt-[10px] px-[10px] py-[8px] [border:1px_solid_var(--chrome-border)] rounded-[10px] bg-[var(--chrome-hover-bg)]">
                <label className="dub-landing-opts__lang inline-flex items-center gap-[7px] min-w-0 text-[var(--chrome-fg-muted)]">
                  <Globe size={13} />
                  <span className="text-[0.72rem] font-medium whitespace-nowrap">
                    {t('dub.target_language', { defaultValue: 'Dub into' })}
                  </span>
                  <select
                    className="input-base text-[0.65rem]"
                    value={dubLangCode}
                    onChange={(e) => {
                      const lc = LANG_CODES.find((l) => l.code === e.target.value);
                      setDubLangCode(e.target.value);
                      if (lc) setDubLang(lc.label);
                    }}
                  >
                    {LANG_CODES.map((lc) => (
                      <option key={lc.code} value={lc.code}>
                        {lc.label} — {lc.code}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="inline-flex items-center gap-[5px] px-[10px] py-[5px] text-[0.7rem] text-[var(--chrome-fg-muted)] bg-transparent border border-[var(--chrome-border)] rounded-[var(--chrome-radius-pill,999px)] cursor-pointer transition-colors hover:text-[var(--chrome-fg)] hover:border-[var(--chrome-border-strong)]"
                  onClick={() => setLandingAdvOpen((o) => !o)}
                  aria-expanded={landingAdvOpen}
                >
                  {t('dub.advanced', { defaultValue: 'Advanced' })}
                  {landingAdvOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                </button>
              </div>
              {landingAdvOpen && (
                <div className="flex flex-wrap items-center gap-[12px] mt-[6px] px-[10px] py-[8px] [border:1px_solid_var(--chrome-border)] rounded-[10px]">
                  <label
                    className="dub-landing-adv__field inline-flex items-center gap-[6px] text-[0.7rem] text-[var(--chrome-fg-muted)]"
                    title={t('dub.num_speakers_help')}
                  >
                    <Users size={12} /> {t('dub.num_speakers_label')}
                    <input
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      className={SPEAKERS_INPUT}
                      placeholder={t('dub.num_speakers_auto')}
                      value={dubNumSpeakers ?? ''}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setDubNumSpeakers(Number.isFinite(v) && v > 0 ? Math.min(v, 20) : null);
                      }}
                    />
                  </label>
                  <label className="dub-landing-adv__field dub-landing-adv__field--grow inline-flex items-center gap-[6px] text-[0.7rem] text-[var(--chrome-fg-muted)]">
                    <UserSquare2 size={12} /> {t('dub.style')}
                    <input
                      type="text"
                      className="input-base text-[0.65rem]"
                      placeholder={t('dub.style_placeholder')}
                      value={dubInstruct}
                      onChange={(e) => setDubInstruct(e.target.value)}
                    />
                  </label>
                </div>
              )}
            </>
          )}

          <input
            type="file"
            accept="video/*,audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma"
            id="video-upload"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files[0];
              if (!file) return;
              setDubVideoFile(file);
              // #119: an audio file → audio-only dubbing (skip video work, output audio).
              setDubInputType(
                file.type.startsWith('audio/') ||
                  /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i.test(file.name)
                  ? 'audio'
                  : 'video',
              );
              setDubStep('idle');
              setDubLocalBlobUrl((prev) => {
                fileToMediaUrl(file, prev).then((urls) => setDubLocalBlobUrl(urls));
                return prev;
              });
            }}
          />

          {dubVideoFile && (
            <div className="dub-cast dub-cast--muted mt-[2px] px-[var(--space-3)] py-[3px] bg-[var(--chrome-bg)] rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-border)]">
              <div className="flex gap-[var(--space-2)] items-center flex-wrap">
                <span className="dub-cast__kicker font-[family-name:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] text-[var(--chrome-fg-muted)] tracking-[var(--chrome-label-track)] uppercase font-semibold">
                  {t('dub.cast')}
                </span>
                <span className="dub-cast__label font-[family-name:var(--chrome-font-mono)] text-[0.62rem] text-[var(--chrome-fg)]">
                  {t('dub.speaker', { n: 1 })}
                </span>
                <span className="font-[family-name:var(--chrome-font-mono)] text-[0.62rem] text-[var(--chrome-fg-dim)] px-[6px] py-[1px] bg-transparent [border:1px_solid_var(--chrome-border)] rounded-[var(--chrome-radius-pill)]">
                  {t('dub.default')}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: Ghost settings + segment table (only when video loaded) */}
        {dubVideoFile ? (
          <div className="studio-panel dub-panel-col">
            <div className="flex gap-[4px] mb-[4px] flex-wrap items-end opacity-40">
              <div className="flex-1 min-w-[90px]">
                <div className="label-row">
                  <Globe className="label-icon" size={9} /> {t('dub.language')}
                </div>
                <select className="input-base text-[0.65rem]" disabled>
                  <option>{t('dub.auto')}</option>
                </select>
              </div>
              <div className="flex-1 min-w-[80px]">
                <div className="label-row">{t('dub.iso_code')}</div>
                <select className="input-base text-[0.65rem]" disabled>
                  <option>en — {t('dub.original_audio')}</option>
                </select>
              </div>
              <div className="flex-1 min-w-[90px]">
                <div className="label-row">
                  <UserSquare2 className="label-icon" size={9} /> {t('dub.style')}
                </div>
                <input
                  className="input-base text-[0.65rem]"
                  disabled
                  placeholder={t('dub.style_placeholder')}
                />
              </div>
              <button
                disabled
                className="px-[8px] py-[3px] bg-[rgba(131,165,152,0.08)] [border:1px_solid_rgba(131,165,152,0.12)] text-[#504945] rounded-[4px] text-[0.62rem] flex items-center gap-[3px] whitespace-nowrap"
              >
                <Languages size={10} /> {t('dub.translate_all')}
              </button>
            </div>
            <div className="mb-[4px]">
              <div className="override-toggle dub-skel-transcript-toggle__inner">
                <span>
                  <FileText size={10} className="align-middle mr-[3px]" /> {t('dub.transcript')}
                </span>
                <ChevronDown size={10} />
              </div>
            </div>
            <div className="segment-table dub-skel-table">
              <div className="segment-header">
                <span className="w-[55px] flex-[0_0_55px]">{t('dub.time_col')}</span>
                <span className="w-[44px] flex-[0_0_44px]">{t('dub.spkr_col')}</span>
                <span className="flex-1">{t('dub.text_col')}</span>
                <span className="w-[70px] flex-[0_0_70px]">{t('dub.voice_col')}</span>
                <span className="w-[40px] flex-[0_0_40px]"></span>
              </div>
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div
                  key={i}
                  className="segment-row dub-skel-row"
                  style={{ opacity: 0.5 + 0.07 * (6 - i) }}
                >
                  <span className="dub-skel-bar w-[55px] flex-[0_0_55px]" />
                  <span className="dub-skel-bar w-[44px] flex-[0_0_44px]" />
                  <div className="dub-skel-bar flex-1 min-w-0" />
                  <span className="dub-skel-bar w-[70px] flex-[0_0_70px]" />
                  <div className="flex gap-[1px] w-[40px] flex-[0_0_40px]">
                    <span className="segment-del dub-skel-cell-acts__icon">
                      <Trash2 size={9} />
                    </span>
                  </div>
                </div>
              ))}
              <div className="px-[8px] pt-[10px] pb-[4px] text-[0.62rem] text-[var(--chrome-fg-dim)] text-center">
                {t('dub.transcript_after_extract', {
                  defaultValue: 'Transcript appears after extraction.',
                })}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Ghost footer — only once a file is in play; the bare landing stays
              clean. Generate is the lone primary, exports demoted to one menu. */}
      {dubVideoFile && (
        <div className="studio-panel px-[8px] py-[4px] shrink-0">
          <div className="flex gap-[4px]">
            <Button variant="primary" className="flex-1 opacity-40" disabled>
              <Play size={11} /> {t('dub.generate_dub')}
            </Button>
            <button
              className="inline-flex items-center gap-[5px] bg-transparent border border-[var(--chrome-border)] text-[var(--chrome-fg-muted)] rounded-[8px] flex-[0_0_auto] px-[8px] py-[4px] text-[0.7rem] opacity-40"
              disabled
            >
              <Download size={11} /> {t('dub.export_btn', { defaultValue: 'Export' })}{' '}
              <ChevronDown size={10} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
