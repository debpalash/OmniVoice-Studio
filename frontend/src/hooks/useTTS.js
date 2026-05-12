import { useState, useRef, useCallback } from 'react';
import { useAppStore } from '../store';
import { generateSpeech, audioUrlWithCacheBust } from '../api/generate';
import { playBlobAudio, playPing } from '../utils/media';
import { probeAudioDuration } from '../utils/format';
import { CLONE_MAX_SECONDS, PRESETS } from '../utils/constants';
import { toast } from 'react-hot-toast';

/**
 * Encapsulates TTS generation logic, streaming response handling,
 * audio ingestion (with trim gate), and preset/tag helpers.
 */
export default function useTTS({ selectedProfile, setSelectedProfile, loadHistory }) {
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
  const mode = useAppStore(s => s.mode);
  const setSidebarTab = useAppStore(s => s.setSidebarTab);

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
      toast(`Audio is ${dur.toFixed(1)}s — trim to ≤${CLONE_MAX_SECONDS}s for best cloning`);
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
    if (!text.trim()) return toast.error("Please enter text");
    if (mode === 'clone' && !refAudio && !selectedProfile) return toast.error("Upload an audio or select a voice profile");
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

      if (mode === 'clone') {
        if (selectedProfile) {
          formData.append("profile_id", selectedProfile);
        } else if (refAudio) {
          const arrBuf = await refAudio.arrayBuffer();
          const safeBlob = new Blob([arrBuf], { type: refAudio.type });
          formData.append("ref_audio", safeBlob, refAudio.name || "audio.wav");
          formData.append("ref_text", refText);
        }
        if (instruct) formData.append("instruct", instruct);
      } else {
        const designSeed = Math.floor(Math.random() * 2147483647);
        formData.append("seed", designSeed);
        const parts = Object.values(vdStates).filter(v => v !== 'Auto');
        if (instruct.trim()) parts.push(instruct.trim());
        const finalInstruct = parts.join(', ');
        if (finalInstruct) formData.append("instruct", finalInstruct);
        if (selectedProfile) {
          formData.append("profile_id", selectedProfile);
        }
      }

      const response = await generateSpeech(formData);
      const reader = response.body.getReader();
      const chunks = [];
      let receivedLength = 0;
      const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);

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
      toast.error("Error: " + err.message);
    } finally {
      clearInterval(timerRef.current);
      setIsGenerating(false);
    }
  }, [text, mode, selectedProfile, refAudio, refText, language, instruct, steps, cfg, speed, denoise, tShift, posTemp, classTemp, layerPenalty, postprocess, duration, vdStates, loadHistory, setSidebarTab]);

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
