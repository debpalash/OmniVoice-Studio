import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { API } from '../api/client';
import { listTranslationEngines, installTranslationEngine } from '../api/engines';
import { dubQc } from '../api/dub';
import toast from 'react-hot-toast';
import { toastErrorWithReport } from '../utils/errorToast';
import useTimelineOnsets from '../hooks/useTimelineOnsets';
import ExportModal from '../components/ExportModal';
import DubPipelineStepper from '../components/dub/DubPipelineStepper';
import IdleSkeleton from '../components/dub/IdleSkeleton';
import DubHeader from '../components/dub/DubHeader';
import DubLeftColumn from '../components/dub/DubLeftColumn';
import DubRightColumn from '../components/dub/DubRightColumn';
import DubFooter from '../components/dub/DubFooter';
import '../components/dub/dub.css';

export default function DubTab(props) {
  const { t, i18n } = useTranslation();
  const {
    // Props that stay prop-threaded: non-serialisable state + handlers that
    // close over App.jsx's scope (uploads, SSE wiring, project CRUD, etc.).
    dubVideoFile,
    dubLocalBlobUrl,
    transcribeElapsed,
    translateProvider,
    setTranslateProvider,
    showTranscript,
    setShowTranscript,
    onGlossaryChange,
    profiles,
    segmentPreviewLoading,
    selectedSegIds,
    setDubVideoFile,
    setDubLocalBlobUrl,
    handleDubAbort,
    handleDubUpload,
    handleDubIngestUrl,
    handleDubRetryTranscribe,
    handleDubStop,
    handleDubGenerate,
    handleDubImportSrt,
    handleDubDownload,
    handleDubAudioDownload,
    handleAudioExport,
    speakerClones = {},
    handleSegmentPreview,
    onDirectSegment,
    handleTranslateAll,
    handleCleanupSegments,
    incrementalPlan,
    triggerDownload,
    fileToMediaUrl,
    editSegments,
    saveProject,
    resetDub,
    segmentEditField,
    segmentDelete,
    segmentRestoreOriginal,
    segmentSplit,
    segmentMerge,
    segmentMoveResize,
    timelineSelSegId,
    setTimelineSelSegId,
    toggleSegSelect,
    selectAllSegs,
    clearSegSelection,
    bulkApplyToSelected,
    bulkDeleteSelected,
  } = props;

  // ── Store reads (Phase 2.2) — drop ~30 props from the App.jsx contract.
  const dubJobId = useAppStore((s) => s.dubJobId);
  const dubStep = useAppStore((s) => s.dubStep);
  const setDubStep = useAppStore((s) => s.setDubStep);
  const setDubInputType = useAppStore((s) => s.setDubInputType);
  const dubPrepStage = useAppStore((s) => s.dubPrepStage);
  const dubPrepProgress = useAppStore((s) => s.dubPrepProgress);
  const dubFilename = useAppStore((s) => s.dubFilename);
  const dubDuration = useAppStore((s) => s.dubDuration);
  const dubSegments = useAppStore((s) => s.dubSegments);
  const setDubSegments = useAppStore((s) => s.setDubSegments);
  const dubTranscript = useAppStore((s) => s.dubTranscript);
  const dubLang = useAppStore((s) => s.dubLang);
  const setDubLang = useAppStore((s) => s.setDubLang);
  const dubLangCode = useAppStore((s) => s.dubLangCode);
  const setDubLangCode = useAppStore((s) => s.setDubLangCode);
  const dubNumSpeakers = useAppStore((s) => s.dubNumSpeakers);
  const setDubNumSpeakers = useAppStore((s) => s.setDubNumSpeakers);
  const dubDialect = useAppStore((s) => s.dubDialect);
  const setDubDialect = useAppStore((s) => s.setDubDialect);
  const dubInstruct = useAppStore((s) => s.dubInstruct);
  const setDubInstruct = useAppStore((s) => s.setDubInstruct);
  const dubTracks = useAppStore((s) => s.dubTracks);
  const dubError = useAppStore((s) => s.dubError);
  const dubFailure = useAppStore((s) => s.dubFailure);
  const dubProgress = useAppStore((s) => s.dubProgress);
  const isTranslating = useAppStore((s) => s.isTranslating);
  const preserveBg = useAppStore((s) => s.preserveBg);
  const setPreserveBg = useAppStore((s) => s.setPreserveBg);
  const defaultTrack = useAppStore((s) => s.defaultTrack);
  const setDefaultTrack = useAppStore((s) => s.setDefaultTrack);
  const exportTracks = useAppStore((s) => s.exportTracks);
  const setExportTracks = useAppStore((s) => s.setExportTracks);
  const activeProjectName = useAppStore((s) => s.activeProjectName);
  const translateQuality = useAppStore((s) => s.translateQuality);
  const setTranslateQuality = useAppStore((s) => s.setTranslateQuality);
  // #372: live LLM availability so the Cinematic toggle can refuse the pick
  // (instead of looping the user between two warnings). null until loaded.
  const [llmEndpoint, setLlmEndpoint] = useState(null);
  useEffect(() => {
    let cancelled = false;
    import('../api/client').then(({ apiJson }) =>
      apiJson('/api/settings/llm-endpoint')
        .then((d) => {
          if (!cancelled) setLlmEndpoint(d);
        })
        .catch(() => {
          /* backend mid-boot — guard simply stays permissive */
        }),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const dualSubs = useAppStore((s) => s.dualSubs);
  const setDualSubs = useAppStore((s) => s.setDualSubs);
  const burnSubs = useAppStore((s) => s.burnSubs);
  const setBurnSubs = useAppStore((s) => s.setBurnSubs);
  const timingStrategy = useAppStore((s) => s.timingStrategy);
  const setTimingStrategy = useAppStore((s) => s.setTimingStrategy);

  const showIdleSkeleton = !(
    dubJobId &&
    (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done')
  );
  // Imperative handle to the post-job waveform so the transcript table can
  // seek the player when the user clicks a row.
  const waveformRef = useRef(null);
  const seekWaveform = useCallback((time) => {
    waveformRef.current?.seekTo?.(time);
  }, []);
  // Speech-onset ticks for the timeline editor (#280, item 3). Lazy: only
  // fetched while the editor is live; re-fetched after a re-transcription
  // because the step leaves and re-enters the editing state.
  const editorActive =
    !!dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done');
  const { onsets: timelineOnsets } = useTimelineOnsets(dubJobId, editorActive);
  // "Preview dub here" from a timeline box: park the player at the slot
  // start (so the video frame matches), then synthesize + play the line.
  const onTimelinePreviewSegment = useCallback(
    (seg) => {
      seekWaveform(seg.start);
      handleSegmentPreview?.(seg, { preventDefault() {} });
    },
    [seekWaveform, handleSegmentPreview],
  );
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
    try {
      localStorage.setItem('omnivoice.dubbingDemoDismissed', '1');
    } catch {
      /* noop */
    }
  };
  const [previewMode, setPreviewMode] = useState('original'); // 'original' | 'dubbed'
  const [exportOpen, setExportOpen] = useState(false);
  const [qcRunning, setQcRunning] = useState(false);

  // Multi-language mode
  const [multiLangMode, setMultiLangMode] = useState(false);
  const [multiLangs, setMultiLangs] = useState([]);
  // Landing "Advanced" disclosure (pre-upload options).
  const [landingAdvOpen, setLandingAdvOpen] = useState(false);

  // Generate CTA — when multi-language mode has picks, dub each language
  // sequentially; every run appends its track to dubbed_tracks, so the
  // preview switcher pills fill up one by one.
  const onGenerateClick = useCallback(async () => {
    if (multiLangMode && multiLangs.length > 0) {
      try {
        for (const l of multiLangs) {
          setDubLang(l.lang);
          setDubLangCode(l.code); // keep UI/exports in sync
          // eslint-disable-next-line no-await-in-loop
          await handleDubGenerate({ langOverride: { language: l.lang, language_code: l.code } });
        }
      } catch {
        /* a failed language stops the batch; its error is already surfaced */
      }
    } else {
      handleDubGenerate();
    }
  }, [multiLangMode, multiLangs, handleDubGenerate, setDubLang, setDubLangCode]);

  // Live ETA while generating — elapsed ticks each second; remaining is
  // extrapolated from the current/total rate so it's only meaningful once
  // at least one segment has rendered and ~2s of clock has passed.
  const [genElapsed, setGenElapsed] = useState(0);
  useEffect(() => {
    if (dubStep !== 'generating') {
      setGenElapsed(0);
      return;
    }
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
  useEffect(() => {
    refreshEngines();
  }, [refreshEngines]);
  const activeEngineEntry = engines.find((e) => e.id === translateProvider);
  const activeEngineUnavailable = activeEngineEntry && !activeEngineEntry.installed;
  const handleInstallEngine = async (engineId) => {
    if (!engineId || enginesSandboxed) return;
    setEngineInstalling(engineId);
    const progressToast = toast.loading(t('dub.install_progress', { engine: engineId }));
    try {
      const res = await installTranslationEngine(engineId);
      await refreshEngines();
      if (res.restart_required) {
        toast(t('dub.install_restart', { engine: engineId }), {
          icon: '🔄',
          id: progressToast,
          duration: 7000,
        });
      } else if (res.status === 'already_installed') {
        toast(t('dub.install_already', { engine: engineId }), { icon: 'ℹ️', id: progressToast });
      } else {
        toast.success(t('dub.install_ok', { engine: engineId }), { id: progressToast });
      }
    } catch (err) {
      toast.dismiss(progressToast);
      toastErrorWithReport(
        t('dub.install_failed', { message: String(err.message || err).slice(0, 200) }),
        err,
      );
    } finally {
      setEngineInstalling(null);
    }
  };

  // Secondary settings (Language/ISO/Style/Engine/Quality/Multi-lang) are
  // expanded by default so the user can pick a target language and quality
  // without an extra click on first open. They stay an accordion so the
  // user can collapse them once happy with the choice.
  const [settingsOpen, setSettingsOpen] = useState(true);
  const hasAnyTranslation = dubSegments.some((s) => s.text_original && s.text_original !== s.text);

  // Glossary: hide behind a chip when empty, auto-open once terms exist.
  const glossaryTermCount = useAppStore((s) => s.glossaryTerms.length);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [glossaryHidden, setGlossaryHidden] = useState(false);
  const glossaryVisible = glossaryOpen || (glossaryTermCount > 0 && !glossaryHidden);

  // Phase 4.3 — between-stage checkpoint banner.
  const reviewMode = useAppStore((s) => s.reviewMode);
  const [dismissedStages, setDismissedStages] = useState(() => new Set());
  const hasTranslations = dubSegments.some((s) => s.text_original && s.text_original !== s.text);
  const checkpointStage =
    dubStep === 'editing' && !hasTranslations
      ? 'asr'
      : dubStep === 'editing' && hasTranslations
        ? 'translate'
        : dubStep === 'done'
          ? 'done'
          : null;
  const showCheckpoint =
    reviewMode === 'on' && checkpointStage && !dismissedStages.has(checkpointStage);
  const onCheckpointContinue = () => {
    if (checkpointStage === 'asr') handleTranslateAll?.();
    else if (checkpointStage === 'translate') handleDubGenerate?.();
  };
  const onCheckpointDismiss = () => {
    setDismissedStages((prev) => {
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
  const hasDubbedTrack =
    dubStep === 'done' &&
    dubLangCode &&
    dubLangCode !== 'und' &&
    (dubTracks?.length > 0 || !!dubTracks);
  // Cache-busting nonce, bumped every time a generation completes (see
  // useDubWorkflow's done handler). The preview URL is otherwise identical
  // across re-dubs, so the WebView could keep serving the previously
  // buffered MP4 and the user would see the old dub after editing +
  // regenerating (#281). The backend ignores `v`.
  const dubGenNonce = useAppStore((s) => s.dubGenNonce);
  // previewMode is 'original' or a dubbed language code (multi-language switcher).
  const previewIsDub = previewMode !== 'original' && hasDubbedTrack;
  const videoSrc = previewIsDub
    ? `${API}/dub/preview-video/${dubJobId}?lang=${encodeURIComponent(previewMode)}&preserve_bg=${preserveBg ? 1 : 0}&v=${dubGenNonce}`
    : `${API}/dub/media/${dubJobId}`;
  // When a dub finishes, jump the preview to the freshly-dubbed language so the
  // result plays immediately — the user can tap back to Original any time.
  useEffect(() => {
    if (hasDubbedTrack && previewMode === 'original' && dubLangCode && dubLangCode !== 'und') {
      setPreviewMode(dubLangCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDubbedTrack, dubLangCode]);

  // Second-pass timing QC (Wave 3.3): re-recognize the dubbed audio and merge
  // the per-line drift scores back onto the segments so DubSegmentRow can flag
  // lines worth a re-listen. Non-destructive — generated text is untouched.
  const handleDubQc = useCallback(async () => {
    if (!dubJobId || qcRunning) return;
    setQcRunning(true);
    const loadingId = toast.loading(t('dub.qc_running', { defaultValue: 'Checking dub timing…' }));
    try {
      const lang = previewMode !== 'original' ? previewMode : undefined;
      const res = await dubQc(dubJobId, lang);
      const byId = new Map((res.segments || []).map((q) => [String(q.seg_id), q]));
      setDubSegments(
        dubSegments.map((s, i) => {
          const q = byId.get(String(s.id ?? i));
          if (!q) return s;
          return {
            ...s,
            qc_drift: q.drift,
            qc_flagged: q.flagged,
            qc_recognized: q.recognized_text,
            ...(q.measured_start != null
              ? { qc_measured_start: q.measured_start, qc_measured_end: q.measured_end }
              : {}),
          };
        }),
      );
      if (res.flagged_count > 0) {
        toast(
          t('dub.qc_result', {
            flagged: res.flagged_count,
            total: res.total,
            defaultValue: '{{flagged}} of {{total}} lines may need a re-listen',
          }),
          { icon: '⚠️', id: loadingId, duration: 6000 },
        );
      } else {
        toast.success(
          t('dub.qc_clean', {
            total: res.total,
            defaultValue: 'All {{total}} lines match the script',
          }),
          { id: loadingId },
        );
      }
    } catch (err) {
      toast.dismiss(loadingId);
      toastErrorWithReport(
        t('dub.qc_failed', {
          message: String(err?.message || err).slice(0, 200),
          defaultValue: 'Timing check failed: {{message}}',
        }),
        err,
      );
    } finally {
      setQcRunning(false);
    }
  }, [dubJobId, qcRunning, previewMode, dubSegments, setDubSegments, t]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Pipeline spine — shown once a file/job is in play so the user always
          knows which stage they're at (Upload → … → Export). */}
      {(dubVideoFile || dubJobId || dubStep !== 'idle') && <DubPipelineStepper dubStep={dubStep} />}
      {/* ── Idle: show full editor skeleton with drop zone ── */}
      {showIdleSkeleton && (
        <IdleSkeleton
          t={t}
          dubVideoFile={dubVideoFile}
          activeProjectName={activeProjectName}
          dubFilename={dubFilename}
          dubError={dubError}
          dubJobId={dubJobId}
          dubStep={dubStep}
          dubFailure={dubFailure}
          handleDubRetryTranscribe={handleDubRetryTranscribe}
          handleDubImportSrt={handleDubImportSrt}
          dubLocalBlobUrl={dubLocalBlobUrl}
          dubPrepStage={dubPrepStage}
          dubPrepProgress={dubPrepProgress}
          handleDubAbort={handleDubAbort}
          transcribeElapsed={transcribeElapsed}
          dubDuration={dubDuration}
          dubNumSpeakers={dubNumSpeakers}
          setDubNumSpeakers={setDubNumSpeakers}
          handleDubUpload={handleDubUpload}
          demoDismissed={demoDismissed}
          dismissDubDemo={dismissDubDemo}
          setDubVideoFile={setDubVideoFile}
          setDubInputType={setDubInputType}
          setDubStep={setDubStep}
          fileToMediaUrl={fileToMediaUrl}
          setDubLocalBlobUrl={setDubLocalBlobUrl}
          ingestUrl={ingestUrl}
          setIngestUrl={setIngestUrl}
          onIngestUrl={onIngestUrl}
          fetchYtSubs={fetchYtSubs}
          setFetchYtSubs={setFetchYtSubs}
          dubLangCode={dubLangCode}
          setDubLangCode={setDubLangCode}
          setDubLang={setDubLang}
          landingAdvOpen={landingAdvOpen}
          setLandingAdvOpen={setLandingAdvOpen}
          dubInstruct={dubInstruct}
          setDubInstruct={setDubInstruct}
        />
      )}

      {/* ── After transcription: side-by-side editor ── */}
      {dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done') && (
        <div className="flex-1 flex flex-col min-h-0">
          <DubHeader
            t={t}
            dubFilename={dubFilename}
            dubDuration={dubDuration}
            dubSegments={dubSegments}
            activeProjectName={activeProjectName}
            saveProject={saveProject}
            resetDub={resetDub}
            dubStep={dubStep}
            handleDubStop={handleDubStop}
            dubProgress={dubProgress}
            onGenerateClick={onGenerateClick}
            multiLangMode={multiLangMode}
            multiLangs={multiLangs}
            incrementalPlan={incrementalPlan}
            handleDubGenerate={handleDubGenerate}
            qcRunning={qcRunning}
            handleDubQc={handleDubQc}
            setExportOpen={setExportOpen}
          />
          <div className="grid grid-cols-2 max-[1000px]:grid-cols-1 max-[1000px]:grid-rows-[auto_1fr] gap-[6px] flex-1 min-h-0 overflow-hidden">
            <DubLeftColumn
              hasDubbedTrack={hasDubbedTrack}
              t={t}
              previewMode={previewMode}
              setPreviewMode={setPreviewMode}
              dubTracks={dubTracks}
              videoSrc={videoSrc}
              waveformRef={waveformRef}
              dubJobId={dubJobId}
              dubSegments={dubSegments}
              timelineOnsets={timelineOnsets}
              timelineSelSegId={timelineSelSegId}
              setTimelineSelSegId={setTimelineSelSegId}
              incrementalPlan={incrementalPlan}
              segmentMoveResize={segmentMoveResize}
              segmentDelete={segmentDelete}
              onTimelinePreviewSegment={onTimelinePreviewSegment}
              dubStep={dubStep}
              dubProgress={dubProgress}
              fmtDur={fmtDur}
              genElapsed={genElapsed}
              genRemaining={genRemaining}
              speakerClones={speakerClones}
              setDubSegments={setDubSegments}
              profiles={profiles}
              settingsOpen={settingsOpen}
              setSettingsOpen={setSettingsOpen}
              dubLang={dubLang}
              dubLangCode={dubLangCode}
              translateQuality={translateQuality}
              activeEngineUnavailable={activeEngineUnavailable}
              translateProvider={translateProvider}
              dubInstruct={dubInstruct}
              setDubInstruct={setDubInstruct}
              handleTranslateAll={handleTranslateAll}
              isTranslating={isTranslating}
              hasAnyTranslation={hasAnyTranslation}
              handleCleanupSegments={handleCleanupSegments}
              setDubLang={setDubLang}
              setDubLangCode={setDubLangCode}
              dubDialect={dubDialect}
              setDubDialect={setDubDialect}
              i18n={i18n}
              enginesSandboxed={enginesSandboxed}
              handleInstallEngine={handleInstallEngine}
              engineInstalling={engineInstalling}
              activeEngineEntry={activeEngineEntry}
              engines={engines}
              setTranslateProvider={setTranslateProvider}
              setTranslateQuality={setTranslateQuality}
              llmEndpoint={llmEndpoint}
              multiLangMode={multiLangMode}
              setMultiLangMode={setMultiLangMode}
              multiLangs={multiLangs}
              setMultiLangs={setMultiLangs}
              editSegments={editSegments}
            />
            <DubRightColumn
              t={t}
              preserveBg={preserveBg}
              setPreserveBg={setPreserveBg}
              dualSubs={dualSubs}
              setDualSubs={setDualSubs}
              burnSubs={burnSubs}
              setBurnSubs={setBurnSubs}
              defaultTrack={defaultTrack}
              setDefaultTrack={setDefaultTrack}
              dubLangCode={dubLangCode}
              dubTracks={dubTracks}
              timingStrategy={timingStrategy}
              setTimingStrategy={setTimingStrategy}
              dubTranscript={dubTranscript}
              showTranscript={showTranscript}
              setShowTranscript={setShowTranscript}
              dubJobId={dubJobId}
              glossaryVisible={glossaryVisible}
              setGlossaryOpen={setGlossaryOpen}
              setGlossaryHidden={setGlossaryHidden}
              glossaryTermCount={glossaryTermCount}
              dubLang={dubLang}
              dubSegments={dubSegments}
              onGlossaryChange={onGlossaryChange}
              selectedSegIds={selectedSegIds}
              bulkApplyToSelected={bulkApplyToSelected}
              speakerClones={speakerClones}
              profiles={profiles}
              clearSegSelection={clearSegSelection}
              bulkDeleteSelected={bulkDeleteSelected}
              showCheckpoint={showCheckpoint}
              checkpointStage={checkpointStage}
              onCheckpointContinue={onCheckpointContinue}
              onCheckpointDismiss={onCheckpointDismiss}
              isTranslating={isTranslating}
              segmentPreviewLoading={segmentPreviewLoading}
              toggleSegSelect={toggleSegSelect}
              selectAllSegs={selectAllSegs}
              segmentEditField={segmentEditField}
              segmentDelete={segmentDelete}
              segmentRestoreOriginal={segmentRestoreOriginal}
              handleSegmentPreview={handleSegmentPreview}
              onDirectSegment={onDirectSegment}
              segmentSplit={segmentSplit}
              segmentMerge={segmentMerge}
              seekWaveform={seekWaveform}
              timelineSelSegId={timelineSelSegId}
              dubStep={dubStep}
              dubProgress={dubProgress}
            />
          </div>
          <DubFooter
            t={t}
            dubStep={dubStep}
            dubTracks={dubTracks}
            incrementalPlan={incrementalPlan}
            dubError={dubError}
            dubFailure={dubFailure}
            exportTracks={exportTracks}
            setExportTracks={setExportTracks}
            dubSegments={dubSegments}
            translateQuality={translateQuality}
          />
        </div>
      )}

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        jobId={dubJobId}
        filename={dubFilename}
        dubTracks={dubTracks}
        dubLangCode={dubLangCode}
        preserveBg={preserveBg}
        setPreserveBg={setPreserveBg}
        defaultTrack={defaultTrack}
        setDefaultTrack={setDefaultTrack}
        exportTracks={exportTracks}
        setExportTracks={setExportTracks}
        dualSubs={dualSubs}
        setDualSubs={setDualSubs}
        burnSubs={burnSubs}
        setBurnSubs={setBurnSubs}
        API={API}
        triggerDownload={triggerDownload}
        handleDubDownload={handleDubDownload}
        handleDubAudioDownload={handleDubAudioDownload}
        handleAudioExport={handleAudioExport}
        segmentCount={dubSegments.length}
        timingStrategy={timingStrategy}
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
