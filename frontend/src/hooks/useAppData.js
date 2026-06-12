import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../store';
import { listProfiles } from '../api/profiles';
import { listHistory } from '../api/generate';
import { listProjects } from '../api/projects';
import { listDubHistory } from '../api/dub';
import { listExportHistory, exportAction, exportReveal, exportRecord } from '../api/exports';
import { modelStatus as apiModelStatus } from '../api/system';
import { useModelStatus } from '../api/hooks';
import useRealtimeEvents from './useRealtimeEvents';
import { isTauri, fileToMediaUrl } from '../utils/media';
import { toast } from 'react-hot-toast';

/**
 * Encapsulates all data-loading effects, localStorage persistence,
 * real-time WebSocket updates, and model-status pill management.
 */
export default function useAppData() {
  const mode = useAppStore(s => s.mode);
  const setMode = useAppStore(s => s.setMode);
  const defineMethod = useAppStore(s => s.defineMethod);
  const setDefineMethod = useAppStore(s => s.setDefineMethod);
  const uiScale = useAppStore(s => s.uiScale);
  const setUiScale = useAppStore(s => s.setUiScale);
  const setText = useAppStore(s => s.setText);
  const text = useAppStore(s => s.text);
  const setLanguage = useAppStore(s => s.setLanguage);
  const language = useAppStore(s => s.language);
  const setIsSidebarCollapsed = useAppStore(s => s.setIsSidebarCollapsed);
  const isSidebarCollapsed = useAppStore(s => s.isSidebarCollapsed);
  const setSidebarTab = useAppStore(s => s.setSidebarTab);
  const sidebarTab = useAppStore(s => s.sidebarTab);
  const setVdStates = useAppStore(s => s.setVdStates);
  const vdStates = useAppStore(s => s.vdStates);
  const speed = useAppStore(s => s.speed);
  const setSpeed = useAppStore(s => s.setSpeed);
  const steps = useAppStore(s => s.steps);
  const setSteps = useAppStore(s => s.setSteps);
  const cfg = useAppStore(s => s.cfg);
  const setCfg = useAppStore(s => s.setCfg);
  const denoise = useAppStore(s => s.denoise);
  const setDenoise = useAppStore(s => s.setDenoise);
  const dubJobId = useAppStore(s => s.dubJobId);
  const setDubJobId = useAppStore(s => s.setDubJobId);
  const dubFilename = useAppStore(s => s.dubFilename);
  const setDubFilename = useAppStore(s => s.setDubFilename);
  const dubDuration = useAppStore(s => s.dubDuration);
  const setDubDuration = useAppStore(s => s.setDubDuration);
  const dubSegments = useAppStore(s => s.dubSegments);
  const setDubSegments = useAppStore(s => s.setDubSegments);
  const dubLang = useAppStore(s => s.dubLang);
  const setDubLang = useAppStore(s => s.setDubLang);
  const dubLangCode = useAppStore(s => s.dubLangCode);
  const setDubLangCode = useAppStore(s => s.setDubLangCode);
  const dubTracks = useAppStore(s => s.dubTracks);
  const setDubTracks = useAppStore(s => s.setDubTracks);
  const dubStep = useAppStore(s => s.dubStep);
  const setDubStep = useAppStore(s => s.setDubStep);
  const dubTranscript = useAppStore(s => s.dubTranscript);
  const setDubTranscript = useAppStore(s => s.setDubTranscript);
  const exportTracks = useAppStore(s => s.exportTracks);
  const setExportTracks = useAppStore(s => s.setExportTracks);
  const preserveBg = useAppStore(s => s.preserveBg);
  const setPreserveBg = useAppStore(s => s.setPreserveBg);
  const defaultTrack = useAppStore(s => s.defaultTrack);
  const setDefaultTrack = useAppStore(s => s.setDefaultTrack);

  const [profiles, setProfiles] = useState([]);
  const [history, setHistory] = useState([]);
  const [dubHistory, setDubHistory] = useState([]);
  const [studioProjects, setStudioProjects] = useState([]);
  const [exportHistory, setExportHistory] = useState([]);
  const [showOverrides, setShowOverrides] = useState(false);

  // ── Model status (TanStack Query) ──
  // Sysinfo lives in Header (the only consumer) so its 5s poll doesn't
  // re-render the whole App tree.
  const msQuery = useModelStatus();
  const modelStatus = msQuery.data?.status ?? 'idle';
  const modelSubStage = msQuery.data?.sub_stage ?? null;
  const modelDetail = msQuery.data?.detail ?? '';
  const modelError = msQuery.data?.error ?? null;
  const modelProgress = msQuery.data?.progress ?? null;

  // ── Model loading pill ──
  const prevModelStatusRef = useRef(modelStatus);
  useEffect(() => {
    const prev = prevModelStatusRef.current;
    prevModelStatusRef.current = modelStatus;
    const pill = useAppStore.getState();
    if (modelStatus === 'loading') {
      const label = modelDetail || 'Loading model…';
      if (prev !== 'loading' && pill.stage === 'idle') pill.showPill('loading-model', label);
      else if (pill.stage === 'loading-model') pill.setPillLabel(label);
      // Forward real-time percentage from backend
      if (modelProgress !== null && pill.stage === 'loading-model') {
        pill.setPillProgress(modelProgress);
      }
    }
    if (modelStatus === 'ready' && prev === 'loading' && pill.stage === 'loading-model') pill.completePill('Model ready');
    if (modelSubStage === 'error' && modelError && pill.stage === 'loading-model') pill.errorPill(modelError);
  }, [modelStatus, modelSubStage, modelDetail, modelError, modelProgress]);

  // ── Data loading callbacks ──
  const loadProfiles = useCallback(async () => { try { setProfiles(await listProfiles()); } catch (e) {} }, []);
  const loadHistory = useCallback(async () => { try { setHistory(await listHistory()); } catch (e) {} }, []);
  const loadDubHistory = useCallback(async () => { try { setDubHistory(await listDubHistory()); } catch (e) {} }, []);
  const loadProjects = useCallback(async () => { try { setStudioProjects(await listProjects()); } catch (e) {} }, []);
  const loadExportHistory = useCallback(async () => { try { setExportHistory(await listExportHistory()); } catch (e) {} }, []);

  // ── WebSocket real-time updates ──
  useRealtimeEvents({
    projects: () => loadProjects(),
    profiles: () => loadProfiles(),
    dub_history: () => loadDubHistory(),
    export_history: () => loadExportHistory(),
    generation_history: () => loadHistory(),
  });

  // ── Initial data load with backend retry ──
  useEffect(() => {
    let cancelled = false;
    const loadAll = async () => {
      let delay = 1000;
      while (!cancelled) {
        try { await apiModelStatus(); break; } catch (e) {}
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 4000);
      }
      if (cancelled) return;
      loadProfiles(); loadHistory(); loadDubHistory(); loadProjects(); loadExportHistory();
    };
    loadAll();
    // Restore local UI state
    try {
      const saved = JSON.parse(localStorage.getItem('omni_ui') || '{}');
      if (saved.uiScale) setUiScale(saved.uiScale);
      if (saved.text) setText(saved.text);
      // Legacy shim (voice-studio-unification P4): the old 'clone'/'design'
      // navigation modes are now one 'studio' workspace; the split lives on
      // as the defineMethod ('audio'|'design').
      if (saved.mode === 'clone') { setMode('studio'); setDefineMethod('audio'); }
      else if (saved.mode === 'design') { setMode('studio'); setDefineMethod('design'); }
      else if (saved.mode) setMode(saved.mode);
      if (saved.defineMethod) setDefineMethod(saved.defineMethod);
      if (saved.vdStates) setVdStates(saved.vdStates);
      if (saved.language) setLanguage(saved.language);
      if (saved.isSidebarCollapsed !== undefined) setIsSidebarCollapsed(saved.isSidebarCollapsed);
      if (saved.sidebarTab) setSidebarTab(saved.sidebarTab);
      if (saved.dubJobId) setDubJobId(saved.dubJobId);
      if (saved.dubFilename) setDubFilename(saved.dubFilename);
      if (saved.dubDuration !== undefined) setDubDuration(saved.dubDuration);
      if (saved.dubSegments) setDubSegments(saved.dubSegments.map(s => ({ ...s, text_original: s.text_original || s.text || '' })));
      if (saved.dubLang) setDubLang(saved.dubLang);
      if (saved.dubLangCode) setDubLangCode(saved.dubLangCode);
      if (saved.dubTracks) setDubTracks(saved.dubTracks);
      if (saved.dubStep) setDubStep(saved.dubStep);
      if (saved.dubTranscript) setDubTranscript(saved.dubTranscript);
      if (saved.exportTracks) setExportTracks(saved.exportTracks);
      if (saved.preserveBg !== undefined) setPreserveBg(saved.preserveBg);
      if (saved.defaultTrack) setDefaultTrack(saved.defaultTrack);
      if (saved.exportHistory) setExportHistory(saved.exportHistory);
      if (saved.speed) setSpeed(saved.speed);
      if (saved.steps) setSteps(saved.steps);
      if (saved.cfg) setCfg(saved.cfg);
      if (saved.denoise !== undefined) setDenoise(saved.denoise);
      if (saved.showOverrides !== undefined) setShowOverrides(saved.showOverrides);
    } catch (e) {}
    return () => { cancelled = true; };
  }, []);

  // ── Persist to localStorage ──
  useEffect(() => {
    localStorage.setItem('omni_ui', JSON.stringify({
      uiScale, text, mode, defineMethod, vdStates, language,
      isSidebarCollapsed, sidebarTab,
      dubJobId, dubFilename, dubDuration, dubSegments,
      dubLang, dubLangCode, dubTracks, dubStep, dubTranscript,
      exportTracks, preserveBg, defaultTrack, exportHistory,
      speed, steps, cfg, denoise, showOverrides
    }));
  }, [uiScale, text, mode, defineMethod, vdStates, language, isSidebarCollapsed, sidebarTab,
    dubJobId, dubFilename, dubDuration, dubSegments, dubLang, dubLangCode,
    dubTracks, dubStep, dubTranscript, exportTracks, preserveBg, defaultTrack,
    exportHistory, speed, steps, cfg, denoise, showOverrides
  ]);

  return {
    profiles, history, dubHistory, studioProjects, exportHistory,
    showOverrides, setShowOverrides,
    modelStatus,
    loadProfiles, loadHistory, loadDubHistory, loadProjects, loadExportHistory,
  };
}
