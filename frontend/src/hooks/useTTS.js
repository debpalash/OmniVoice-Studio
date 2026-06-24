import { useState, useRef, useCallback } from 'react';
import { useAppStore } from '../store';
import { generateSpeech, audioUrlWithCacheBust } from '../api/generate';
import { pickDesignSeed } from '../utils/seed';
import { playBlobAudio, playPing } from '../utils/media';
import { probeAudioDuration } from '../utils/format';
import { CLONE_MAX_SECONDS, PRESETS } from '../utils/constants';
import { buildDesignInstruct, designModeProfileId } from '../utils/voiceInstruct';
import { toast } from 'react-hot-toast';
import { toastErrorWithReport } from '../utils/errorToast';
import { addBreadcrumb } from '../utils/breadcrumbs';
import i18next from 'i18next';
const t = i18next.t.bind(i18next);

// #21: in-memory de-dup for the synth-time routing toast — a 50-clip batch
// shouldn't fire one toast per request. Tracks the last status surfaced this
// session (module scope, no localStorage); resets on full reload.
let _lastRoutingStatus = null;

/**
 * Encapsulates TTS generation logic, streaming response handling,
 * audio ingestion (with trim gate), and preset/tag helpers.
 */
export default function useTTS({ selectedProfile, setSelectedProfile, loadHistory, profiles }) {
  const text = useAppStore(s => s.text);
  const setText = useAppStore(s => s.setText);
  const language = useAppStore(s => s.language);
  const instruct = useAppStore(s => s.instruct);
  const refText = useAppStore(s => s.refText);
  const speed = useAppStore(s => s.speed);
  const steps = useAppStore(s => s.steps);
  const cfg = useAppStore(s => s.cfg);
  const denoise = useAppStore(s => s.denoise);
  const tShift = useAppStore(s => s.tShift);
  const posTemp = useAppStore(s => s.posTemp);
  const classTemp = useAppStore(s => s.classTemp);
  const layerPenalty = useAppStore(s => s.layerPenalty);
  const postprocess = useAppStore(s => s.postprocess);
  const duration = useAppStore(s => s.duration);
  const vdStates = useAppStore(s => s.vdStates);
  // Which "Define voice" method is active in the Voice (studio) workspace —
  // 'audio' (reference clip) vs 'design' (described attributes). Replaces the
  // old clone/design navigation-mode checks (voice-studio-unification P4).
  const defineMethod = useAppStore(s => s.defineMethod);
  const setSidebarTab = useAppStore(s => s.setSidebarTab);
  // Voice-design seed (#526): reuse the pinned seed when "keep this seed" is on
  // so tweaks stay on the same base timbre; otherwise roll a fresh one.
  const keepSeed = useAppStore(s => s.keepSeed);
  const designSeed = useAppStore(s => s.designSeed);
  const setDesignSeed = useAppStore(s => s.setDesignSeed);

  const [refAudio, setRefAudio] = useState(null);
  const [pendingTrimFile, setPendingTrimFile] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationTime, setGenerationTime] = useState(0);
  const timerRef = useRef(null);
  const textAreaRef = useRef(null);

  const ingestRefAudio = useCallback(async (file) => {
    if (!file) { setRefAudio(null); return; }
    const dur = await probeAudioDuration(file);
    if (dur && dur > CLONE_MAX_SECONDS) {
      setPendingTrimFile(file);
      setSelectedProfile(null);
      toast(t('tts_errors.trim_hint', { duration: dur.toFixed(1), max: CLONE_MAX_SECONDS }));
      return;
    }
    setRefAudio(file);
    setSelectedProfile(null);
  }, [setSelectedProfile]);

  const insertTag = useCallback((tag) => {
    if (!textAreaRef.current) return;
    const start = textAreaRef.current.selectionStart;
    const end = textAreaRef.current.selectionEnd;
    setText(text.substring(0, start) + tag + text.substring(end));
    setTimeout(() => { textAreaRef.current.focus(); textAreaRef.current.setSelectionRange(start + tag.length, start + tag.length); }, 0);
  }, [text, setText]);

  const applyPreset = useCallback((preset) => {
    useAppStore.getState().setVdStates(preset.attrs);
    if (preset.tags && !text.includes(preset.tags.trim())) insertTag(preset.tags);
  }, [text, insertTag]);

  const handleGenerate = useCallback(async () => {
    if (!text.trim()) return toast.error(t('tts_errors.enter_text'));
    if (defineMethod === 'audio' && !refAudio && !selectedProfile) return toast.error(t('tts_errors.upload_or_select'));
    addBreadcrumb(`generate:start (${defineMethod})`);
    setIsGenerating(true);
    setGenerationTime(0);
    const st = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = ((Date.now() - st) / 1000).toFixed(1);
      setGenerationTime(prev => {
        const suffix = /\(\d+%\)$/.exec(String(prev))?.[0];
        return suffix ? `${elapsed} ${suffix}` : elapsed;
      });
    }, 100);
    let abortTimer = null;
    try {
      const formData = new FormData();
      formData.append("text", text);
      if (language !== 'Auto') formData.append("language", language);
      formData.append("num_step", steps);
      formData.append("guidance_scale", cfg);
      formData.append("speed", speed);
      formData.append("denoise", denoise);
      formData.append("t_shift", tShift);
      formData.append("position_temperature", posTemp);
      formData.append("class_temperature", classTemp);
      formData.append("layer_penalty_factor", layerPenalty);
      formData.append("postprocess_output", postprocess);
      if (duration) formData.append("duration", parseFloat(duration));

      if (defineMethod === 'audio') {
        if (selectedProfile) {
          formData.append("profile_id", selectedProfile);
        } else if (refAudio) {
          const arrBuf = await refAudio.arrayBuffer();
          const safeBlob = new Blob([arrBuf], { type: refAudio.type });
          formData.append("ref_audio", safeBlob, refAudio.name || "audio.wav");
          formData.append("ref_text", refText);
        }
        // #612: a clone's free-text style field also passes through the backend
        // instruct whitelist, so raw prose (e.g. a non-EN/ZH description like the
        // Vietnamese report) 400s with "Unsupported instruct items". Apply the
        // SAME validator-safe guard the design path uses: keep valid style tags,
        // drop the rest, and surface a localized warning toast — never round-trip
        // a 400. vdStates is empty here (clone has no design sliders).
        if (instruct) {
          const { instruct: safeInstruct, unsupported, duplicates } = buildDesignInstruct({}, instruct);
          if (unsupported.length) {
            toast(t('tts_errors.ignored_unsupported', { items: unsupported.join(', ') }), { icon: '⚠️' });
          }
          if (duplicates.length) {
            toast(t('tts_errors.ignored_duplicate', { items: duplicates.join(', ') }), { icon: '⚠️' });
          }
          if (safeInstruct) formData.append("instruct", safeInstruct);
        }
      } else {
        // #526: reuse the pinned seed when "keep this seed" is on (stable
        // tweaks), else roll a fresh one. The backend echoes the seed it used
        // back via X-Seed so the UI can show + pin it.
        formData.append("seed", pickDesignSeed(keepSeed, designSeed));
        // plan-05 (#132): build a validator-safe instruct (one valid tag per
        // category; drop unsupported free-text) so Synthesize stops failing
        // with "Unsupported instruct items" (#115) / "conflicting items within
        // the same category" (#114).
        const { instruct: finalInstruct, unsupported, duplicates } = buildDesignInstruct(vdStates, instruct);
        if (unsupported.length) {
          toast(t('tts_errors.ignored_unsupported', { items: unsupported.join(', ') }), { icon: '⚠️' });
        }
        if (duplicates.length) {
          toast(t('tts_errors.ignored_duplicate', { items: duplicates.join(', ') }), { icon: '⚠️' });
        }
        if (finalInstruct) formData.append("instruct", finalInstruct);
        // #674: in design mode, never forward a CLONE profile_id — its reference
        // voice would override the design attributes (e.g. "Male" has no effect).
        // Design profiles still pass through (re-render a designed voice).
        const designProfileId = designModeProfileId(selectedProfile, profiles);
        if (designProfileId) {
          formData.append("profile_id", designProfileId);
        }
      }

      // The first /generate may cold-load/download the model. The backend now
      // bounds that and returns an error rather than hanging; this client-side
      // abort is a backstop so the UI never spins forever even if the backend
      // is unreachable. The ceiling sits just above the backend's load timeout
      // so the backend's descriptive error wins in the normal case.
      const ac = new AbortController();
      abortTimer = setTimeout(() => ac.abort(), 21 * 60 * 1000);
      const response = await generateSpeech(formData, { signal: ac.signal });
      const reader = response.body.getReader();
      const chunks = [];
      let receivedLength = 0;
      const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);

      // #526: surface the seed the backend actually used so the Design tab can
      // display it and offer "keep this seed". Authoritative over the client
      // guess (covers the profile-seed / materialized-seed paths too).
      const xSeed = parseInt(response.headers.get('X-Seed') || '', 10);
      if (Number.isInteger(xSeed)) setDesignSeed(xSeed);

      // #21: one-time, non-blocking routing notice. The backend sets these
      // headers only on cpu_fallback / accelerated-with-caveat (never on the
      // benign cpu_only / clean-accelerated paths), so their mere presence is
      // the signal. De-duped by status so a batch doesn't spam.
      const routingStatus = response.headers.get('X-OmniVoice-Routing');
      if (routingStatus && routingStatus !== _lastRoutingStatus) {
        _lastRoutingStatus = routingStatus;
        const reason = response.headers.get('X-OmniVoice-Routing-Reason') || '';
        if (routingStatus === 'cpu_fallback') {
          toast(t('tts.routingFallback', { reason }), { icon: '🐢' });
        } else if (routingStatus === 'accelerated' && reason) {
          // accelerated is only surfaced WITH a driver/arch caveat reason.
          toast(t('tts.routingCaveat', { reason }), { icon: '⚠️' });
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        if (contentLength > 0) {
          const pct = Math.round((receivedLength / contentLength) * 100);
          setGenerationTime(prev => `${prev.toString().split(' ')[0]} (${pct}%)`);
        }
      }

      const blob = new Blob(chunks, { type: 'audio/wav' });
      try { await playBlobAudio(blob); } catch (e) {}

      await loadHistory();
      setSidebarTab('history');
      playPing();
    } catch (err) {
      // Timeouts are user-recoverable (retry / shorter input) — plain toast.
      // Real generation failures get the "Report this bug" action.
      if (err?.name === 'AbortError') {
        toast.error(t('tts_errors.timeout'));
      } else {
        toastErrorWithReport(t('tts_errors.error_prefix', { message: err.message }), err);
      }
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      clearInterval(timerRef.current);
      setIsGenerating(false);
    }
  }, [text, defineMethod, selectedProfile, refAudio, refText, language, instruct, steps, cfg, speed, denoise, tShift, posTemp, classTemp, layerPenalty, postprocess, duration, vdStates, keepSeed, designSeed, setDesignSeed, loadHistory, setSidebarTab]);

  return {
    refAudio, setRefAudio,
    pendingTrimFile, setPendingTrimFile,
    isGenerating, generationTime,
    textAreaRef,
    ingestRefAudio,
    insertTag, applyPreset,
    handleGenerate,
  };
}
