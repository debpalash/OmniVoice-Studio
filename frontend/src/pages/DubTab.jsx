import React, { Suspense, lazy, useState, useEffect, useCallback } from 'react';
import {
  PanelLeftOpen, PanelLeftClose, Film, Save, UploadCloud, Sparkles, Loader, Square,
  FileText, Play, DownloadIcon, Volume2, Link2,
  Languages, ChevronDown, ChevronUp, Wand2, Trash2, Check, Globe, UserSquare2, User, AlertCircle,
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
import GlossaryPanel from '../components/GlossaryPanel';
import ExportModal from '../components/ExportModal';
import './DubTab.css';

const DubSegmentTable = lazy(() => import('../components/DubSegmentTable'));

const LazyFallback = () => (
  <div className="dub-lazy-fallback">Loading…</div>
);

export default function DubTab(props) {
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
    handleDubAbort, handleDubUpload, handleDubIngestUrl, handleDubRetryTranscribe, handleDubStop, handleDubGenerate,
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
  const dubPrepStage      = useAppStore(s => s.dubPrepStage);
  const dubFilename       = useAppStore(s => s.dubFilename);
  const dubDuration       = useAppStore(s => s.dubDuration);
  const dubSegments       = useAppStore(s => s.dubSegments);
  const setDubSegments    = useAppStore(s => s.setDubSegments);
  const dubTranscript     = useAppStore(s => s.dubTranscript);
  const dubLang           = useAppStore(s => s.dubLang);
  const setDubLang        = useAppStore(s => s.setDubLang);
  const dubLangCode       = useAppStore(s => s.dubLangCode);
  const setDubLangCode    = useAppStore(s => s.setDubLangCode);
  const dubInstruct       = useAppStore(s => s.dubInstruct);
  const setDubInstruct    = useAppStore(s => s.setDubInstruct);
  const dubTracks         = useAppStore(s => s.dubTracks);
  const dubError          = useAppStore(s => s.dubError);
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

  const showIdleSkeleton = !(dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done'));
  const [ingestUrl, setIngestUrl] = useState('');
  const [previewMode, setPreviewMode] = useState('original'); // 'original' | 'dubbed'
  const [exportOpen, setExportOpen] = useState(false);

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
    const progressToast = toast.loading(`Installing ${engineId}…`);
    try {
      const res = await installTranslationEngine(engineId);
      await refreshEngines();
      if (res.restart_required) {
        toast(`${engineId} installed. Restart the backend to load it.`, { icon: '🔄', id: progressToast, duration: 7000 });
      } else if (res.status === 'already_installed') {
        toast(`${engineId} was already installed`, { icon: 'ℹ️', id: progressToast });
      } else {
        toast.success(`${engineId} installed`, { id: progressToast });
      }
    } catch (err) {
      toast.error(`Install failed: ${String(err.message || err).slice(0, 200)}`, { id: progressToast, duration: 8000 });
    } finally {
      setEngineInstalling(null);
    }
  };

  // Collapse secondary settings (Language/ISO/Style/Engine/Quality) into an
  // accordion. Once the user has translated, the row's job is done; show a
  // one-line summary instead of the full 5-col grid.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hasAnyTranslation = dubSegments.some(s => s.text_original && s.text_original !== s.text);

  // Glossary: hide behind a chip when empty, auto-open once terms exist.
  const glossaryTermCount = useAppStore(s => s.glossaryTerms.length);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const glossaryVisible = glossaryOpen || glossaryTermCount > 0;

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
      // Default to "all" available tracks — YouTube's auto-translator makes
      // every major language available on demand, so letting yt-dlp grab
      // them all up-front means switching target language later doesn't
      // need another round trip.
      subLangs: fetchYtSubs ? undefined : undefined,
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
                title="Toggle Sidebar"
              >
                {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
              </Button>
              <Film className="label-icon" size={11} />
              <span className="dub-head__filename">{dubVideoFile ? dubVideoFile.name : 'Video Dubbing Studio'}</span>
              {dubVideoFile && <span className="dub-head__meta">· {(dubVideoFile.size / 1024 / 1024).toFixed(1)} MB</span>}
              {activeProjectName && activeProjectName !== dubFilename && (
                <span className="dub-head__project">— {activeProjectName}</span>
              )}
            </div>
            <div className="dub-head__actions">
              <Button variant="subtle" size="sm" disabled leading={<Save size={9} />}>Save</Button>
              <Button variant="ghost"  size="sm" disabled>Reset</Button>
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
              {handleDubRetryTranscribe && (
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={handleDubRetryTranscribe}
                  leading={<Sparkles size={10} />}
                >
                  Retry transcription
                </Button>
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
                        <PrepOverlay stage={dubPrepStage} onAbort={handleDubAbort} />
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
                      <Film size={13} /> Change file
                    </label>
                    <button className="btn-primary dub-change-row__cta"
                      onClick={handleDubUpload}
                      disabled={dubStep === 'uploading' || dubStep === 'transcribing'}>
                      {dubStep === 'uploading' || dubStep === 'transcribing'
                        ? <><Loader className="spinner" size={14} /> Processing…</>
                        : <><Sparkles size={14} /> Upload &amp; Transcribe</>}
                    </button>
                  </div>
                </>
              ) : dubStep === 'uploading' ? (
                <PrepOverlay stage={dubPrepStage} onAbort={handleDubAbort} large />
              ) : (
                <label htmlFor="video-upload" className="dub-idle-drop"
                  onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('is-dragging'); }}
                  onDragLeave={e => { e.currentTarget.classList.remove('is-dragging'); }}
                  onDrop={e => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('is-dragging');
                    const file = e.dataTransfer.files[0];
                    if (file && file.type.startsWith('video/')) {
                      setDubVideoFile(file);
                      setDubStep('idle');
                      fileToMediaUrl(file, null).then(urls => setDubLocalBlobUrl(urls));
                    }
                  }}>
                  <div className="dub-idle-drop__puck">
                    <UploadCloud color="#d3869b" size={28} />
                  </div>
                  <div className="dub-idle-drop__lines">
                    <div className="dub-idle-drop__title">Drop video here</div>
                    <div className="dub-idle-drop__sub">MP4 · MOV · MKV · WEBM</div>
                  </div>
                  <div
                    className="dub-ingest-row"
                    onClick={e => e.preventDefault()}
                  >
                    <Link2 size={13} color="#a89984" />
                    <input
                      type="text"
                      placeholder="…or paste YouTube / video URL"
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
                      Ingest
                    </button>
                  </div>
                  <label
                    className="dub-ingest-sub-opt"
                    title="When the URL is a caption-bearing host (YouTube, Vimeo, TED…), also pull the original captions and any YouTube auto-translations. Seeds the editor without running Whisper; skip Translate All for languages YouTube already covers."
                    onClick={e => { e.stopPropagation(); }}
                  >
                    <input
                      type="checkbox"
                      checked={fetchYtSubs}
                      onChange={e => setFetchYtSubs(e.target.checked)}
                      onClick={e => e.stopPropagation()}
                    />
                    <span>Pull YouTube captions + auto-translations</span>
                  </label>
                </label>
              )}

              <input type="file" accept="video/*" id="video-upload" className="dub-hidden-file"
                onChange={e => {
                  const file = e.target.files[0];
                  if (!file) return;
                  setDubVideoFile(file);
                  setDubStep('idle');
                  setDubLocalBlobUrl(prev => { fileToMediaUrl(file, prev).then(urls => setDubLocalBlobUrl(urls)); return prev; });
                }} />

              <div className="dub-cast dub-cast--muted">
                <div className="dub-cast__row">
                  <span className="dub-cast__kicker">CAST</span>
                  <span className="dub-cast__label">Speaker 1:</span>
                  <span className="dub-cast--muted__chip">Default</span>
                </div>
              </div>
            </div>

            {/* RIGHT: Ghost settings + segment table (only when video loaded) */}
            {dubVideoFile ? (
            <div className="studio-panel dub-panel-col">
              <div className="dub-skel-settings">
                <div className="dub-skel-field">
                  <div className="label-row"><Globe className="label-icon" size={9} /> Language</div>
                  <select className="input-base input-base--xs" disabled>
                    <option>Auto</option>
                  </select>
                </div>
                <div className="dub-skel-field--sm">
                  <div className="label-row">ISO Code</div>
                  <select className="input-base input-base--xs" disabled>
                    <option>en — English</option>
                  </select>
                </div>
                <div className="dub-skel-field">
                  <div className="label-row"><UserSquare2 className="label-icon" size={9} /> Style</div>
                  <input className="input-base input-base--xs" disabled placeholder="e.g. female" />
                </div>
                <button disabled className="dub-skel-translate-btn">
                  <Languages size={10} /> Translate All
                </button>
              </div>
              <div className="dub-skel-transcript-toggle">
                <div className="override-toggle dub-skel-transcript-toggle__inner">
                  <span><FileText size={10} className="dub-inline-icon" /> Transcript</span>
                  <ChevronDown size={10} />
                </div>
              </div>
              <div className="segment-table dub-skel-table">
                <div className="segment-header">
                  <span className="dub-skel-header-time">Time</span>
                  <span className="dub-skel-header-spkr">Spkr</span>
                  <span className="dub-skel-header-text">Text</span>
                  <span className="dub-skel-header-voice">Voice</span>
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
                <Play size={11} /> Generate Dub
              </button>
              <button className="btn-primary dub-skel-gen-btn" disabled>
                <Download size={11} /> MP4
              </button>
              <button className="btn-primary dub-skel-gen-btn" disabled>
                <Volume2 size={11} /> WAV
              </button>
              <button className="btn-primary dub-skel-gen-btn" disabled>
                <FileText size={11} /> SRT
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
                title="Toggle Sidebar"
              >
                {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
              </Button>
              <FileText className="label-icon" size={11} />
              <span className="dub-head__filename">{dubFilename}</span>
              <span className="dub-head__meta">· {formatTime(dubDuration)} · {dubSegments.length} segs</span>
              {activeProjectName && activeProjectName !== dubFilename && (
                <span className="dub-head__project">— {activeProjectName}</span>
              )}
            </div>
            <div className="dub-head__actions">
              <Button variant="subtle" size="sm" onClick={saveProject} leading={<Save size={9} />}>Save</Button>
              <Button variant="danger" size="sm" onClick={resetDub}>Reset</Button>
            </div>
          </div>

          <div className="dub-split-grid dub-split-2">
            {/* LEFT: Waveform + Video */}
            <div className="studio-panel dub-panel-col">
              {hasDubbedTrack && (
                <div className="dub-preview-toggle">
                  <span className="dub-preview-toggle__kicker">Preview</span>
                  <Segmented
                    size="sm"
                    value={previewMode}
                    onChange={setPreviewMode}
                    items={[
                      { value: 'original', label: 'Original' },
                      { value: 'dubbed',   label: `Dubbed (${dubLangCode})` },
                    ]}
                  />
                  {previewMode === 'dubbed' && (
                    <span className="dub-preview-toggle__hint">first play may take a moment to mux</span>
                  )}
                </div>
              )}
              <WaveformTimeline
                key={videoSrc}
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
                        {dubStep === 'stopping' ? 'Stopping…' : `Dubbing ${dubProgress.current}/${dubProgress.total}…`}
                      </span>
                    </div>
                    {dubStep === 'generating' && (
                      <>
                        <div className="dub-gen-overlay__stats">
                          <span>⏱ {fmtDur(genElapsed)} elapsed</span>
                          {genRemaining !== null && <span>~{fmtDur(genRemaining)} remaining</span>}
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
                    <span className="dub-cast__kicker" title="Assign a voice to each detected speaker. Cross-lingual clones keep the same speaker identity in a new language.">CAST</span>
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
                              <option value={autoId}>🎤 From video · {clone.duration.toFixed(1)}s</option>
                            )}
                            <option value="">Default</option>
                            {profiles.length > 0 && (
                              <optgroup label="Clone Profiles">
                                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </optgroup>
                            )}
                            {PRESETS.length > 0 && (
                              <optgroup label="Design Presets">
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
            </div>

            {/* RIGHT: Settings + Segment Table */}
            <div className="studio-panel dub-panel-col">
              {/* Collapsed: one-line summary + Translate All. Expanded: full grid. */}
              {!settingsOpen && (
                <div className="dub-settings-summary">
                  <button
                    type="button"
                    className="dub-settings-summary__trigger"
                    onClick={() => setSettingsOpen(true)}
                    title="Edit translation settings"
                  >
                    <ChevronDown size={10} />
                    <span><strong>{dubLang}</strong> · {dubLangCode} · {translateQuality} · {translateProvider}</span>
                    {dubInstruct && <span className="dub-settings-summary__style">style: {dubInstruct}</span>}
                  </button>
                  <Button
                    variant="subtle" size="sm"
                    onClick={handleTranslateAll}
                    disabled={isTranslating || !dubSegments.length}
                    loading={isTranslating}
                    leading={!isTranslating && <Languages size={10} />}
                  >
                    {isTranslating ? 'Translating…' : hasAnyTranslation ? 'Re-translate' : 'Translate All'}
                  </Button>
                  <Button
                    variant="subtle" size="sm"
                    onClick={handleCleanupSegments}
                    disabled={!dubSegments.length || !dubJobId}
                    title="Merge tiny fragments and adjacent short segments"
                    leading={<Wand2 size={10} />}
                  >
                    Clean Up
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
                    title="Collapse translation settings"
                  >
                    <ChevronUp size={10} />
                  </button>
                  <div className="dub-settings-field">
                    <div className="label-row"><Globe className="label-icon" size={9} /> Language</div>
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
                      <optgroup label="Popular">
                        {POPULAR_LANGS.map(l => <option key={`p-${l}`} value={l}>{l}</option>)}
                      </optgroup>
                      <optgroup label="All languages">
                        {ALL_LANGUAGES
                          .filter(l => !POPULAR_LANGS.includes(l))
                          .map(l => <option key={l} value={l}>{l}</option>)}
                      </optgroup>
                    </select>
                  </div>
                  <div className="dub-settings-field dub-settings-field--iso">
                    <div className="label-row">ISO</div>
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
                  <div className="dub-settings-field">
                    <div className="label-row">
                      Engine
                      {activeEngineUnavailable && !enginesSandboxed && (
                        <button
                          type="button"
                          className="dub-engine-install-chip"
                          onClick={() => handleInstallEngine(translateProvider)}
                          disabled={engineInstalling === translateProvider}
                          title={activeEngineEntry?.notes || 'Install this engine'}
                        >
                          {engineInstalling === translateProvider ? '…installing' : `+ install ${activeEngineEntry?.pip_package || ''}`}
                        </button>
                      )}
                      {activeEngineUnavailable && enginesSandboxed && (
                        <span className="dub-engine-install-chip dub-engine-install-chip--disabled" title="Installs are disabled in packaged builds">
                          needs dev install
                        </span>
                      )}
                    </div>
                    <select className="input-base dub-engine-select" value={translateProvider} onChange={e => setTranslateProvider(e.target.value)}>
                      {(engines.length ? engines : [
                        { id: 'argos', display_name: 'Argos (Fast Local)', installed: true },
                        { id: 'nllb', display_name: 'NLLB (Heavy Local)', installed: true },
                        { id: 'google', display_name: 'Google (Online)', installed: true },
                        { id: 'openai', display_name: 'OpenAI (LLM)', installed: true },
                      ]).map(p => (
                        <option key={p.id} value={p.id}>
                          {p.installed ? p.display_name : `${p.display_name} — needs install`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="dub-settings-field dub-settings-field--quality">
                    <div className="label-row" title="Cinematic = 3-step LLM refinement (translate → reflect → adapt). Needs an LLM configured.">Quality</div>
                    <Segmented
                      size="sm"
                      value={translateQuality}
                      onChange={setTranslateQuality}
                      items={[
                        { value: 'fast',      label: 'Fast' },
                        { value: 'cinematic', label: 'Cinematic' },
                      ]}
                    />
                  </div>
                  <div className="dub-settings-field dub-settings-field--style">
                    <div className="label-row"><UserSquare2 className="label-icon" size={9} /> Style <span className="dub-settings-field__hint">optional</span></div>
                    <input className="input-base input-base--xs" placeholder="e.g. female" value={dubInstruct} onChange={e => setDubInstruct(e.target.value)} />
                  </div>
                </div>
                <div className="dub-settings-bar__actions">
                  <Button
                    variant="subtle" size="sm"
                    onClick={() => editSegments(dubSegments.map(s => ({ ...s, text: s.text_original || s.text, translate_error: undefined })))}
                    disabled={!dubSegments.some(s => s.text_original && s.text_original !== s.text)}
                    title="Restore all segments to the original transcribed text"
                  >
                    ↺ Restore
                  </Button>
                  <Button
                    variant="subtle" size="sm"
                    onClick={handleCleanupSegments}
                    disabled={!dubSegments.length || !dubJobId}
                    title="Merge tiny fragments and adjacent short segments"
                    leading={<Wand2 size={10} />}
                  >
                    Clean Up
                  </Button>
                  <Button
                    variant="primary" size="sm"
                    onClick={handleTranslateAll}
                    disabled={isTranslating || !dubSegments.length}
                    loading={isTranslating}
                    leading={!isTranslating && <Languages size={10} />}
                  >
                    {isTranslating ? 'Translating…' : 'Translate All'}
                  </Button>
                </div>
              </div>
              )}

              {dubTranscript && (
                <div className="dub-transcript-toggle-wrap">
                  <div className="override-toggle dub-transcript-toggle__inner" onClick={() => setShowTranscript(!showTranscript)}>
                    <span><FileText size={10} className="dub-inline-icon" /> Transcript</span>
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
                  onClick={() => setGlossaryOpen(true)}
                  title="Pin translations for recurring terms (names, brand words, jargon)"
                >
                  + Glossary (0)
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
                  />
                </div>
              )}

              {/* "Apply Voice to All" row removed 2026-04-21 — redundant
                  with the CAST strip in the left column, which does the same
                  thing per-speaker (and handles the multi-speaker case cleanly). */}

              {selectedSegIds.size > 0 && (
                <div className="dub-bulk-row dub-bulk-row--select">
                  <span className="dub-bulk-row__label-brand">{selectedSegIds.size} selected</span>
                  <select className="input-base dub-bulk-select dub-bulk-select--voice"
                    value="" onChange={(e) => { const v = e.target.value; if (v === '__clear__') bulkApplyToSelected({ profile_id: '' }); else if (v) bulkApplyToSelected({ profile_id: v }); }}>
                    <option value="">Set voice…</option>
                    <option value="__clear__">⊘ Default</option>
                    {profiles.filter(p => !p.instruct).length > 0 && (
                      <optgroup label="Clone">
                        {profiles.filter(p => !p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                    {profiles.filter(p => !!p.instruct).length > 0 && (
                      <optgroup label="Designed">
                        {profiles.filter(p => !!p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                  </select>
                  <select className="input-base dub-bulk-select dub-bulk-select--lang"
                    value="" onChange={(e) => { if (e.target.value === '__def__') bulkApplyToSelected({ target_lang: null }); else if (e.target.value) bulkApplyToSelected({ target_lang: e.target.value }); }}>
                    <option value="">Set lang…</option>
                    <option value="__def__">(Default)</option>
                    {LANG_CODES.map(lc => <option key={lc.code} value={lc.code}>{lc.code.toUpperCase()}</option>)}
                  </select>
                  <Button variant="danger" size="sm" onClick={bulkDeleteSelected}>Delete</Button>
                  <Button variant="ghost"  size="sm" onClick={clearSegSelection} className="dub-bulk-row__clear">Clear</Button>
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
                />
              </Suspense>
            </div>
          </div>

          {/* Actions footer */}
          <div className="studio-panel dub-footer-panel">
            {dubStep === 'done' && (
              <div className="dub-footer-banner">
                <Badge tone="success">
                  <Check size={11} /> Done! Tracks: {dubTracks.join(', ')}
                </Badge>
                {incrementalPlan && incrementalPlan.stale?.length > 0 && (
                  <Badge tone="warn" className="dub-footer-banner__badge-gap">
                    {incrementalPlan.stale.length} segment{incrementalPlan.stale.length === 1 ? '' : 's'} changed since last generate
                  </Badge>
                )}
                {incrementalPlan && incrementalPlan.stale?.length === 0 && incrementalPlan.fresh?.length > 0 && (
                  <Badge tone="neutral" className="dub-footer-banner__badge-gap">
                    all {incrementalPlan.fresh.length} segments up to date
                  </Badge>
                )}
              </div>
            )}
            {dubError && (
              <div className="dub-footer-banner">
                <Badge tone="danger">
                  <AlertCircle size={11} /> {dubError}
                </Badge>
              </div>
            )}
            <div className="dub-outputs-row">
              <span className="dub-outputs-title-strong">Output Options:</span>
              <label>
                <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} /> Mix BG Audio
              </label>
              <label title="Export subtitles with translated text on top and original italicised underneath.">
                <input type="checkbox" checked={!!dualSubs} onChange={e => setDualSubs(e.target.checked)} /> Dual subtitles
              </label>
              <label title="Render subtitles directly into the MP4 video stream (hardsubs). Uses the dual-subtitle format when Dual subtitles is on.">
                <input type="checkbox" checked={!!burnSubs} onChange={e => setBurnSubs(e.target.checked)} /> Burn subtitles
              </label>
              <label>
                Default Track:
                <select className="input-base dub-outputs-default" value={defaultTrack} onChange={e => setDefaultTrack(e.target.value)}>
                  <option value="original">Original</option>
                  {dubLangCode && <option value={dubLangCode}>{dubLangCode} (Selected Dub)</option>}
                  {dubTracks.filter(t => t !== dubLangCode).map(t => (
                    <option key={t} value={t}>{t} (Dub)</option>
                  ))}
                </select>
              </label>
            </div>
            {dubTracks.length > 0 && (
              <div className="dub-tracks-row">
                <span className="dub-tracks-row__title">Export Tracks:</span>
                <label className={exportTracks['original'] ? 'is-on' : 'is-off'}>
                  <input type="checkbox" checked={exportTracks['original'] !== false} onChange={e => setExportTracks(prev => ({ ...prev, original: e.target.checked }))} />
                  <span>Original</span>
                </label>
                {dubTracks.map(t => (
                  <label key={t} className={exportTracks[t] !== false ? 'is-on is-success' : 'is-off'}>
                    <input type="checkbox" checked={exportTracks[t] !== false} onChange={e => setExportTracks(prev => ({ ...prev, [t]: e.target.checked }))} />
                    <span className="code">{t}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="dub-footer-btns">
              {dubStep === 'stopping' ? (
                <FooterBtn tone="stopping" disabled icon={<Loader className="spinner" size={9} />} label="Stopping…" />
              ) : dubStep === 'generating' ? (
                <FooterBtn tone="danger" onClick={handleDubStop} icon={<Square size={9} />}
                  label={`Stop (${dubProgress.current}/${dubProgress.total})`} />
              ) : (
                <>
                  <FooterBtn tone={dubSegments.length ? 'idle' : 'idle'} onClick={() => handleDubGenerate()}
                    disabled={!dubSegments.length} icon={<Play size={11} />} label="Generate Dub" />
                  {dubStep === 'done' && incrementalPlan && incrementalPlan.stale?.length > 0 && (
                    <FooterBtn
                      tone="pink"
                      onClick={() => handleDubGenerate({ regenOnly: incrementalPlan.stale, preview: true })}
                      icon={<Play size={11} />}
                      label={`Regen ${incrementalPlan.stale.length} changed`}
                    />
                  )}
                </>
              )}
              <FooterBtn
                tone={dubStep === 'done' ? 'green' : 'idle'}
                disabled={dubStep !== 'done' && !dubSegments.length}
                onClick={() => setExportOpen(true)}
                icon={<Download size={11} />}
                label="Export…"
              />
            </div>
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

const PREP_STAGE_LABEL = {
  download: 'Downloading video…',
  extract:  'Extracting audio…',
  demucs:   'Separating vocals / music (Demucs)…',
  scene:    'Detecting scene cuts…',
  cached:   '⚡ Using cached results…',
};
const PREP_FULL   = ['download', 'extract', 'demucs', 'scene'];
const PREP_CACHED = ['download', 'extract', 'cached'];

/**
 * PrepOverlay — the prepare-upload stage indicator.
 * `large` makes the surrounding frame bigger (used for the empty-state drop zone).
 */
function PrepOverlay({ stage, onAbort, large = false }) {
  const stages = stage === 'cached' ? PREP_CACHED : PREP_FULL;
  const body = (
    <>
      <Loader className="spinner" size={large ? 28 : 20} color="#d3869b" />
      <span className="dub-prep-overlay__title" style={{ fontSize: large ? '0.95rem' : '0.85rem' }}>
        {PREP_STAGE_LABEL[stage] || 'Preparing…'}
      </span>
      <div className={`dub-prep-chips ${large ? 'dub-prep-chips--lg' : ''}`}>
        {stages.map(s => (
          <span
            key={s}
            className={`dub-prep-chip ${stage === s ? 'is-active' : ''} ${s === 'cached' ? 'is-cached' : ''}`}
          >
            {s === 'cached' ? '⚡ cached' : s}
          </span>
        ))}
      </div>
      {stage === 'demucs' && (
        <span className="dub-prep-overlay__note">
          Demucs can take several minutes on long videos. Long audio = longer wait.
        </span>
      )}
      <Button variant="danger" size="sm" onClick={onAbort} leading={<Square size={11} />}>
        Stop
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
  const est = duration > 0 ? Math.max(10, Math.ceil(duration / 60) * 3 + 8) : 0;
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, '0');
  return (
    <div className="dub-trans-overlay">
      <div className="dub-trans-overlay__head">
        <Loader className="spinner" size={18} color="#d3869b" />
        <span className="dub-trans-overlay__title">Transcribing with Whisper…</span>
      </div>
      <div className="dub-trans-overlay__stats">
        <span>⏱ {mm}:{ss} elapsed</span>
        {est > 0 && <span>~{Math.max(0, est - elapsed)}s remaining</span>}
      </div>
      {duration > 0 && (
        <div className="dub-trans-overlay__bar">
          <Progress value={Math.min(95, (elapsed / est) * 100)} tone="brand" size="sm" />
        </div>
      )}
      <Button variant="danger" size="sm" onClick={onAbort} leading={<Square size={11} />}>
        Stop
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
