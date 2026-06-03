import React, { Suspense, lazy, useState, useEffect, useCallback, useRef } from 'react';
import { copyText } from "../utils/copyText";
import { useTranslation } from 'react-i18next';
import {
  PanelLeftOpen, PanelLeftClose, Film, Save, UploadCloud, Sparkles, Loader, Square, Users,
  FileText, Play, DownloadIcon, Volume2, Link2,
  Languages, ChevronDown, ChevronUp, Wand2, Trash2, Check, Globe, UserSquare2, User, AlertCircle,
  ExternalLink, Copy,
} from 'lucide-react';
// lucide-react exports DownloadIcon as "Download"; alias here to match App.jsx naming.
import { Download as Download } from 'lucide-react';
import SearchableSelect from '../components/SearchableSelect';
import WaveformTimeline from '../components/WaveformTimeline';
import CheckpointBanner from '../components/CheckpointBanner';
import { useAppStore } from '../store';
import ALL_LANGUAGES from '../languages.json';
import { POPULAR_LANGS, POPULAR_ISO, PRESETS } from '../utils/constants';
import { LANG_CODES } from '../utils/languages';
import { formatTime } from '../utils/format';
import { API } from '../api/client';
import { listTranslationEngines, installTranslationEngine } from '../api/engines';
import toast from 'react-hot-toast';
import { Button, Segmented, Badge, Progress } from '../ui';
import { openDocsFor, classifyError } from '../utils/errorDocsMap';
import GlossaryPanel from '../components/GlossaryPanel';
import ExportModal from '../components/ExportModal';
import MultiLangPicker from '../components/MultiLangPicker';
import DubbingDemo from '../components/DubbingDemo';
import './DubTab.css';

const DubSegmentTable = lazy(() => import('../components/DubSegmentTable'));

const LazyFallback = () => (
  <div className="dub-lazy-fallback">Loading…</div>
);

/** plan-04 (#131): actionable failure detail — hint + docs deeplink + a copyable
 *  diagnostic block — shown beneath the error badge when the backend sent a
 *  structured failure. */
