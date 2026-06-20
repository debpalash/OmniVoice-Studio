import React, { useState, useEffect, useRef } from 'react';
import {
  Command, Globe, SlidersHorizontal, Volume2, Plus,
  UploadCloud, Square, Mic, Save, UserSquare2, Settings2, ChevronUp, ChevronDown,
  Sparkles, Play, X, Wand2, Dice5,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import SearchableSelect from '../components/SearchableSelect';
import DemoPresetGrid from '../components/DemoPresetGrid';
import ALL_LANGUAGES from '../languages.json';
import { POPULAR_LANGS, PRESETS, TAGS, CATEGORIES } from '../utils/constants';
import {
  PRESET_ICONS, PERSONALITY_ICONS, FALLBACK_VOICE_ICON, FALLBACK_PERSONALITY_ICON, stripVoiceEmoji,
} from '../utils/voiceIcons';
import { Button, Input, Slider, Progress, Segmented } from '../ui';
import { useAppStore } from '../store';
import { API, apiPost } from '../api/client';
import { mergeDescribedAttrs, buildDesignInstruct } from '../utils/voiceInstruct';
import { listEngines } from '../api/engines';
import { claimPlayback, stopActivePlayback, usePlaybackSource } from '../utils/playback';
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
    queryFn: () => fetch(`${API}/personalities`).then(r => r.json()),
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
      <div className="studio-column">
        {/* overflow-visible: the ⊕ Insert popover opens above the textarea and
            must escape the panel's `overflow:auto` box instead of being clipped
            into its scroll region (#481). */}
        <div className="studio-panel clone-panel--overflow-visible">
          <div className="label-row label-row--center">
            <Command className="label-icon" size={14} /> {t('clone.script', { defaultValue: 'Script' })}
          </div>
          {/* Design-tab empty state: 7-card demo grid until the user
              interacts; then it steps aside for the standard form. */}
          {defineMethod === 'design' && !text && !activePersonality && demoPresets.length > 0 && (
            <DemoPresetGrid presets={demoPresets} onUse={applyDemoPreset} />
          )}
          {showDemoCoachmark && defineMethod === 'audio' && selectedProfile === DEMO_PROFILE_ID && (
            <div className="clone-coachmark" role="note">
              <span className="clone-coachmark__icon">💡</span>
              <span className="clone-coachmark__msg">
                {t('demo.clone_coachmark')}
              </span>
              <button
                type="button"
                className="clone-coachmark__close"
                onClick={() => setShowDemoCoachmark(false)}
                aria-label="Dismiss coach mark"
              >
                ×
              </button>
            </div>
          )}
          <div className="clone-script-wrap">
            <textarea
              ref={textAreaRef}
              className="input-base clone-text-area"
              placeholder={defineMethod === 'audio' ? t('clone.prompt_placeholder') : t('clone.design_placeholder')}
              value={text}
              onChange={e => {
                setText(e.target.value);
                if (showDemoCoachmark) setShowDemoCoachmark(false);
              }}
            />
            {/* Expression tokens live behind a popover — fourteen permanent
                chips were renting the page's best pixels for an occasional
                power feature (10x spec §1.4). */}
            <button
              type="button"
              className={`clone-insert-btn ${insertOpen ? 'is-open' : ''}`}
              onClick={() => setInsertOpen(o => !o)}
              aria-expanded={insertOpen}
              aria-label={t('clone.insert_token', { defaultValue: 'Insert expression token' })}
            >
              <Plus size={11} /> {t('clone.insert', { defaultValue: 'Insert' })} <ChevronDown size={10} />
            </button>
            {insertOpen && (
              <div className="clone-insert-backdrop" onClick={() => setInsertOpen(false)} />
            )}
            {insertOpen && (
              <div className="clone-insert-pop" role="menu">
                {TAGS.map(tag => (
                  <button key={tag} className="tag-btn" role="menuitem"
                    onClick={() => { insertTag(tag); setInsertOpen(false); }}>
                    {tag}
                  </button>
                ))}
                <button
                  className="tag-btn clone-auto-extract-btn" role="menuitem"
                  onClick={() => { insertTag('[B EY1 S]'); setInsertOpen(false); }}
                >
                  [CMU]
                </button>
              </div>
            )}
          </div>
        </div>

      </div>

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
          <div>
            {/* Saved voices now live in the right-side WorkspaceVoices panel. */}

            {!selectedProfile && (
              <div className="clone-drop-row">
                <input
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
                  onChange={e => { const f = e.target.files[0]; ingestRefAudio(f); e.target.value = ''; }}
                  className="dub-hidden-file"
                  id="audio-upload"
                />
                <label
                  htmlFor="audio-upload"
                  className="file-drag clone-drop-zone"
                  onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('is-dragging'); }}
                  onDragLeave={e => { e.currentTarget.classList.remove('is-dragging'); }}
                  onDrop={e => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('is-dragging');
                    const file = e.dataTransfer.files[0];
                    const okType = file && (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac|webm)$/i.test(file.name));
                    if (okType) ingestRefAudio(file);
                  }}
                >
                  <UploadCloud color="#a89984" size={18} />
                  <p>{refAudio ? <span className="clone-drop-filename">{refAudio.name}</span> : t('clone.drop_audio')}</p>
                </label>

                <MicButton
                  isCleaning={isCleaning}
                  isRecording={isRecording}
                  recordingTime={recordingTime}
                  onStart={startRecording}
                  onStop={stopRecording}
                />
              </div>
            )}

            {selectedProfile && (
              <div className="clone-profile-banner">
                <span className="clone-profile-banner__label">
                  {t('clone.using_profile', { name: profiles.find(p => p.id === selectedProfile)?.name })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedProfile(null)}
                  leading={<X size={11} />}
                >
                  {t('clone.clear')}
                </Button>
              </div>
            )}

            <div className="grid-2 grid-2--indent">
              <div>
                <div className="label-row">{t('clone.transcript')}</div>
                <input type="text" className="input-base" value={refText} onChange={e => setRefText(e.target.value)} placeholder={t('clone.optional')} />
              </div>
              <div>
                <div className="label-row">{t('clone.style')}</div>
                <input type="text" className="input-base" value={instruct} onChange={e => setInstruct(e.target.value)} placeholder={t('clone.style_placeholder')} />
              </div>
            </div>

            {/* #526: voice-design seed — show + pin + re-roll so tweaks can
                stay on the same base timbre. Design mode only. */}
            {defineMethod === 'design' && (
              <div className="design-seed">
                <div className="label-row">{t('clone.seed_label')}</div>
                <div className="design-seed__row">
                  <input
                    type="number"
                    className="input-base design-seed__input"
                    value={designSeed ?? ''}
                    placeholder={t('clone.seed_placeholder')}
                    onChange={e => {
                      const v = e.target.value.trim();
                      if (v === '') { setDesignSeed(null); return; }
                      const n = parseInt(v, 10);
                      if (Number.isInteger(n)) { setDesignSeed(n); setKeepSeed(true); }
                    }}
                  />
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => { setDesignSeed(Math.floor(Math.random() * 2147483647)); setKeepSeed(true); }}
                    leading={<Dice5 size={12} />}
                    title={t('clone.seed_reroll_hint')}
                  >
                    {t('clone.seed_reroll')}
                  </Button>
                  <label className="design-seed__keep">
                    <input type="checkbox" checked={keepSeed} onChange={e => setKeepSeed(e.target.checked)} />
                    <span>{t('clone.seed_keep')}</span>
                  </label>
                </div>
              </div>
            )}

            {/* Save as profile */}
            {refAudio && !selectedProfile && (
              <div className="clone-save-profile">
                {!showSaveProfile ? (
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => setShowSaveProfile(true)}
                    leading={<Save size={12} />}
                  >
                    {t('clone.save_as_profile')}
                  </Button>
                ) : (
                  <div className="clone-save-profile__row">
                    <Input
                      size="sm"
                      placeholder={t('clone.profile_name')}
                      value={profileName}
                      onChange={e => setProfileName(e.target.value)}
                    />
                    <Button variant="subtle" size="sm" onClick={handleSaveProfile}>{t('clone.save')}</Button>
                    <Button variant="ghost"  size="sm" onClick={() => setShowSaveProfile(false)}>{t('clone.cancel')}</Button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            {/* ── Describe your voice (#317) — free text drives the controls.
                The placeholder explains itself; no extra header (10x §1.2). ── */}
            <div className="describe-voice-block">
              <textarea
                className="input-base describe-voice-area"
                rows={2}
                placeholder={t('clone.describe_placeholder')}
                value={describeText}
                onChange={onDescribeChange}
              />
              {describeText.trim() && !describeMatchedAny && (
                <div className="describe-voice-feedback" role="status">
                  {t('clone.describe_no_match')}
                </div>
              )}
              {describeMatchedAny && describeUnmatched.length > 0 && (
                <div className="describe-voice-feedback" role="status">
                  {t('clone.describe_unmatched', { items: describeUnmatched.join(', ') })}
                </div>
              )}
              <div className="describe-voice-hint">{t('clone.describe_hint')}</div>
            </div>

            {/* ONE preset system (10x §1.3): personalities + the old PROMPT
                presets share a single scrollable "Starting points" lane —
                both set vdStates + instruct; two widgets for one slot was
                the confusion. */}
            <div className="starting-points">
              <div className="starting-points__label">{t('clone.starting_points', { defaultValue: 'Starting points' })}</div>
              <div className="personality-strip starting-points__strip">
                {chipPersonalities.map(p => {
                  const Icon = PERSONALITY_ICONS[p.id] || FALLBACK_PERSONALITY_ICON;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`personality-chip ${activePersonality === p.id ? 'active' : ''}`}
                      onClick={() => applyPersonality(p)}
                    >
                      <span className="personality-chip__icon"><Icon size={13} /></span>
                      {stripVoiceEmoji(t(`clone.personality_${p.id}`, { defaultValue: p.name }))}
                    </button>
                  );
                })}
                {PRESETS.map(p => {
                  const Icon = PRESET_ICONS[p.id] || FALLBACK_VOICE_ICON;
                  return (
                    <button key={p.id} type="button" className="personality-chip" onClick={() => applyPreset(p)}>
                      <span className="personality-chip__icon"><Icon size={13} /></span>
                      {stripVoiceEmoji(t(`clone.preset_${p.id}`, { defaultValue: p.name }))}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Identity recipe (10x §1.5): once any category is set, the
                chip groups collapse to one quiet line — the current voice
                recipe — and the describe box rewrites it live. All-Auto
                (first run) starts expanded. */}
            <button
              type="button"
              className="identity-line"
              onClick={() => setIdentityOpen(o => !o)}
              aria-expanded={identityOpen}
            >
              <span className="identity-line__kicker">{t('clone.identity', { defaultValue: 'Identity' })}</span>
              <span className="identity-line__recipe">{identityRecipe}</span>
              {identityOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {identityOpen && (
            <div className="clone-sliders-col">
              {Object.entries(CATEGORIES).map(([key, options]) => {
                const many = options.length > 6;
                const optLabel = (val) => {
                  const tKey = `clone.opt_${val.replace(/[ -]/g, '_')}`;
                  const tl = t(tKey);
                  return tl !== tKey ? tl : val;
                };
                return (
                  <div key={key} className={`clone-cat ${many ? 'clone-cat--select' : 'clone-cat--chips'}`}>
                    <div className="label-row label-row--sm">
                      {t(`clone.cat_${key}`)}
                      <span className="clone-slider-kicker">
                        {vdStates[key] === 'Auto' ? t('clone.auto_kicker') : `· ${optLabel(vdStates[key])}`}
                      </span>
                    </div>
                    {many ? (
                      <select
                        className="input-base"
                        value={vdStates[key]}
                        onChange={e => setVdStates({ ...vdStates, [key]: e.target.value })}
                      >
                        {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <div className="chip-group" role="radiogroup" aria-label={t(`clone.cat_${key}`)}>
                        {options.map((opt, i) => {
                          const optTKey = `clone.opt_${opt.replace(/[ -]/g, '_')}`;
                          const optTl = t(optTKey);
                          const optLabel = optTl !== optTKey ? optTl : opt;
                          const checked = vdStates[key] === opt;
                          // Roving tabindex: the checked chip is the group's
                          // single tab stop (first chip if nothing matches).
                          const roving = checked || (!options.includes(vdStates[key]) && i === 0);
                          return (
                            <button
                              key={opt}
                              type="button"
                              role="radio"
                              aria-checked={checked}
                              tabIndex={roving ? 0 : -1}
                              className={`chip ${checked ? 'active' : ''}`}
                              onClick={() => setVdStates({ ...vdStates, [key]: opt })}
                              onKeyDown={e => onChipKeyDown(e, key, options)}
                            >
                              {opt === 'Auto'
                                ? <span className="chip-auto"><FALLBACK_VOICE_ICON size={11} /> {stripVoiceEmoji(t('clone.opt_Auto'))}</span>
                                : optLabel}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}

            {/* Save the current design as a reusable profile (0005): the
                backend renders a deterministic identity sample (seed 42)
                and stores the slider picks for later re-editing. */}
            <div className="clone-save-profile">
              {!showSaveProfile ? (
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => setShowSaveProfile(true)}
                  leading={<Save size={12} />}
                >
                  {t('clone.save_design_as_profile', { defaultValue: 'Save design as profile' })}
                </Button>
              ) : (
                <div className="clone-save-profile__row">
                  <Input
                    size="sm"
                    placeholder={t('clone.profile_name')}
                    value={profileName}
                    onChange={e => setProfileName(e.target.value)}
                  />
                  <Button variant="subtle" size="sm"
                    onClick={() => handleSaveDesignProfile(vdStates, buildDesignInstruct(vdStates, instruct).instruct, language)}>
                    {t('clone.save')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowSaveProfile(false)}>{t('clone.cancel')}</Button>
                </div>
              )}
            </div>
          </div>
        )}

        </div>
      </div>
    </div>

    {/* ═══ ACTION BAR — pinned to the column bottom (10x §1.1): generation
        parameters live WITH the button; SYNTHESIZE never scrolls away.
        Overrides expand upward, above the controls row. ═══ */}
    <div className="studio-action-bar clone-panel--overflow-visible">
        {showOverrides && (
          <div className="override-content">
            <div className="grid-4">
              <div>
                <div className="label-row label-row--spread"><span>CFG</span><span className="val-bubble">{cfg}</span></div>
                <input type="range" min="1.0" max="4.0" step="0.1" value={cfg} onChange={e => setCfg(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>{t('clone.speed')}</span><span className="val-bubble">{speed}x</span></div>
                <input type="range" min="0.5" max="2.0" step="0.1" value={speed} onChange={e => setSpeed(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>{t('clone.tshift')}</span><span className="val-bubble">{tShift}</span></div>
                <input type="range" min="0" max="1.0" step="0.05" value={tShift} onChange={e => setTShift(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>{t('clone.pos_temp')}</span><span className="val-bubble">{posTemp}</span></div>
                <input type="range" min="0" max="10" step="0.5" value={posTemp} onChange={e => setPosTemp(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>{t('clone.class_temp')}</span><span className="val-bubble">{classTemp}</span></div>
                <input type="range" min="0" max="2" step="0.1" value={classTemp} onChange={e => setClassTemp(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>{t('clone.layer_pen')}</span><span className="val-bubble">{layerPenalty}</span></div>
                <input type="range" min="0" max="10" step="0.5" value={layerPenalty} onChange={e => setLayerPenalty(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row"><span>{t('clone.duration')}</span></div>
                <input type="text" className="input-base clone-duration-input" value={duration} onChange={e => setDuration(e.target.value)} placeholder={t('clone.auto')} />
              </div>
              <div className="clone-prod-col">
                <label className="clone-prod-check">
                  <input type="checkbox" checked={denoise} onChange={e => setDenoise(e.target.checked)} /> {t('clone.denoise')}
                </label>
                <label className="clone-prod-check">
                  <input type="checkbox" checked={postprocess} onChange={e => setPostprocess(e.target.checked)} /> {t('clone.postprocess')}
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Controls row: language · steps · overrides disclosure */}
        <div className="studio-action-bar__row">
          <div className="studio-action-bar__lang">
            <Globe size={12} className="label-icon" />
            <SearchableSelect
              value={language}
              options={ALL_LANGUAGES}
              popular={POPULAR_LANGS}
              recentsKey="omnivoice.recents.genLang"
              onChange={setLanguage}
            />
          </div>
          <label className="studio-action-bar__steps" title={t('clone.steps')}>
            <SlidersHorizontal size={12} className="label-icon" />
            <input type="range" min="8" max="64" value={steps} onChange={e => setSteps(Number(e.target.value))} />
            <span className="val-bubble">{steps}</span>
          </label>
          <button
            type="button"
            className="studio-action-bar__overrides"
            onClick={() => setShowOverrides(!showOverrides)}
            aria-expanded={showOverrides}
          >
            <Settings2 size={13} /> {t('clone.production_overrides')}
            {showOverrides ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        </div>

        {showHearDemo ? (
          <>
            <Button
              variant="primary"
              block
              onClick={playDemoOutput}
              leading={<Play size={14} />}
              className="clone-footer-cta"
            >
              {demoAudioPlaying ? t('demo.stop_demo') : t('demo.hear_demo')}
            </Button>
            <div className="clone-hear-demo-chip">
              {t('demo.prerendered_chip')}
            </div>
            <audio
              ref={demoAudioRef}
              onEnded={() => {
                setDemoAudioPlaying(false);
                demoReleaseRef.current?.();
                demoReleaseRef.current = null;
              }}
              preload="none"
            />
          </>
        ) : outputPlaying && !isGenerating ? (
          /* Synthesized output is playing — the CTA becomes a Stop button
             (#316) so playback can be halted immediately. */
          <Button
            variant="primary"
            block
            onClick={stopActivePlayback}
            leading={<Square size={14} />}
            className="clone-footer-cta"
          >
            {t('clone.stop_playback')}
          </Button>
        ) : (
          <Button
            variant="primary"
            block
            loading={isGenerating}
            onClick={handleGenerate}
            leading={!isGenerating && <Play size={14} />}
            className="clone-footer-cta"
          >
            {isGenerating ? t('clone.synthesizing', { seconds: generationTime }) : t('clone.synthesize')}
          </Button>
        )}
        {isGenerating && (
          <Progress
            value={Math.min((generationTime / 8) * 100, 95)}
            tone="brand"
            size="sm"
            className="clone-footer-cta"
          />
        )}
        {/* 10x P4 a11y (spec §3): persistent polite live region — screen
            readers hear generation start AND finish in-workspace, without
            relying on the FloatingPill. sr-only keeps it out of the
            action-bar flex flow; static text avoids per-second re-announces
            from the ticking "Synthesizing… (Ns)" button label. */}
        <div className="sr-only" role="status" aria-live="polite">
          {isGenerating
            ? t('clone.generating_status', { defaultValue: 'Generating audio…' })
            : wasGeneratingRef.current
              ? t('clone.generating_done_status', { defaultValue: 'Generation finished' })
              : null}
        </div>
    </div>
    </div>
  );
}

function MicButton({ isCleaning, isRecording, recordingTime, onStart, onStop }) {
  const { t } = useTranslation();
  if (isCleaning) {
    return (
      <div className="mic-btn mic-btn--cleaning">
        <Sparkles size={18} className="spinner" />
        <span>{t('clone.cleaning')}</span>
      </div>
    );
  }
  if (isRecording) {
    return (
      <button type="button" onClick={onStop} className="mic-btn mic-btn--recording">
        <Square size={18} fill="currentColor" />
        <span>{recordingTime}s</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={onStart} className="mic-btn mic-btn--idle" title={t('clone.record')}>
      <Mic size={18} />
      <span>{t('clone.record')}</span>
    </button>
  );
}
