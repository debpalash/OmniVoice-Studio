import { useState, useEffect, useRef } from 'react';
import { Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CATEGORIES } from '../utils/constants';
import { Segmented } from '../ui';
import { useAppStore } from '../store';
import { API, apiPost, apiFetch } from '../api/client';
import { mergeDescribedAttrs } from '../utils/voiceInstruct';
import { listEngines } from '../api/engines';
import { claimPlayback, stopActivePlayback, usePlaybackSource } from '../utils/playback';
import ScriptPanel from '../components/clone/ScriptPanel';
import AudioMethodPanel from '../components/clone/AudioMethodPanel';
import DesignMethodPanel from '../components/clone/DesignMethodPanel';
import ActionBar from '../components/clone/ActionBar';
import './CloneDesignTab.css';

export default function CloneDesignTab(props) {
  const {
    textAreaRef,
    text, setText,
    language, setLanguage,
    steps, setSteps,
    cfg, setCfg,
    speed, setSpeed,
    tShift, setTShift,
    posTemp, setPosTemp,
    classTemp, setClassTemp,
    layerPenalty, setLayerPenalty,
    duration, setDuration,
    denoise, setDenoise,
    postprocess, setPostprocess,
    showOverrides, setShowOverrides,
    profiles,
    selectedProfile, setSelectedProfile,
    refAudio,
    refText, setRefText,
    instruct, setInstruct,
    profileName, setProfileName,
    showSaveProfile, setShowSaveProfile,
    isRecording, isCleaning, recordingTime,
    vdStates, setVdStates,
    isGenerating, generationTime,
    applyPreset, insertTag,
    handleSaveProfile, handleSaveDesignProfile, handleGenerate,
    startRecording, stopRecording,
    ingestRefAudio,
  } = props;

  const { t } = useTranslation();
  // "Define voice" method — 'audio' (was the Clone tab) | 'design' (was the
  // Design tab). Lives in the store so navigation shims / profile selection
  // can preset it (voice-studio-unification P4).
  const defineMethod = useAppStore(s => s.defineMethod);
  const setDefineMethod = useAppStore(s => s.setDefineMethod);
  // Voice-design seed (#526): show the seed the last synth used, let the user
  // pin it ("keep this seed") so tweaks stay on the same base timbre, or roll
  // a new one.
  const designSeed = useAppStore(s => s.designSeed);
  const keepSeed = useAppStore(s => s.keepSeed);
  const setDesignSeed = useAppStore(s => s.setDesignSeed);
  const setKeepSeed = useAppStore(s => s.setKeepSeed);
  const [activePersonality, setActivePersonality] = useState('');
  const [insertOpen, setInsertOpen] = useState(false);

  // Identity recipe line (10x §1.5): the non-Auto category picks as one
  // readable string. All-Auto (nothing chosen yet) starts the chips expanded.
  const identityPicks = Object.values(vdStates || {}).filter(v => v && v !== 'Auto');
  const identityRecipe = identityPicks.length
    ? identityPicks.join(' · ')
    : t('clone.identity_auto', { defaultValue: 'Auto — the model decides' });
  const [identityOpen, setIdentityOpen] = useState(() =>
    !Object.values(vdStates || {}).some(v => v && v !== 'Auto'));

  // ── "Describe your voice" (#317): free-text → design parameters ──────────
  // Debounced call to the local deterministic mapper (POST /design/describe);
  // the result overwrites the category controls live, and the user can still
  // hand-tune any of them afterwards. Unmappable fragments are surfaced
  // instead of silently dropped (the #115/#114 validator-feedback lesson).
  const [describeText, setDescribeText] = useState('');
  const [describeUnmatched, setDescribeUnmatched] = useState([]);
  const [describeMatchedAny, setDescribeMatchedAny] = useState(true);

  const onDescribeChange = (e) => {
    const value = e.target.value;
    setDescribeText(value);
    if (!value.trim()) {
      // Cleared: drop stale feedback immediately (controls stay as they are).
      setDescribeUnmatched([]);
      setDescribeMatchedAny(true);
    }
  };

  useEffect(() => {
    const q = describeText.trim();
    if (!q) return undefined;
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const res = await apiPost('/design/describe', { description: q });
        if (cancelled) return;
        setVdStates(mergeDescribedAttrs(res.attrs));
        setDescribeUnmatched(res.unmatched || []);
        setDescribeMatchedAny((res.matched || []).length > 0);
        // The description now owns the design parameters — clear any stale
        // personality instruct so the synthesize path can't merge conflicting
        // tokens from two sources (the issue-#114 failure mode).
        setActivePersonality('');
        setInstruct('');
      } catch {
        // Backend unreachable mid-typing — leave the controls untouched;
        // the next keystroke retries.
      }
    }, 450);
    return () => { cancelled = true; clearTimeout(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [describeText]);

  // Fetch personality presets from backend
  const { data: personalities = [] } = useQuery({
    queryKey: ['personalities'],
    queryFn: () => apiFetch(`${API}/personalities`).then(r => r.json()),
    staleTime: Infinity,
  });

  const applyPersonality = (p) => {
    if (activePersonality === p.id) {
      setActivePersonality('');
      return;
    }
    setActivePersonality(p.id);
    setInstruct(p.instruct);
    // Reset category sliders to Auto so the synthesize path doesn't
    // merge stale slider tokens with the personality's instruct string —
    // that combination caused issue #114 (conflicting items in the same
    // category, e.g. "low pitch" from a prior preset + "moderate pitch"
    // from the personality).
    const resetVd = Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, 'Auto']));
    setVdStates(resetVd);
  };

  // Engine readiness — used by the demo "Hear demo" fallback. Polls every
  // 15s so a freshly-finished model download flips the button back to live
  // synthesis without a manual refresh.
  const { data: enginesData } = useQuery({
    queryKey: ['engines-readiness'],
    queryFn: listEngines,
    refetchInterval: 15000,
    staleTime: 5000,
  });
  const anyTtsReady = !!(enginesData?.tts?.backends || []).some(b => b.available);

  // Demo coach-mark: when the user is on the "From audio" method with the
  // bundled demo profile (demo0001) freshly selected and the textarea is empty,
  // prefill a punchy starter prompt and show a one-line coach-mark above
  // the textarea. Both auto-dismiss as soon as the user types anything.
  // Tracked via localStorage so we don't re-prefill on every visit.
  const DEMO_PROFILE_ID = 'demo0001';
  const DEMO_PROMPT = "Welcome aboard. I was just a three-second clip a moment ago — now I can say anything you'd like, in your voice or mine.";
  const [showDemoCoachmark, setShowDemoCoachmark] = useState(false);

  useEffect(() => {
    if (defineMethod !== 'audio') return;
    if (selectedProfile !== DEMO_PROFILE_ID) return;
    if (typeof window === 'undefined') return;
    if (localStorage.getItem('omnivoice.demoClonePrompted') === '1') return;
    if (text) return; // user already typed something
    setText(DEMO_PROMPT);
    setShowDemoCoachmark(true);
    localStorage.setItem('omnivoice.demoClonePrompted', '1');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defineMethod, selectedProfile]);

  // "Hear demo" fallback: when no TTS engine is ready and the user is on
  // the demo profile, the Synthesize button is swapped for one that plays
  // the pre-rendered demo_clone_output.wav. This guarantees a working
  // "wow moment" on first launch before any model downloads finish.
  const showHearDemo =
    defineMethod === 'audio' && selectedProfile === DEMO_PROFILE_ID && !anyTtsReady;

  // Cmd/Ctrl+Enter synthesizes from anywhere in the workspace (10x spec 1.1).
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
      e.preventDefault();
      if (!isGenerating && !showHearDemo) handleGenerate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerating, showHearDemo, handleGenerate]);
  const demoAudioRef = useRef(null);
  const demoReleaseRef = useRef(null);
  const [demoAudioPlaying, setDemoAudioPlaying] = useState(false);

  // Global playback state (#316): while a synthesized output (or another
  // unmanaged blob playback) is audible, the footer CTA becomes a Stop
  // button so the user can halt it immediately.
  const playbackSource = usePlaybackSource();
  const outputPlaying = playbackSource === 'output';

  const playDemoOutput = () => {
    const audio = demoAudioRef.current;
    if (!audio) return;
    if (demoAudioPlaying) {
      stopActivePlayback();
      return;
    }
    // Claim the global playback slot so this demo stops any other preview
    // first — and can itself be stopped from anywhere (#316).
    demoReleaseRef.current = claimPlayback(() => {
      audio.pause();
      setDemoAudioPlaying(false);
    }, 'demo-output');
    audio.src = `${API}/demo_audio/demo_clone_output.wav`;
    audio.currentTime = 0;
    audio.play()
      .then(() => setDemoAudioPlaying(true))
      .catch(() => {
        demoReleaseRef.current?.();
        demoReleaseRef.current = null;
        setDemoAudioPlaying(false);
      });
  };

  // 10x P4 a11y (spec §3): category chip groups are radiogroups with a
  // roving tabindex — ArrowLeft/ArrowRight move focus AND selection within
  // the group, per the WAI-ARIA radio-group pattern.
  const onChipKeyDown = (e, key, options) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = Math.max(0, options.indexOf(vdStates[key]));
    const next = (cur + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
    setVdStates({ ...vdStates, [key]: options[next] });
    e.currentTarget.closest('.chip-group')?.querySelectorAll('[role="radio"]')[next]?.focus();
  };

  // 10x P4 a11y (spec §3): once a generation has run, the persistent status
  // region below announces its finish — not just its start.
  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (isGenerating) wasGeneratingRef.current = true;
  }, [isGenerating]);

  // Partition personalities into legacy chips vs. new demo cards.
  // `is_demo: true` entries get the rich card grid; the rest keep their
  // existing chip-strip rendering (backward-compatible with v0.2.x users
  // who learned the chips and shouldn't see them suddenly missing).
  const demoPresets = personalities.filter(p => p.is_demo);
  const chipPersonalities = personalities.filter(p => !p.is_demo);

  // Apply a full demo preset: pre-fill the textarea, set the category
  // sliders, clear any stale free-text instruct, switch language, and
  // highlight the chip equivalent. After this fires, the user can hit
  // Synthesize Audio immediately — no further input needed.
  const applyDemoPreset = (p) => {
    if (p.script) setText(p.script);
    if (p.attrs) setVdStates({ ...vdStates, ...p.attrs });
    setInstruct('');
    if (p.language) setLanguage(p.language);
    setActivePersonality(p.id);
  };


  return (
    <div className="studio-def-col">
    <div className="clone-split-grid">

      {/* ═══ SCRIPT — what should it say ═══ */}
      <ScriptPanel
        t={t}
        defineMethod={defineMethod}
        text={text}
        setText={setText}
        activePersonality={activePersonality}
        demoPresets={demoPresets}
        applyDemoPreset={applyDemoPreset}
        showDemoCoachmark={showDemoCoachmark}
        setShowDemoCoachmark={setShowDemoCoachmark}
        selectedProfile={selectedProfile}
        DEMO_PROFILE_ID={DEMO_PROFILE_ID}
        textAreaRef={textAreaRef}
        insertOpen={insertOpen}
        setInsertOpen={setInsertOpen}
        insertTag={insertTag}
      />

      {/* ═══ VOICE — who says it ═══ */}
      <div className="studio-column">
        <div className="studio-panel">
        <div className="label-row label-row--spread">
          <span className="label-row label-row--flush">
            <Volume2 className="label-icon" size={14} /> {t('clone.voice_kicker', { defaultValue: 'Voice' })}
          </span>
          <Segmented
            size="sm"
            value={defineMethod}
            onChange={setDefineMethod}
            items={[
              { value: 'audio', label: t('clone.define_from_audio', { defaultValue: 'From audio' }) },
              { value: 'design', label: t('clone.define_by_design', { defaultValue: 'By design' }) },
            ]}
          />
        </div>

        {defineMethod === 'audio' ? (
          <AudioMethodPanel
            t={t}
            selectedProfile={selectedProfile}
            setSelectedProfile={setSelectedProfile}
            profiles={profiles}
            ingestRefAudio={ingestRefAudio}
            refAudio={refAudio}
            isCleaning={isCleaning}
            isRecording={isRecording}
            recordingTime={recordingTime}
            startRecording={startRecording}
            stopRecording={stopRecording}
            refText={refText}
            setRefText={setRefText}
            instruct={instruct}
            setInstruct={setInstruct}
            defineMethod={defineMethod}
            designSeed={designSeed}
            setDesignSeed={setDesignSeed}
            keepSeed={keepSeed}
            setKeepSeed={setKeepSeed}
            showSaveProfile={showSaveProfile}
            setShowSaveProfile={setShowSaveProfile}
            profileName={profileName}
            setProfileName={setProfileName}
            handleSaveProfile={handleSaveProfile}
          />
        ) : (
          <DesignMethodPanel
            t={t}
            describeText={describeText}
            onDescribeChange={onDescribeChange}
            describeMatchedAny={describeMatchedAny}
            describeUnmatched={describeUnmatched}
            chipPersonalities={chipPersonalities}
            activePersonality={activePersonality}
            applyPersonality={applyPersonality}
            applyPreset={applyPreset}
            identityOpen={identityOpen}
            setIdentityOpen={setIdentityOpen}
            identityRecipe={identityRecipe}
            vdStates={vdStates}
            setVdStates={setVdStates}
            onChipKeyDown={onChipKeyDown}
            showSaveProfile={showSaveProfile}
            setShowSaveProfile={setShowSaveProfile}
            profileName={profileName}
            setProfileName={setProfileName}
            handleSaveDesignProfile={handleSaveDesignProfile}
            instruct={instruct}
            language={language}
          />
        )}

        </div>
      </div>
    </div>

      {/* ═══ ACTION BAR — pinned to the column bottom ═══ */}
      <ActionBar
        t={t}
        showOverrides={showOverrides}
        setShowOverrides={setShowOverrides}
        cfg={cfg} setCfg={setCfg}
        speed={speed} setSpeed={setSpeed}
        tShift={tShift} setTShift={setTShift}
        posTemp={posTemp} setPosTemp={setPosTemp}
        classTemp={classTemp} setClassTemp={setClassTemp}
        layerPenalty={layerPenalty} setLayerPenalty={setLayerPenalty}
        duration={duration} setDuration={setDuration}
        denoise={denoise} setDenoise={setDenoise}
        postprocess={postprocess} setPostprocess={setPostprocess}
        language={language} setLanguage={setLanguage}
        steps={steps} setSteps={setSteps}
        showHearDemo={showHearDemo}
        playDemoOutput={playDemoOutput}
        demoAudioPlaying={demoAudioPlaying}
        demoAudioRef={demoAudioRef}
        demoReleaseRef={demoReleaseRef}
        setDemoAudioPlaying={setDemoAudioPlaying}
        outputPlaying={outputPlaying}
        isGenerating={isGenerating}
        handleGenerate={handleGenerate}
        generationTime={generationTime}
        wasGeneratingRef={wasGeneratingRef}
      />
    </div>
  );
}