function DubFailureNotice({ failure }) {
  const { t } = useTranslation();
  if (!failure) return null;
  const topic = failure.docsTopic || classifyError(failure.reason);
  const copyDiagnostic = async () => {
    try {
      await copyText(failure.diagnostic || failure.reason);
      toast.success(t('dub.diagnostic_copied'));
    } catch {
      toast.error(t('dub.copy_failed'));
    }
  };
  return (
    <div className="dub-failure-notice">
      {failure.hint && <span className="dub-failure-notice__hint">{failure.hint}</span>}
      <div className="dub-failure-notice__actions">
        {topic && (
          <Button variant="subtle" size="sm" onClick={() => openDocsFor(topic)}>
            <ExternalLink size={11} /> {t('dub.open_docs')}
          </Button>
        )}
        {failure.diagnostic && (
          <Button variant="subtle" size="sm" onClick={copyDiagnostic}>
            <Copy size={11} /> {t('dub.copy_diagnostic')}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function DubTab(props) {
  const { t } = useTranslation();
  const {
    // Props that stay prop-threaded: non-serialisable state + handlers that
    // close over App.jsx's scope (uploads, SSE wiring, project CRUD, etc.).
    dubVideoFile, dubLocalBlobUrl,
    transcribeElapsed, translateProvider, setTranslateProvider,
    showTranscript, setShowTranscript,
    onGlossaryChange,
    profiles,
    segmentPreviewLoading,
    selectedSegIds,
    setDubVideoFile, setDubLocalBlobUrl,
    handleDubAbort, handleDubUpload, handleDubIngestUrl, handleDubRetryTranscribe, handleDubStop, handleDubGenerate, handleDubImportSrt,
    handleDubDownload, handleDubAudioDownload, handleAudioExport,
    speakerClones = {},
    handleSegmentPreview, onDirectSegment, handleTranslateAll, handleCleanupSegments,
    incrementalPlan,
    triggerDownload, fileToMediaUrl,
    editSegments, saveProject, resetDub,
    segmentEditField, segmentDelete, segmentRestoreOriginal, segmentSplit, segmentMerge,
    toggleSegSelect, selectAllSegs, clearSegSelection,
    bulkApplyToSelected, bulkDeleteSelected,
  } = props;

  // ── Store reads (Phase 2.2) — drop ~30 props from the App.jsx contract.
  const dubJobId          = useAppStore(s => s.dubJobId);
  const dubStep           = useAppStore(s => s.dubStep);
  const setDubStep        = useAppStore(s => s.setDubStep);
  const setDubInputType   = useAppStore(s => s.setDubInputType);
  const dubPrepStage      = useAppStore(s => s.dubPrepStage);
  const dubPrepProgress   = useAppStore(s => s.dubPrepProgress);
  const dubFilename       = useAppStore(s => s.dubFilename);
  const dubDuration       = useAppStore(s => s.dubDuration);
  const dubSegments       = useAppStore(s => s.dubSegments);
  const setDubSegments    = useAppStore(s => s.setDubSegments);
  const dubTranscript     = useAppStore(s => s.dubTranscript);
  const dubLang           = useAppStore(s => s.dubLang);
  const setDubLang        = useAppStore(s => s.setDubLang);
  const dubLangCode       = useAppStore(s => s.dubLangCode);
  const setDubLangCode    = useAppStore(s => s.setDubLangCode);
  const dubNumSpeakers    = useAppStore(s => s.dubNumSpeakers);
  const setDubNumSpeakers = useAppStore(s => s.setDubNumSpeakers);
  const dubInstruct       = useAppStore(s => s.dubInstruct);
  const setDubInstruct    = useAppStore(s => s.setDubInstruct);
  const dubTracks         = useAppStore(s => s.dubTracks);
  const dubError          = useAppStore(s => s.dubError);
  const dubFailure        = useAppStore(s => s.dubFailure);
  const dubProgress       = useAppStore(s => s.dubProgress);
  const isTranslating     = useAppStore(s => s.isTranslating);
  const preserveBg        = useAppStore(s => s.preserveBg);
  const setPreserveBg     = useAppStore(s => s.setPreserveBg);
  const defaultTrack      = useAppStore(s => s.defaultTrack);
  const setDefaultTrack   = useAppStore(s => s.setDefaultTrack);
  const exportTracks      = useAppStore(s => s.exportTracks);
  const setExportTracks   = useAppStore(s => s.setExportTracks);
  const activeProjectName = useAppStore(s => s.activeProjectName);
  const isSidebarCollapsed = useAppStore(s => s.isSidebarCollapsed);
  const setIsSidebarCollapsed = useAppStore(s => s.setIsSidebarCollapsed);
  const translateQuality    = useAppStore(s => s.translateQuality);
  const setTranslateQuality = useAppStore(s => s.setTranslateQuality);
  const dualSubs            = useAppStore(s => s.dualSubs);
  const setDualSubs         = useAppStore(s => s.setDualSubs);
  const burnSubs            = useAppStore(s => s.burnSubs);
  const setBurnSubs         = useAppStore(s => s.setBurnSubs);
  const timingStrategy      = useAppStore(s => s.timingStrategy);
  const setTimingStrategy   = useAppStore(s => s.setTimingStrategy);

  const showIdleSkeleton = !(dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done'));
  // Imperative handle to the post-job waveform so the transcript table can
  // seek the player when the user clicks a row.
  const waveformRef = useRef(null);
  const seekWaveform = useCallback((time) => {
    waveformRef.current?.seekTo?.(time);
  }, []);
  const [ingestUrl, setIngestUrl] = useState('');
  // Dubbing demo: show the side-by-side player above the drop zone on
  // first-run / no-project state. localStorage flag persists dismissal
  // across sessions so power users don't see it every launch.
  const [demoDismissed, setDemoDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('omnivoice.dubbingDemoDismissed') === '1';
  });
  const dismissDubDemo = () => {
    setDemoDismissed(true);
    try { localStorage.setItem('omnivoice.dubbingDemoDismissed', '1'); } catch { /* noop */ }
  };
  const [previewMode, setPreviewMode] = useState('original'); // 'original' | 'dubbed'
  const [exportOpen, setExportOpen] = useState(false);

  // Multi-language mode
  const [multiLangMode, setMultiLangMode] = useState(false);
  const [multiLangs, setMultiLangs] = useState([]);

  // Live ETA while generating — elapsed ticks each second; remaining is
  // extrapolated from the current/total rate so it's only meaningful once
  // at least one segment has rendered and ~2s of clock has passed.
  const [genElapsed, setGenElapsed] = useState(0);
  useEffect(() => {
    if (dubStep !== 'generating') { setGenElapsed(0); return; }
    const start = Date.now();
    setGenElapsed(0);
    const id = setInterval(() => setGenElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [dubStep]);
  const genRemaining = (() => {
    if (dubStep !== 'generating') return null;
    if (!dubProgress.total || !dubProgress.current || genElapsed < 2) return null;
    const perSeg = genElapsed / dubProgress.current;
    return Math.max(0, Math.round(perSeg * (dubProgress.total - dubProgress.current)));
  })();

  // Translation-engine availability → drives the Engine dropdown's disabled
  // state and the inline Install chip. Lazy-fetched once; refreshed after
  // any install/uninstall so the chip disappears on success.
  const [engines, setEngines] = useState([]);
  const [enginesSandboxed, setEnginesSandboxed] = useState(false);
  const [engineInstalling, setEngineInstalling] = useState(null); // engine id being installed
  const refreshEngines = useCallback(async () => {
    try {
      const res = await listTranslationEngines();
      setEngines(res.engines || []);
      setEnginesSandboxed(!!res.sandboxed);
    } catch {
      setEngines([]);
    }
  }, []);
  useEffect(() => { refreshEngines(); }, [refreshEngines]);
  const activeEngineEntry = engines.find(e => e.id === translateProvider);
  const activeEngineUnavailable = activeEngineEntry && !activeEngineEntry.installed;
  const handleInstallEngine = async (engineId) => {
    if (!engineId || enginesSandboxed) return;
    setEngineInstalling(engineId);
    const progressToast = toast.loading(t('dub.install_progress', { engine: engineId }));
    try {
      const res = await installTranslationEngine(engineId);
      await refreshEngines();
      if (res.restart_required) {
        toast(t('dub.install_restart', { engine: engineId }), { icon: '🔄', id: progressToast, duration: 7000 });
      } else if (res.status === 'already_installed') {
        toast(t('dub.install_already', { engine: engineId }), { icon: 'ℹ️', id: progressToast });
      } else {
        toast.success(t('dub.install_ok', { engine: engineId }), { id: progressToast });
      }
    } catch (err) {
      toast.error(t('dub.install_failed', { message: String(err.message || err).slice(0, 200) }), { id: progressToast, duration: 8000 });
    } finally {
      setEngineInstalling(null);
    }
  };

  // Secondary settings (Language/ISO/Style/Engine/Quality/Multi-lang) are
  // expanded by default so the user can pick a target language and quality
  // without an extra click on first open. They stay an accordion so the
  // user can collapse them once happy with the choice.
  const [settingsOpen, setSettingsOpen] = useState(true);
  const hasAnyTranslation = dubSegments.some(s => s.text_original && s.text_original !== s.text);

  // Glossary: hide behind a chip when empty, auto-open once terms exist.
  const glossaryTermCount = useAppStore(s => s.glossaryTerms.length);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [glossaryHidden, setGlossaryHidden] = useState(false);
  const glossaryVisible = glossaryOpen || (glossaryTermCount > 0 && !glossaryHidden);

  // Phase 4.3 — between-stage checkpoint banner.
  const reviewMode = useAppStore(s => s.reviewMode);
  const [dismissedStages, setDismissedStages] = useState(() => new Set());
  const hasTranslations = dubSegments.some(s => s.text_original && s.text_original !== s.text);
  const checkpointStage =
    dubStep === 'editing' && !hasTranslations ? 'asr'
    : dubStep === 'editing' && hasTranslations ? 'translate'
    : dubStep === 'done' ? 'done'
    : null;
  const showCheckpoint = reviewMode === 'on' && checkpointStage && !dismissedStages.has(checkpointStage);
  const onCheckpointContinue = () => {
    if (checkpointStage === 'asr') handleTranslateAll?.();
    else if (checkpointStage === 'translate') handleDubGenerate?.();
  };
  const onCheckpointDismiss = () => {
    setDismissedStages(prev => {
      const next = new Set(prev);
      if (checkpointStage) next.add(checkpointStage);
      return next;
    });
  };
  // Persist the "pull YouTube captions" intent across ingests — it's opt-in
  // per-URL but almost always on once the user discovers it. Stored on the
  // component instead of the global store to avoid polluting cross-project
  // prefs with what's really a per-ingest choice.
  const [fetchYtSubs, setFetchYtSubs] = useState(false);
  const onIngestUrl = () => {
    if (!ingestUrl.trim() || !handleDubIngestUrl) return;
    handleDubIngestUrl(ingestUrl.trim(), {
      fetchSubs: fetchYtSubs,
      subLangs: undefined,
    });
    setIngestUrl('');
  };
  const hasDubbedTrack = dubStep === 'done' && dubLangCode && dubLangCode !== 'und' && (dubTracks?.length > 0 || !!dubTracks);
  const videoSrc = (previewMode === 'dubbed' && hasDubbedTrack)
    ? `${API}/dub/preview-video/${dubJobId}?lang=${encodeURIComponent(dubLangCode)}&preserve_bg=${preserveBg ? 1 : 0}`
    : `${API}/dub/media/${dubJobId}`;

  return (
    <div className="dub-col">
      {/* ── Idle: show full editor skeleton with drop zone ── */}
      {showIdleSkeleton && (
        <div className="dub-col">
          {/* Header bar */}
          <div className="dub-head">
            <div className="label-row dub-head__title">
              <Button
                variant="icon"
                iconSize="sm"
                active={isSidebarCollapsed}
                  onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                  title={t('dub.sidebar_toggle')}
                >
                  {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
                </Button>
                <Film className="label-icon" size={11} />
                <span className="dub-head__filename">{dubVideoFile ? dubVideoFile.name : t('dub.video_dubbing_studio')}</span>
              {dubVideoFile && <span className="dub-head__meta">· {(dubVideoFile.size / 1024 / 1024).toFixed(1)} MB</span>}
              {activeProjectName && activeProjectName !== dubFilename && (
                <span className="dub-head__project">— {activeProjectName}</span>
              )}
            </div>
            <div className="dub-head__actions">
              <Button variant="subtle" size="sm" disabled leading={<Save size={9} />}>{t('dub.save')}</Button>
              <Button variant="ghost"  size="sm" disabled>{t('dub.reset')}</Button>
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
                    onSegmentsChange={() => { }}
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

              <div className="dub-cast dub-cast--muted">
                <div className="dub-cast__row">
                  <span className="dub-cast__kicker">{t('dub.cast')}</span>
                  <span className="dub-cast__label">{t('dub.speaker', { n: 1 })}</span>
                  <span className="dub-cast--muted__chip">{t('dub.default')}</span>
                </div>
              </div>
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
                {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                  <div key={i} className="segment-row" style={{ opacity: 0.15 + (0.04 * (8 - i)) }}>
                    <span className="segment-time dub-skel-cell-time">0:00.0–0:00.0</span>
                    <span className="dub-skel-cell-spkr">Speaker 1</span>
                    <div className="dub-skel-cell-text" />
                    <span className="dub-skel-cell-voice">Default</span>
                    <div className="dub-skel-cell-acts">
                      <span className="segment-del dub-skel-cell-acts__icon"><Trash2 size={9} /></span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            ) : null}
          </div>

          {/* Ghost footer */}
          <div className="studio-panel dub-ghost-footer">
            <div className="dub-skel-gen-row">
              <button className="btn-primary dub-skel-gen-btn" disabled>
                <Play size={11} /> {t('dub.generate_dub')}
              </button>
              <button className="btn-primary dub-skel-gen-btn" disabled>
                <Download size={11} /> {t('dub.export_mp4')}
              </button>
              <button className="btn-primary dub-skel-gen-btn" disabled>
                <Volume2 size={11} /> {t('dub.export_wav')}
              </button>
              <button className="btn-primary dub-skel-gen-btn" disabled>
                <FileText size={11} /> {t('dub.export_srt')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── After transcription: side-by-side editor ── */}
      {dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done') && (
        <div className="dub-col">
          <div className="dub-head">
            <div className="label-row dub-head__title">
              <Button
                variant="icon"
                iconSize="sm"
                active={isSidebarCollapsed}
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                title={t('dub.sidebar_toggle')}
              >
                {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
              </Button>
              <FileText className="label-icon" size={11} />
              <span className="dub-head__filename">{dubFilename}</span>
              <span className="dub-head__meta">· {formatTime(dubDuration)} · {dubSegments.length} {t('dub.segs')}</span>
              {activeProjectName && activeProjectName !== dubFilename && (
                <span className="dub-head__project">— {activeProjectName}</span>
              )}
            </div>
            <div className="dub-head__actions">
              <Button variant="subtle" size="sm" onClick={saveProject} leading={<Save size={9} />}>{t('dub.save')}</Button>
              <Button variant="danger" size="sm" onClick={resetDub}>{t('dub.reset')}</Button>
              {/* Primary actions live on the header bar (compact) — moved up from the footer. */}
              <div className="dub-head__primary">
                {dubStep === 'stopping' ? (
                  <FooterBtn sm tone="stopping" disabled icon={<Loader className="spinner" size={9} />} label={t('dub.stopping')} />
                ) : dubStep === 'generating' ? (
                  <FooterBtn sm tone="danger" onClick={handleDubStop} icon={<Square size={9} />}
                    label={t('dub.stop_progress', { current: dubProgress.current, total: dubProgress.total })} />
                ) : (
                  <>
                    <FooterBtn sm tone={dubSegments.length ? 'pink' : 'idle'} onClick={() => handleDubGenerate()}
                      disabled={!dubSegments.length} icon={<Play size={11} />} label={t('dub.generate_dub')} />
                    {dubStep === 'done' && incrementalPlan && incrementalPlan.stale?.length > 0 && (
                      <FooterBtn sm tone="pink"
                        onClick={() => handleDubGenerate({ regenOnly: incrementalPlan.stale, preview: true })}
                        icon={<Play size={11} />}
                        label={t('dub.regen_changed', { count: incrementalPlan.stale.length })} />
                    )}
                  </>
                )}
                <FooterBtn sm tone={dubStep === 'done' ? 'green' : 'idle'}
                  disabled={dubStep !== 'done' && !dubSegments.length}
                  onClick={() => setExportOpen(true)}
                  icon={<Download size={11} />} label={t('dub.export_btn')} />
              </div>
            </div>
          </div>

          <div className="dub-split-grid dub-split-2">
            {/* LEFT: Waveform + Video */}
            <div className="studio-panel dub-panel-col">
              {hasDubbedTrack && (
                <div className="dub-preview-toggle">
                  <span className="dub-preview-toggle__kicker">{t('dub.preview')}</span>
                  <Segmented
                    size="sm"
                    value={previewMode}
                    onChange={setPreviewMode}
                    items={[
                      { value: 'original', label: t('dub.original_audio') },
                      { value: 'dubbed',   label: t('dub.dubbed_audio', { code: dubLangCode }) },
                    ]}
                  />
                  {previewMode === 'dubbed' && (
                    <span className="dub-preview-toggle__hint">{t('dub.first_play_hint')}</span>
                  )}
                </div>
              )}
              <WaveformTimeline
                key={videoSrc}
                ref={waveformRef}
                audioSrc={`${API}/dub/audio/${dubJobId}`}
                videoSrc={videoSrc}
                segments={dubSegments}
                onSegmentsChange={setDubSegments}
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
                        if (match) setDubLangCode(match.code);
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
                      onChange={(e) => setDubLangCode(e.target.value)}
                    >
                      {LANG_CODES.map(lc => (
                        <option key={lc.code} value={lc.code}>{lc.code} — {lc.label}</option>
                      ))}
                    </select>
                  </div>
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
                      onChange={setTranslateQuality}
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

            {/* RIGHT: Segment Table */}
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
                    options={[
                      { value: 'concise',       label: 'Concise',        title: 'Translator trims text to fit at natural rate. Overflows surface in the row badge so you can shorten the segment.' },
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
                />
              </Suspense>
            </div>
          </div>

          {/* Actions footer */}
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
        </div>
      )}

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        jobId={dubJobId}
        filename={dubFilename}
        dubTracks={dubTracks}
        dubLangCode={dubLangCode}
        preserveBg={preserveBg} setPreserveBg={setPreserveBg}
        defaultTrack={defaultTrack} setDefaultTrack={setDefaultTrack}
        exportTracks={exportTracks} setExportTracks={setExportTracks}
        dualSubs={dualSubs} setDualSubs={setDualSubs}
        burnSubs={burnSubs} setBurnSubs={setBurnSubs}
        API={API}
        triggerDownload={triggerDownload}
        handleDubDownload={handleDubDownload}
        handleDubAudioDownload={handleDubAudioDownload}
        handleAudioExport={handleAudioExport}
        segmentCount={dubSegments.length}
        onEnterprise={() => useAppStore.getState().setMode?.('enterprise')}
      />
    </div>
  );
}

function fmtDur(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return sec ? `${m}m ${sec}s` : `${m}m`;
}

const PREP_FULL   = ['download', 'extract', 'demucs', 'scene'];
const PREP_CACHED = ['download', 'extract', 'cached'];

function fmtBytesRate(bps) {
  if (!bps || bps <= 0) return null;
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bps, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60), rem = s % 60;
  return rem ? `${m}m ${rem}s left` : `${m}m left`;
}

/**
 * PrepOverlay — the prepare-upload stage indicator.
 * `large` makes the surrounding frame bigger (used for the empty-state drop zone).
 */
function PrepOverlay({ stage, progress, onAbort, large = false }) {
  const { t } = useTranslation();
  const LABEL = {
    download: t('dub.prep_download'),
    extract:  t('dub.prep_extract'),
    demucs:   t('dub.prep_demucs'),
    scene:    t('dub.prep_scene'),
    cached:   t('dub.prep_cached'),
  };
  const stages = stage === 'cached' ? PREP_CACHED : PREP_FULL;
  // Elapsed-time ticker for the current stage. Reset whenever
  // stageStartedAt changes (i.e. the backend transitions stages).
  const [elapsedS, setElapsedS] = useState(0);
  const startedAt = progress?.stageStartedAt ?? null;
  useEffect(() => {
    if (!startedAt) { setElapsedS(0); return undefined; }
    setElapsedS(Math.floor((Date.now() - startedAt) / 1000));
    const iv = setInterval(() => {
      setElapsedS(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [startedAt]);

  const pct = progress?.percent;
  const hasPct = typeof pct === 'number' && pct >= 0 && pct <= 100;
  const speed = stage === 'download' ? fmtBytesRate(progress?.speedBps) : null;
  const eta   = fmtEta(progress?.etaS);
  const elapsedLabel = startedAt ? (elapsedS < 60 ? `${elapsedS}s` : `${Math.floor(elapsedS / 60)}m ${elapsedS % 60}s`) : null;
  const detailBits = [
    hasPct ? `${pct}%` : null,
    elapsedLabel ? t('dub.prep_elapsed', { time: elapsedLabel }) : null,
    speed,
    eta,
  ].filter(Boolean);
  const note = stage === 'demucs' && !hasPct
    ? t('dub.prep_demucs_note')
    : null;

  const body = (
    <>
      <Loader className="spinner" size={large ? 28 : 20} color="#d3869b" />
      <span className="dub-prep-overlay__title" style={{ fontSize: large ? '0.95rem' : '0.85rem' }}>
        {LABEL[stage] || t('dub.prep_preparing')}
      </span>
      {hasPct && (
        <div className="dub-prep-bar" aria-label={`${pct}%`}>
          <div className="dub-prep-bar__fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      {detailBits.length > 0 && (
        <span className="dub-prep-overlay__detail">{detailBits.join(' · ')}</span>
      )}
      <div className={`dub-prep-chips ${large ? 'dub-prep-chips--lg' : ''}`}>
        {stages.map(s => (
          <span
            key={s}
            className={`dub-prep-chip ${stage === s ? 'is-active' : ''} ${s === 'cached' ? 'is-cached' : ''}`}
          >
            {s === 'cached' ? '⚡' : ''}{t(`dub.prep_chip_${s}`, { defaultValue: s })}
          </span>
        ))}
      </div>
      {note && (
        <span className="dub-prep-overlay__note">{note}</span>
      )}
      <Button variant="danger" size="sm" onClick={onAbort} leading={<Square size={11} />}>
        {t('dub.prep_stop')}
      </Button>
    </>
  );
  return large
    ? <div className="dub-prep-overlay dub-prep-overlay--large">{body}</div>
    : <div className="dub-prep-overlay">{body}</div>;
}

/**
 * TranscribeOverlay — Whisper progress + ETA while transcribing.
 */
function TranscribeOverlay({ elapsed, duration, onAbort }) {
  const { t } = useTranslation();
  const est = duration > 0 ? Math.max(10, Math.ceil(duration / 60) * 3 + 8) : 0;
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <div className="dub-trans-overlay">
      <div className="dub-trans-overlay__head">
        <Loader className="spinner" size={18} color="#d3869b" />
        <span className="dub-trans-overlay__title">{t('dub.transcribing')}</span>
      </div>
      <div className="dub-trans-overlay__stats">
        <span>⏱ {mm}:{ss} {t('dub.elapsed')}</span>
        {est > 0 && <span>~{Math.max(0, est - elapsed)}{t('dub.remaining')}</span>}
      </div>
      {duration > 0 && (
        <div className="dub-trans-overlay__bar">
          <Progress value={Math.min(95, (elapsed / est) * 100)} tone="brand" size="sm" />
        </div>
      )}
      <Button variant="danger" size="sm" onClick={onAbort} leading={<Square size={11} />}>
        {t('dub.prep_stop')}
      </Button>
    </div>
  );
}

/**
 * FooterBtn — the gradient-per-tone download button family in the action footer.
 * Uses the legacy .btn-primary as the shape/hover base, just picks a tone class.
 * forwardRef so <Menu> can wire its triggerRef to the underlying button —
 * without this the Export menu can't compute coords and never opens.
 */
const FooterBtn = React.forwardRef(function FooterBtn(
  { tone = 'idle', sm = false, disabled, onClick, icon, label, ...rest },
  ref,
) {
  const cls = [
    'btn-primary',
    'dub-footer-btn',
    sm && 'dub-footer-btn--sm',
    `dub-footer-btn--${tone}`,
  ].filter(Boolean).join(' ');
  return (
    <button ref={ref} className={cls} disabled={disabled} onClick={onClick} {...rest}>
      {icon} {label}
    </button>
  );
});
