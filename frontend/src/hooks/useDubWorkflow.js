import { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '../store';
import {
  dubUpload, dubIngestUrl, dubAbort as apiDubAbort, dubCleanupSegments,
  dubTranslate, dubGenerate, tasksStreamUrl, tasksCancel,
  transcribeStreamUrl, dubImportSrt,
} from '../api/dub';
import { PRESETS } from '../utils/constants';
import { apiPost } from '../api/client';
import { API } from '../api/client';
import { playPing, isTauri } from '../utils/media';
import { toast } from 'react-hot-toast';
import i18next from 'i18next';
const t = i18next.t.bind(i18next);

/**
 * Encapsulates the entire dub pipeline workflow:
 *   upload → prep → transcribe → translate → generate → export
 *
 * Extracts ~700 LOC of handler logic from App.jsx.
 */
export default function useDubWorkflow({ loadProjects, loadProfiles, loadDubHistory, setLastGenFingerprints }) {
  const dubJobId        = useAppStore(s => s.dubJobId);
  const setDubJobId     = useAppStore(s => s.setDubJobId);
  const dubStep         = useAppStore(s => s.dubStep);
  const setDubStep      = useAppStore(s => s.setDubStep);
  const dubSegments     = useAppStore(s => s.dubSegments);
  const setDubSegments  = useAppStore(s => s.setDubSegments);
  const dubLang         = useAppStore(s => s.dubLang);
  const dubLangCode     = useAppStore(s => s.dubLangCode);
  const dubInstruct     = useAppStore(s => s.dubInstruct);
  const setDubFilename  = useAppStore(s => s.setDubFilename);
  const setDubDuration  = useAppStore(s => s.setDubDuration);
  const setDubError     = useAppStore(s => s.setDubError);
  const setDubFailure   = useAppStore(s => s.setDubFailure);
  const setDubTracks    = useAppStore(s => s.setDubTracks);
  const setDubTranscript = useAppStore(s => s.setDubTranscript);
  const setDubProgress  = useAppStore(s => s.setDubProgress);
  const setIsTranslating = useAppStore(s => s.setIsTranslating);
  const dubTaskId       = useAppStore(s => s.dubTaskId);
  const setDubTaskId    = useAppStore(s => s.setDubTaskId);
  const setDubPrepStage = useAppStore(s => s.setDubPrepStage);
  const setDubPrepProgress = useAppStore(s => s.setDubPrepProgress);
  const setSpeakerClones = useAppStore(s => s.setSpeakerClones);
  const setPreviewSegIds = useAppStore(s => s.setPreviewSegIds);
  const steps           = useAppStore(s => s.steps);
  const cfg             = useAppStore(s => s.cfg);
  const speed           = useAppStore(s => s.speed);
  const translateQuality = useAppStore(s => s.translateQuality);
  const timingStrategy  = useAppStore(s => s.timingStrategy);
  const glossaryTerms   = useAppStore(s => s.glossaryTerms);

  const [translateProvider, setTranslateProvider] = useState('argos');
  const [showTranscript, setShowTranscript] = useState(false);
  const [previewAudios, setPreviewAudios] = useState({});
  const [transcribeStart, setTranscribeStart] = useState(null);
  const [transcribeElapsed, setTranscribeElapsed] = useState(0);

  const dubAbortCtrlRef = useRef(null);
  const dubClientJobIdRef = useRef(null);

  // Timer for transcribe elapsed
  useEffect(() => {
    if (!transcribeStart) { setTranscribeElapsed(0); return; }
    const iv = setInterval(() => setTranscribeElapsed(Math.floor((Date.now() - transcribeStart) / 1000)), 500);
    return () => clearInterval(iv);
  }, [transcribeStart]);

  // ── SSE: wait for transcription stream ──
  const _waitForTranscribe = useCallback((jobId, ctrl) => new Promise((resolve, reject) => {
    // Read the optional speaker-count hint at stream-open time (#274) so the
    // user's choice for this job is honoured without threading it through the
    // three call sites. null → pyannote auto-detect.
    const numSpeakers = useAppStore.getState().dubNumSpeakers;
    const evt = new EventSource(transcribeStreamUrl(jobId, numSpeakers));
    let gotFinal = false;
    const close = () => { try { evt.close(); } catch {} };
    const onAbortSignal = () => { close(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    ctrl.signal.addEventListener('abort', onAbortSignal, { once: true });

    evt.addEventListener('start', () => {});
    evt.addEventListener('segments', (e) => {
      try {
        const m = JSON.parse(e.data);
        const incoming = (m.segments || []).map((s, i) => ({
          ...s,
          id: s.id != null ? String(s.id) : `c${m.chunk}-${i}`,
          text_original: s.text_original || s.text || '',
        }));
        setDubSegments(prev => [...prev, ...incoming]);
      } catch (err) { /* ignore parse errors */ }
    });
    evt.addEventListener('final', (e) => {
      try {
        const m = JSON.parse(e.data);
        gotFinal = true;
        setDubSegments((m.segments || []).map((s, i) => ({
          ...s,
          id: s.id != null ? String(s.id) : String(i),
          text_original: s.text_original || s.text || '',
        })));
        setDubTranscript(m.full_transcript || '');
        if (m.speaker_clones && typeof m.speaker_clones === 'object') {
          setSpeakerClones(m.speaker_clones);
        }
      } catch (err) { console.warn('Transcribe SSE handler failed:', err); }
    });
    evt.addEventListener('warning', (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m && m.detail) {
          toast(m.detail, { icon: '⚠️', duration: 8000 });
        }
      } catch { /* malformed warning event */ }
    });
    evt.addEventListener('done', () => { close(); ctrl.signal.removeEventListener('abort', onAbortSignal); resolve(); });
    evt.addEventListener('aborted', () => { close(); ctrl.signal.removeEventListener('abort', onAbortSignal); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    evt.addEventListener('error', (e) => {
      try { const m = e.data ? JSON.parse(e.data) : null; if (m && m.detail) { close(); reject(new Error(m.detail)); return; } } catch {}
      if (gotFinal) { close(); resolve(); return; }
      close();
      reject(new Error('Transcribe stream dropped before emitting any segments. Likely ASR backend failed to load — check backend log + Settings → Models.'));
    });
  }), [setDubSegments, setDubTranscript, setSpeakerClones]);

  // ── SSE: wait for prep pipeline ──
  const _waitForPrep = useCallback((taskId, ctrl) => new Promise((resolve, reject) => {
    const evt = new EventSource(tasksStreamUrl(taskId));
    const close = () => { try { evt.close(); } catch {} };
    const onAbort = () => { close(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    ctrl.signal.addEventListener('abort', onAbort, { once: true });
    let lastData = null;
    evt.onmessage = (e) => {
      if (!e.data) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      lastData = m;
      switch (m.type) {
        case 'download_start':
          setDubPrepStage('download');
          setDubPrepProgress({ percent: null, speedBps: null, etaS: null, stageStartedAt: Date.now() });
          break;
        case 'download_progress':
          setDubPrepProgress(prev => ({
            ...prev,
            percent: typeof m.percent === 'number' ? m.percent : prev.percent,
            speedBps: typeof m.speed_bps === 'number' ? m.speed_bps : null,
            etaS: typeof m.eta_s === 'number' ? m.eta_s : null,
          }));
          break;
        case 'download_done': if (m.filename) setDubFilename(m.filename); break;
        case 'extract_start':
          setDubPrepStage('extract');
          setDubPrepProgress({ percent: null, speedBps: null, etaS: null, stageStartedAt: Date.now() });
          break;
        case 'extract_done':
          if (m.job_id) setDubJobId(m.job_id);
          if (typeof m.duration === 'number') setDubDuration(m.duration);
          if (m.filename) setDubFilename(m.filename);
          break;
        case 'demucs_start':
          setDubPrepStage('demucs');
          setDubPrepProgress({ percent: null, speedBps: null, etaS: null, stageStartedAt: Date.now() });
          break;
        case 'demucs_progress':
          setDubPrepProgress(prev => ({
            ...prev,
            percent: typeof m.percent === 'number' ? m.percent : prev.percent,
          }));
          break;
        case 'demucs_done': break;
        case 'scene_start':
          setDubPrepStage('scene');
          setDubPrepProgress({ percent: null, speedBps: null, etaS: null, stageStartedAt: Date.now() });
          break;
        case 'scene_done': break;
        case 'cached':
          setDubPrepStage('cached');
          setDubPrepProgress({ percent: 100, speedBps: null, etaS: null, stageStartedAt: Date.now() });
          break;
        case 'ready': close(); ctrl.signal.removeEventListener('abort', onAbort); resolve(m); return;
        case 'error': {
          close(); ctrl.signal.removeEventListener('abort', onAbort);
          // plan-04 (#131): the backend now always sends a non-empty reason;
          // capture the structured failure so the UI can show a hint + docs link
          // + copyable diagnostic instead of a bare "unknown error".
          const reason = m.reason || m.error || 'unknown error';
          setDubFailure({ reason, errorClass: m.error_class, stage: m.stage, hint: m.hint, docsTopic: m.docs_topic, diagnostic: m.diagnostic });
          reject(new Error(`${m.stage || 'prep'}: ${reason}`)); return;
        }
        case 'cancelled': close(); ctrl.signal.removeEventListener('abort', onAbort); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return;
        default: break;
      }
    };
    evt.onerror = () => {
      if (evt.readyState === EventSource.CLOSED) {
        close(); ctrl.signal.removeEventListener('abort', onAbort);
        if (lastData && lastData.type === 'ready') resolve(lastData);
        else reject(new Error('prep stream closed unexpectedly'));
      }
    };
  }), [setDubPrepStage, setDubPrepProgress, setDubJobId, setDubDuration, setDubFilename, setDubFailure]);

  // ── Handlers ──
  const handleDubUpload = useCallback(async (dubVideoFile) => {
    if (!dubVideoFile) return;
    setDubStep('uploading'); setDubError(''); setDubFailure(null); setDubTracks([]); setDubPrepStage('download');
    setDubPrepProgress({ percent: null, speedBps: null, etaS: null, stageStartedAt: Date.now() });
    const ctrl = new AbortController();
    dubAbortCtrlRef.current = ctrl;
    const clientJobId = Math.random().toString(36).slice(2, 10);
    dubClientJobIdRef.current = clientJobId;
    setDubJobId(clientJobId);
    const inputType = useAppStore.getState().dubInputType || 'video';  // #119
    useAppStore.getState().showPill('loading-model', inputType === 'audio' ? t('dub_workflow.preparing_audio') : t('dub_workflow.preparing_video'), { cancellable: true });
    try {
      const data = await dubUpload(dubVideoFile, clientJobId, { signal: ctrl.signal, inputType });
      setDubJobId(data.job_id); if (data.filename) setDubFilename(data.filename);
      setDubTaskId(data.task_id); setDubPrepStage('extract');
      useAppStore.getState().showPill('loading-model', t('dub_workflow.extracting_audio_scenes'), { cancellable: true });
      await _waitForPrep(data.task_id, ctrl);
      setDubStep('transcribing'); setDubPrepStage(null);
      setTranscribeStart(Date.now()); setDubSegments([]);
      useAppStore.getState().showPill('transcribing', t('dub_workflow.transcribing_audio'), { cancellable: true });
      await _waitForTranscribe(data.job_id, ctrl);
      setTranscribeStart(null); setDubStep('editing');
      useAppStore.getState().completePill(t('dub_workflow.transcription_complete'));
      loadProjects(); loadProfiles();
    } catch (err) {
      setDubPrepStage(null);
      if (err.name === 'AbortError') { toast(t('dub_workflow.upload_cancelled')); setDubStep('idle'); useAppStore.getState().dismissPill(); }
      else { setDubError(err.message); setDubStep('idle'); toast.error(t('dub_workflow.upload_failed', { message: err.message })); useAppStore.getState().errorPill(err.message); }
      setTranscribeStart(null);
    } finally { dubAbortCtrlRef.current = null; }
  }, [setDubStep, setDubError, setDubFailure, setDubTracks, setDubPrepStage, setDubJobId, setDubFilename, setDubTaskId, setDubSegments, _waitForPrep, _waitForTranscribe, loadProjects, loadProfiles]);

  const handleDubIngestUrl = useCallback(async (url, opts = {}) => {
    const clean = (url || '').trim();
    if (!clean) return;
    setDubStep('uploading'); setDubError(''); setDubFailure(null); setDubTracks([]); setDubPrepStage('download');
    setDubPrepProgress({ percent: null, speedBps: null, etaS: null, stageStartedAt: Date.now() });
    const ctrl = new AbortController();
    dubAbortCtrlRef.current = ctrl;
    const clientJobId = Math.random().toString(36).slice(2, 10);
    dubClientJobIdRef.current = clientJobId;
    setDubJobId(clientJobId);
    useAppStore.getState().showPill('loading-model', t('dub_workflow.downloading_video'), { cancellable: true });
    try {
      const data = await dubIngestUrl(clean, clientJobId, { signal: ctrl.signal, fetchSubs: !!opts.fetchSubs, subLangs: opts.subLangs });
      setDubJobId(data.job_id); setDubTaskId(data.task_id);
      useAppStore.getState().showPill('loading-model', t('dub_workflow.extracting_audio_scenes'), { cancellable: true });
      await _waitForPrep(data.task_id, ctrl);
      setDubStep('transcribing'); setDubPrepStage(null);
      setTranscribeStart(Date.now()); setDubSegments([]);
      useAppStore.getState().showPill('transcribing', t('dub_workflow.transcribing_audio'), { cancellable: true });
      await _waitForTranscribe(data.job_id, ctrl);
      setTranscribeStart(null); setDubStep('editing');
      useAppStore.getState().completePill(t('dub_workflow.transcription_complete'));
      loadProjects(); loadProfiles();
      toast.success(t('dub_workflow.ingested', { url: clean.slice(0, 60) }));
    } catch (err) {
      setDubPrepStage(null);
      if (err.name === 'AbortError') { toast(t('dub_workflow.ingest_cancelled')); setDubStep('idle'); useAppStore.getState().dismissPill(); }
      else { setDubError(err.message); setDubStep('idle'); toast.error(t('dub_workflow.ingest_failed', { message: err.message })); useAppStore.getState().errorPill(err.message); }
      setTranscribeStart(null);
    } finally { dubAbortCtrlRef.current = null; }
  }, [setDubStep, setDubError, setDubFailure, setDubTracks, setDubPrepStage, setDubJobId, setDubTaskId, setDubSegments, _waitForPrep, _waitForTranscribe, loadProjects, loadProfiles]);

  const handleDubAbort = useCallback(async () => {
    const jobId = dubClientJobIdRef.current || dubJobId;
    if (dubAbortCtrlRef.current) dubAbortCtrlRef.current.abort();
    if (jobId) await apiDubAbort(jobId);
  }, [dubJobId]);

  const handleDubRetryTranscribe = useCallback(async () => {
    if (!dubJobId) return;
    const ctrl = new AbortController();
    dubAbortCtrlRef.current = ctrl;
    setDubError(''); setDubSegments([]); setDubStep('transcribing');
    setTranscribeStart(Date.now());
    try {
      await _waitForTranscribe(dubJobId, ctrl);
      setTranscribeStart(null); setDubStep('editing'); loadProjects();
    } catch (err) {
      setTranscribeStart(null);
      if (err.name === 'AbortError') { toast(t('dub_workflow.retry_cancelled')); setDubStep('idle'); }
      else { setDubError(err.message); setDubStep('idle'); toast.error(t('dub_workflow.transcription_failed', { message: err.message })); }
    } finally { dubAbortCtrlRef.current = null; }
  }, [dubJobId, setDubError, setDubSegments, setDubStep, _waitForTranscribe, loadProjects]);

  const handleDubImportSrt = useCallback(async (file) => {
    if (!dubJobId) {
      toast.error(t('dub_workflow.import_srt_no_job'));
      return;
    }
    if (!file) return;
    try {
      setDubError('');
      const res = await dubImportSrt(dubJobId, file);
      const segs = (res && res.segments) || [];
      setDubSegments(segs.map(s => ({
        ...s,
        id: s.id != null ? String(s.id) : String(Math.random()),
      })));
      setDubStep('editing');
      const stats = res?.stats || {};
      const noteParts = [t('dub_workflow.imported_cues', { count: stats.imported ?? segs.length, file: file.name || '.srt' })];
      if (stats.skipped_malformed) noteParts.push(t('dub_workflow.skipped_malformed', { count: stats.skipped_malformed }));
      if (stats.dropped_overlap) noteParts.push(t('dub_workflow.dropped_overlap', { count: stats.dropped_overlap }));
      if (stats.clamped_to_duration) noteParts.push(t('dub_workflow.clamped_to_duration', { count: stats.clamped_to_duration }));
      toast.success(noteParts.join(' · '), { duration: 6000 });
      loadProjects();
    } catch (err) {
      const msg = err?.message || t('dub_workflow.srt_import_failed');
      setDubError(msg);
      toast.error(msg);
    }
  }, [dubJobId, setDubError, setDubSegments, setDubStep, loadProjects]);

  const handleCleanupSegments = useCallback(async () => {
    if (!dubJobId || !dubSegments.length) return;
    const before = dubSegments.length;
    try {
      const data = await dubCleanupSegments(dubJobId);
      setDubSegments(data.segments || []);
      const delta = before - (data.after ?? data.segments.length);
      toast.success(delta > 0 ? t('dub_workflow.cleaned', { count: delta }) : t('dub_workflow.segments_clean'));
    } catch (err) { toast.error(t('dub_workflow.cleanup_failed', { message: err.message })); }
  }, [dubJobId, dubSegments, setDubSegments]);

  const handleTranslateAll = useCallback(async () => {
    if (!dubSegments.length || !dubLangCode) return;
    setIsTranslating(true);
    try {
      const data = await dubTranslate({
        segments: dubSegments.map(s => ({
          id: String(s.id),
          text: (s.text_original && s.text_original.trim()) ? s.text_original : s.text,
          target_lang: s.target_lang,
          direction: s.direction || undefined,
          slot_seconds: (s.end != null && s.start != null) ? (s.end - s.start) : undefined,
        })),
        target_lang: dubLangCode,
        provider: translateProvider,
        quality: translateQuality,
        glossary: glossaryTerms.length
          ? glossaryTerms.map(t => ({ source: t.source, target: t.target, note: t.note || '' }))
          : undefined,
      });
      const translatedMap = {};
      const errors = [];
      (data.translated || []).forEach(t => { translatedMap[t.id] = t; if (t.error) errors.push({ id: t.id, error: t.error }); });
      setDubSegments(dubSegments.map(s => {
        const hit = translatedMap[s.id];
        if (!hit) return s;
        return {
          ...s,
          text: (hit.text && hit.text.trim()) ? hit.text : s.text,
          translate_error: hit.error || undefined,
          translate_literal: hit.literal || undefined,
          translate_critique: hit.critique || undefined,
          // Carry over the predicted compression ratio so the per-row
          // badge + job-level compression warning can light up before
          // the user clicks Generate Dub.
          rate_ratio: hit.rate_ratio != null ? hit.rate_ratio : s.rate_ratio,
          rate_error: hit.rate_error || s.rate_error,
        };
      }));
      if (data.cinematic_skipped === 'no-llm-configured') {
        toast(t('dub_workflow.cinematic_no_llm'), { icon: 'ℹ️', duration: 7000 });
      }
      if (errors.length) {
        const unique = [...new Set(errors.map(e => e.error))];
        toast.error(t('dub_workflow.translate_errors', { errorCount: errors.length, totalCount: data.translated.length, firstError: unique[0].slice(0, 120) }), { duration: 6000 });
      } else {
        const qLabel = data.quality_used === 'cinematic' ? t('dub_workflow.translated_cinematic_suffix') : '';
        toast.success(t('dub_workflow.translated_segments', { count: data.translated.length, lang: data.target_lang }) + qLabel);
      }
    } catch (err) { setDubError(t('dub_workflow.translation_failed', { message: err.message })); }
    setIsTranslating(false);
  }, [dubSegments, dubLangCode, translateProvider, translateQuality, glossaryTerms, setIsTranslating, setDubSegments, setDubError]);

  const handleDubGenerate = useCallback(async (opts = {}) => {
    const regenOnly = Array.isArray(opts.regenOnly) && opts.regenOnly.length ? opts.regenOnly : null;
    const preview = !!opts.preview;
    setDubStep('generating');
    setDubProgress({ current: 0, total: dubSegments.length, text: '' });
    setDubError('');
    const genLabel = regenOnly ? t('dub_workflow.regenerating', { count: regenOnly.length }) : t('dub_workflow.generating_dub');
    useAppStore.getState().showPill('generating', genLabel, { cancellable: true });
    try {
      const body = {
        segment_ids: dubSegments.map(s => String(s.id)),
        regen_only: regenOnly,
        segments: dubSegments.map(s => {
          let fin_prof = s.profile_id || '';
          let fin_inst = s.instruct || '';
          if (fin_prof.startsWith('preset:')) {
            const pr = PRESETS.find(p => p.id === fin_prof.replace('preset:', ''));
            if (pr) { const parts = Object.values(pr.attrs).filter(v => v !== 'Auto'); if (fin_inst.trim()) parts.push(fin_inst.trim()); fin_inst = parts.join(', '); }
            fin_prof = '';
          }
          return { start: s.start, end: s.end, text: s.text, instruct: fin_inst, profile_id: fin_prof, speed: s.speed || undefined, gain: s.gain !== undefined && s.gain !== 1.0 ? s.gain : undefined, target_lang: s.target_lang || undefined, direction: s.direction || undefined };
        }),
        language: dubLang === 'Auto' ? 'Auto' : dubLang,
        language_code: dubLangCode,
        instruct: dubInstruct,
        num_step: steps, guidance_scale: cfg, speed,
        preview,
        timing_strategy: timingStrategy || 'concise',
      };
      const data = await dubGenerate(dubJobId, body);
      setDubTaskId(data.task_id);
      const streamRes = await fetch(tasksStreamUrl(data.task_id));
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let wasCancelled = false;
      let sawDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'progress') {
                setDubProgress({ current: evt.current + 1, total: evt.total, text: evt.text });
                useAppStore.getState().setPillProgress(Math.round(((evt.current + 1) / evt.total) * 100));
                useAppStore.getState().setPillLabel(t('dub_workflow.generating_progress', { current: evt.current + 1, total: evt.total }));
              } else if (evt.type === 'done') {
                sawDone = true;
                setDubStep('done');
                setDubTracks(evt.tracks || []);
                // Merge sync_scores (back-compat) and the new richer
                // fit_status array onto each segment so the row badge can
                // show truthful "Fits / Overflows +0.4s / Video stretched
                // 1.18×" labels.
                if (evt.sync_scores || evt.fit_status) {
                  setDubSegments(prev => prev.map((s, idx) => ({
                    ...s,
                    sync_ratio: evt.sync_scores ? evt.sync_scores[idx] : s.sync_ratio,
                    fit_status: evt.fit_status ? evt.fit_status[idx] : s.fit_status,
                  })));
                }
                if (evt.seg_num_step && typeof evt.seg_num_step === 'object') {
                  const previewIds = Object.entries(evt.seg_num_step).filter(([, n]) => typeof n === 'number' && n < steps).map(([id]) => id);
                  setPreviewSegIds(previewIds);
                }
                if (evt.seg_hashes && Object.keys(evt.seg_hashes).length > 0) {
                  setLastGenFingerprints(evt.seg_hashes);
                } else {
                  try { const plan = await apiPost('/tools/incremental', { segments: dubSegments.map(s => ({ id: String(s.id), text: s.text, target_lang: s.target_lang, profile_id: s.profile_id, instruct: s.instruct, speed: s.speed, direction: s.direction })) }); setLastGenFingerprints(plan.fingerprints || {}); } catch (err) { console.warn('Incremental plan fallback failed:', err); }
                }
              } else if (evt.type === 'cancelled') {
                wasCancelled = true; setDubStep('editing'); setDubError(t('dub_workflow.generation_aborted')); toast(t('dub_workflow.dubbing_aborted'), { icon: '⏹' });
              } else if (evt.type === 'error') setDubError(p => p + `\nSeg ${evt.segment}: ${evt.error}`);
            } catch (err) { console.warn('Dub generate SSE handler failed:', err); }
          }
        }
      }
      setDubTaskId(null);
      if (!wasCancelled) {
        if (!sawDone) throw new Error(t('dub_workflow.generation_stream_ended'));
        if (dubStep !== 'done') setDubStep('done');
        loadDubHistory(); loadProjects(); playPing();
        useAppStore.getState().completePill(t('dub_workflow.dub_complete'));
      } else { useAppStore.getState().dismissPill(); }
    } catch (err) {
      setDubError(err.message); setDubStep('editing'); setDubTaskId(null);
      useAppStore.getState().errorPill(err.message);
    }
  }, [dubJobId, dubSegments, dubLang, dubLangCode, dubInstruct, steps, cfg, speed, dubStep, timingStrategy, setDubStep, setDubProgress, setDubError, setDubTracks, setDubSegments, setDubTaskId, setPreviewSegIds, setLastGenFingerprints, loadDubHistory, loadProjects]);

  const handleDubStop = useCallback(async () => {
    if (!dubTaskId) return;
    const prevStep = dubStep;
    setDubStep('stopping');
    try {
      await tasksCancel(dubTaskId);
    } catch (e) {
      setDubStep(prevStep);
      toast.error(t('dub_workflow.stop_failed'));
    }
  }, [dubTaskId, dubStep, setDubStep]);

  return {
    translateProvider, setTranslateProvider,
    showTranscript, setShowTranscript,
    previewAudios, setPreviewAudios,
    transcribeElapsed,
    handleDubUpload, handleDubIngestUrl,
    handleDubAbort, handleDubRetryTranscribe,
    handleDubStop, handleDubGenerate,
    handleCleanupSegments, handleTranslateAll,
    handleDubImportSrt,
  };
}
