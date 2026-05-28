import React, { useState, useEffect, useRef } from 'react';
import {
  PanelLeftOpen, PanelLeftClose, Command, Globe, SlidersHorizontal, Volume2, User,
  UploadCloud, Square, Mic, Save, UserSquare2, Settings2, ChevronUp, ChevronDown,
  Sparkles, Play, Trash2, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import SearchableSelect from '../components/SearchableSelect';
import DemoPresetGrid from '../components/DemoPresetGrid';
import ALL_LANGUAGES from '../languages.json';
import { POPULAR_LANGS, PRESETS, TAGS, CATEGORIES } from '../utils/constants';
import { Button, Input, Slider, Progress } from '../ui';
import { API } from '../api/client';
import { listEngines } from '../api/engines';
import './CloneDesignTab.css';

export default function CloneDesignTab(props) {
  const {
    mode,
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
    isSidebarCollapsed, setIsSidebarCollapsed,
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
    handleSelectProfile, handleDeleteProfile,
    handleSaveProfile, handleGenerate,
    startRecording, stopRecording,
    ingestRefAudio,
  } = props;

  const { t } = useTranslation();
  const [activePersonality, setActivePersonality] = useState('');

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

  // Demo coach-mark: when the user enters the Clone tab with the bundled
  // demo profile (demo0001) freshly selected and the textarea is empty,
  // prefill a punchy starter prompt and show a one-line coach-mark above
  // the textarea. Both auto-dismiss as soon as the user types anything.
  // Tracked via localStorage so we don't re-prefill on every visit.
  const DEMO_PROFILE_ID = 'demo0001';
  const DEMO_PROMPT = "Welcome aboard. I was just a three-second clip a moment ago — now I can say anything you'd like, in your voice or mine.";
  const [showDemoCoachmark, setShowDemoCoachmark] = useState(false);

  useEffect(() => {
    if (mode !== 'clone') return;
    if (selectedProfile !== DEMO_PROFILE_ID) return;
    if (typeof window === 'undefined') return;
    if (localStorage.getItem('omnivoice.demoClonePrompted') === '1') return;
    if (text) return; // user already typed something
    setText(DEMO_PROMPT);
    setShowDemoCoachmark(true);
    localStorage.setItem('omnivoice.demoClonePrompted', '1');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedProfile]);

  // "Hear demo" fallback: when no TTS engine is ready and the user is on
  // the demo profile, the Synthesize button is swapped for one that plays
  // the pre-rendered demo_clone_output.wav. This guarantees a working
  // "wow moment" on first launch before any model downloads finish.
  const showHearDemo =
    mode === 'clone' && selectedProfile === DEMO_PROFILE_ID && !anyTtsReady;
  const demoAudioRef = useRef(null);
  const [demoAudioPlaying, setDemoAudioPlaying] = useState(false);

  const playDemoOutput = () => {
    const audio = demoAudioRef.current;
    if (!audio) return;
    if (demoAudioPlaying) {
      audio.pause();
      setDemoAudioPlaying(false);
      return;
    }
    audio.src = `${API}/demo_audio/demo_clone_output.wav`;
    audio.currentTime = 0;
    audio.play()
      .then(() => setDemoAudioPlaying(true))
      .catch(() => setDemoAudioPlaying(false));
  };

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
    <div className="clone-split-grid">

      {/* ═══ LEFT COLUMN: prompt + language/steps ═══ */}
      <div className="studio-column">
        <div className="studio-panel">
          <div className="label-row label-row--center">
            <Button
              variant="icon"
              iconSize="sm"
              active={isSidebarCollapsed}
              onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
              title="Toggle Sidebar"
              className="label-row__kicker"
            >
              {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
            </Button>
            <Command className="label-icon" size={14} /> Prompt
          </div>
          {/* Design-tab empty state: 7-card demo grid replaces the bare
              attribute-preset buttons when the user has not yet typed
              anything and no personality is active. As soon as they
              interact, the grid steps aside for the standard form. */}
          {mode === 'design' && !text && !activePersonality && demoPresets.length > 0 && (
            <DemoPresetGrid presets={demoPresets} onUse={applyDemoPreset} />
          )}
          {mode === 'design' && (text || activePersonality || demoPresets.length === 0) && (
            <div className="preset-grid">
              {PRESETS.map(p => (
                <button key={p.id} className="preset-btn" onClick={() => applyPreset(p)}>{p.name}</button>
              ))}
            </div>
          )}
          {showDemoCoachmark && mode === 'clone' && selectedProfile === DEMO_PROFILE_ID && (
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
          <textarea
            ref={textAreaRef}
            className="input-base clone-text-area"
            placeholder={mode === 'clone' ? "What should this voice say? ✍️" : "Describe the voice, then type what it says…"}
            value={text}
            onChange={e => {
              setText(e.target.value);
              if (showDemoCoachmark) setShowDemoCoachmark(false);
            }}
          />
          <div className="tags-container">
            {TAGS.map(tag => <button key={tag} className="tag-btn" onClick={() => insertTag(tag)}>{tag}</button>)}
            <button
              className="tag-btn clone-auto-extract-btn"
              onClick={() => insertTag('[B EY1 S]')}
            >
              [CMU]
            </button>
          </div>
        </div>

        <div className="studio-panel clone-panel--overflow-visible">
          <div className="grid-2">
            <div>
              <div className="label-row"><Globe className="label-icon" size={14} /> Language ({ALL_LANGUAGES.length - 1})</div>
              <SearchableSelect
                value={language}
                options={ALL_LANGUAGES}
                popular={POPULAR_LANGS}
                recentsKey="omnivoice.recents.genLang"
                onChange={setLanguage}
              />
            </div>
            <div>
              <div className="label-row label-row--spread">
                <span className="label-row label-row--flush">
                  <SlidersHorizontal className="label-icon" size={14} /> Steps
                </span>
                <span className="val-bubble">{steps}</span>
              </div>
              <input type="range" min="8" max="64" value={steps} onChange={e => setSteps(Number(e.target.value))} />
            </div>
          </div>
        </div>
      </div>

      {/* ═══ RIGHT COLUMN: voice source + overrides/synth ═══ */}
      <div className="studio-column">
        <div className="studio-panel">
        {mode === 'clone' ? (
          <div>
            <div className="label-row"><Volume2 className="label-icon" size={14} /> Voice Source</div>

            {/* ── VOICE PROFILES ── */}
            {profiles.length > 0 && (
              <div className="clone-profile-block">
                <div className="label-row label-row--sm"><User size={12} /> Saved Profiles</div>
                <div className="preset-grid">
                  {profiles.map(p => (
                    <div
                      key={p.id}
                      className={`preset-btn clone-profile-card ${selectedProfile === p.id ? 'profile-active' : ''}`}
                      onClick={() => handleSelectProfile(p)}
                    >
                      <User size={10} /> {p.name}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleDeleteProfile(p.id); }}
                        className="clone-profile-delete"
                        aria-label="Delete profile"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                  <p>{refAudio ? <span className="clone-drop-filename">{refAudio.name}</span> : 'Drop audio here — or click. WAV, MP3, M4A… 🎤'}</p>
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
                  Using profile: {profiles.find(p => p.id === selectedProfile)?.name}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedProfile(null)}
                  leading={<X size={11} />}
                >
                  clear
                </Button>
              </div>
            )}

            <div className="grid-2 grid-2--indent">
              <div>
                <div className="label-row">Transcript</div>
                <input type="text" className="input-base" value={refText} onChange={e => setRefText(e.target.value)} placeholder="(Optional)" />
              </div>
              <div>
                <div className="label-row">Style</div>
                <input type="text" className="input-base" value={instruct} onChange={e => setInstruct(e.target.value)} placeholder="e.g. whisper" />
              </div>
            </div>

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
                    Save as Voice Profile
                  </Button>
                ) : (
                  <div className="clone-save-profile__row">
                    <Input
                      size="sm"
                      placeholder="Profile name…"
                      value={profileName}
                      onChange={e => setProfileName(e.target.value)}
                    />
                    <Button variant="subtle" size="sm" onClick={handleSaveProfile}>Save</Button>
                    <Button variant="ghost"  size="sm" onClick={() => setShowSaveProfile(false)}>Cancel</Button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="label-row"><UserSquare2 className="label-icon" size={14} /> {t('voice.personality')}</div>

            {/* Personality presets — chip-only entries. Demo presets
                render as full cards in the empty state above; including
                them here too would duplicate the affordance. */}
            {chipPersonalities.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div className="personality-label">{t('voice.pick_personality')}</div>
                <div className="personality-strip">
                  {chipPersonalities.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      className={`personality-chip ${activePersonality === p.id ? 'active' : ''}`}
                      onClick={() => applyPersonality(p)}
                    >
                      <span className="personality-chip__icon">{p.icon}</span>
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="clone-sliders-col">
              {Object.entries(CATEGORIES).map(([key, options]) => {
                const many = options.length > 6;
                return (
                  <div key={key}>
                    <div className="label-row label-row--sm">
                      {key.replace(/([A-Z])/g, ' $1').trim()}
                      <span className="clone-slider-kicker">
                        {vdStates[key] === 'Auto' ? '· auto' : `· ${vdStates[key]}`}
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
                      <div className="chip-group">
                        {options.map(opt => (
                          <button
                            key={opt}
                            type="button"
                            className={`chip ${vdStates[key] === opt ? 'active' : ''}`}
                            onClick={() => setVdStates({ ...vdStates, [key]: opt })}
                          >
                            {opt === 'Auto' ? '✨ Auto' : opt}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        </div>

        <div className="studio-panel clone-panel--overflow-visible">
        <div className="override-toggle" onClick={() => setShowOverrides(!showOverrides)}>
          <span><Settings2 size={14} className="clone-icon-inline" /> Production Overrides</span>
          {showOverrides ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
        {showOverrides && (
          <div className="override-content">
            <div className="grid-4">
              <div>
                <div className="label-row label-row--spread"><span>CFG</span><span className="val-bubble">{cfg}</span></div>
                <input type="range" min="1.0" max="4.0" step="0.1" value={cfg} onChange={e => setCfg(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>Speed</span><span className="val-bubble">{speed}x</span></div>
                <input type="range" min="0.5" max="2.0" step="0.1" value={speed} onChange={e => setSpeed(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>t_shift</span><span className="val-bubble">{tShift}</span></div>
                <input type="range" min="0" max="1.0" step="0.05" value={tShift} onChange={e => setTShift(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>Pos Temp</span><span className="val-bubble">{posTemp}</span></div>
                <input type="range" min="0" max="10" step="0.5" value={posTemp} onChange={e => setPosTemp(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>Class Temp</span><span className="val-bubble">{classTemp}</span></div>
                <input type="range" min="0" max="2" step="0.1" value={classTemp} onChange={e => setClassTemp(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>Layer Pen</span><span className="val-bubble">{layerPenalty}</span></div>
                <input type="range" min="0" max="10" step="0.5" value={layerPenalty} onChange={e => setLayerPenalty(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row"><span>Duration</span></div>
                <input type="text" className="input-base clone-duration-input" value={duration} onChange={e => setDuration(e.target.value)} placeholder="Auto" />
              </div>
              <div className="clone-prod-col">
                <label className="clone-prod-check">
                  <input type="checkbox" checked={denoise} onChange={e => setDenoise(e.target.checked)} /> Denoise
                </label>
                <label className="clone-prod-check">
                  <input type="checkbox" checked={postprocess} onChange={e => setPostprocess(e.target.checked)} /> Postprocess
                </label>
              </div>
            </div>
          </div>
        )}

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
              onEnded={() => setDemoAudioPlaying(false)}
              preload="none"
            />
          </>
        ) : (
          <Button
            variant="primary"
            block
            loading={isGenerating}
            onClick={handleGenerate}
            leading={!isGenerating && <Play size={14} />}
            className="clone-footer-cta"
          >
            {isGenerating ? `Synthesizing… (${generationTime}s)` : 'Synthesize Audio'}
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
        </div>
      </div>
    </div>
  );
}

function MicButton({ isCleaning, isRecording, recordingTime, onStart, onStop }) {
  if (isCleaning) {
    return (
      <div className="mic-btn mic-btn--cleaning">
        <Sparkles size={18} className="spinner" />
        <span>Cleaning…</span>
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
    <button type="button" onClick={onStart} className="mic-btn mic-btn--idle" title="Record your voice for cloning">
      <Mic size={18} />
      <span>Record</span>
    </button>
  );
}
