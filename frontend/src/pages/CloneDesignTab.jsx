import React from 'react';
import {
  PanelLeftOpen, PanelLeftClose, Command, Globe, SlidersHorizontal, Volume2, User,
  UploadCloud, Loader, Square, Mic, Save, UserSquare2, Settings2, ChevronUp, ChevronDown,
  Sparkles, Play, Trash2,
} from 'lucide-react';
import SearchableSelect from '../components/SearchableSelect';
import ALL_LANGUAGES from '../languages.json';
import { POPULAR_LANGS, PRESETS, TAGS, CATEGORIES } from '../utils/constants';

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

  return (
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 6, minHeight: 0 }}>

      {/* ═══ LEFT COLUMN: prompt + language/steps ═══ */}
      <div className="studio-column">
        <div className="studio-panel">
          <div className="label-row" style={{ alignItems: 'center' }}>
            <button
              onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3px',
                marginRight: '6px',
                background: isSidebarCollapsed ? 'rgba(211,134,155,0.1)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${isSidebarCollapsed ? 'rgba(211,134,155,0.3)' : 'rgba(255,255,255,0.08)'}`,
                color: isSidebarCollapsed ? '#d3869b' : '#a89984',
                borderRadius: 4, cursor: 'pointer',
              }}
              title="Toggle Sidebar"
            >
              {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
            </button>
            <Command className="label-icon" size={14} /> Prompt
          </div>
          {mode === 'design' && (
            <div className="preset-grid">
              {PRESETS.map(p => (
                <button key={p.id} className="preset-btn" onClick={() => applyPreset(p)}>{p.name}</button>
              ))}
            </div>
          )}
          <textarea
            ref={textAreaRef}
            className="input-base"
            style={{ flex: 1, resize: 'none', minHeight: 60, marginBottom: '6px' }}
            placeholder={mode === 'clone' ? "What should this voice say? ✍️" : "Describe the voice, then type what it says…"}
            value={text}
            onChange={e => setText(e.target.value)}
          />
          <div className="tags-container">
            {TAGS.map(tag => <button key={tag} className="tag-btn" onClick={() => insertTag(tag)}>{tag}</button>)}
            <button
              className="tag-btn"
              style={{ borderColor: '#b8bb26', color: '#b8bb26' }}
              onClick={() => insertTag('[B EY1 S]')}
            >
              [CMU]
            </button>
          </div>
        </div>

        <div className="studio-panel" style={{ overflow: 'visible' }}>
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
              <div className="label-row" style={{ justifyContent: 'space-between' }}>
                <span className="label-row" style={{ marginBottom: 0 }}>
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
              <div style={{ marginBottom: 10 }}>
                <div className="label-row" style={{ fontSize: '0.7rem', marginBottom: 4 }}><User size={12} /> Saved Profiles</div>
                <div className="preset-grid">
                  {profiles.map(p => (
                    <div
                      key={p.id}
                      className={`preset-btn ${selectedProfile === p.id ? 'profile-active' : ''}`}
                      onClick={() => handleSelectProfile(p)}
                      style={{ position: 'relative' }}
                    >
                      <User size={10} /> {p.name}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteProfile(p.id); }}
                        style={{ position: 'absolute', top: 2, right: 2, background: 'none', border: 'none', color: '#fb4934', cursor: 'pointer', padding: 0 }}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!selectedProfile && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                <input
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
                  onChange={e => { const f = e.target.files[0]; ingestRefAudio(f); e.target.value = ''; }}
                  style={{ display: 'none' }}
                  id="audio-upload"
                />
                <label
                  htmlFor="audio-upload"
                  className="file-drag"
                  style={{ padding: '6px', flex: 1 }}
                  onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = '#d3869b'; e.currentTarget.style.background = 'rgba(211,134,155,0.05)'; }}
                  onDragLeave={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.background = ''; }}
                  onDrop={e => {
                    e.preventDefault();
                    e.currentTarget.style.borderColor = '';
                    e.currentTarget.style.background = '';
                    const file = e.dataTransfer.files[0];
                    const okType = file && (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac|webm)$/i.test(file.name));
                    if (okType) ingestRefAudio(file);
                  }}
                >
                  <UploadCloud color="#a89984" size={18} />
                  <p>{refAudio ? <span style={{ color: '#ebdbb2' }}>{refAudio.name}</span> : 'Drop audio here — or click. WAV, MP3, M4A… 🎤'}</p>
                </label>

                {/* Mic Record Button */}
                {isCleaning ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '8px 16px', background: 'rgba(184,187,38,0.1)', border: '1px solid rgba(184,187,38,0.2)', borderRadius: 8, gap: 4, minWidth: 70 }}>
                    <Loader size={18} color="#b8bb26" style={{ animation: 'spin 1s linear infinite' }} />
                    <span style={{ fontSize: '0.6rem', color: '#b8bb26' }}>Cleaning...</span>
                  </div>
                ) : isRecording ? (
                  <button
                    onClick={stopRecording}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
                      padding: '8px 16px', background: 'rgba(251,73,52,0.15)', border: '2px solid #fb4934',
                      borderRadius: 8, cursor: 'pointer', color: '#fb4934', minWidth: 70,
                      animation: 'pulse 1s ease-in-out infinite',
                    }}
                  >
                    <Square size={18} fill="#fb4934" />
                    <span style={{ fontSize: '0.65rem', fontWeight: 600 }}>{recordingTime}s</span>
                  </button>
                ) : (
                  <button
                    onClick={startRecording}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
                      padding: '8px 16px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 8, cursor: 'pointer', color: '#a89984', minWidth: 70,
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#fb4934'; e.currentTarget.style.color = '#fb4934'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#a89984'; }}
                    title="Record your voice for cloning"
                  >
                    <Mic size={18} />
                    <span style={{ fontSize: '0.6rem' }}>Record</span>
                  </button>
                )}
              </div>
            )}

            {selectedProfile && (
              <div style={{ padding: 8, background: 'rgba(142,192,124,0.08)', border: '1px solid rgba(142,192,124,0.2)', borderRadius: 6, fontSize: '0.8rem', marginBottom: 8 }}>
                <span style={{ color: '#8ec07c' }}>Using profile: {profiles.find(p => p.id === selectedProfile)?.name}</span>
                <button
                  onClick={() => setSelectedProfile(null)}
                  style={{ marginLeft: 8, background: 'none', border: 'none', color: '#a89984', cursor: 'pointer', fontSize: '0.75rem', textDecoration: 'underline' }}
                >
                  clear
                </button>
              </div>
            )}

            <div className="grid-2" style={{ marginTop: 6 }}>
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
              <div style={{ marginTop: 8 }}>
                {!showSaveProfile ? (
                  <button
                    onClick={() => setShowSaveProfile(true)}
                    style={{ background: 'none', border: '1px solid rgba(142,192,124,0.3)', color: '#8ec07c', fontSize: '0.75rem', padding: '4px 10px', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <Save size={12} /> Save as Voice Profile
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      className="input-base"
                      style={{ flex: 1, fontSize: '0.8rem', padding: '4px 8px' }}
                      placeholder="Profile name..."
                      value={profileName}
                      onChange={e => setProfileName(e.target.value)}
                    />
                    <button
                      onClick={handleSaveProfile}
                      style={{ background: 'rgba(142,192,124,0.2)', border: '1px solid rgba(142,192,124,0.4)', color: '#8ec07c', fontSize: '0.75rem', padding: '4px 10px', borderRadius: 6, cursor: 'pointer' }}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setShowSaveProfile(false)}
                      style={{ background: 'none', border: 'none', color: '#a89984', cursor: 'pointer', fontSize: '0.75rem' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="label-row"><UserSquare2 className="label-icon" size={14} /> Voice Profile</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {Object.entries(CATEGORIES).map(([key, options]) => {
                const many = options.length > 6;
                return (
                  <div key={key}>
                    <div className="label-row" style={{ fontSize: '0.7rem', marginBottom: 4 }}>
                      {key.replace(/([A-Z])/g, ' $1').trim()}
                      <span style={{ marginLeft: 6, fontSize: '0.58rem', color: '#7c6f64', fontWeight: 500 }}>
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

        <div className="studio-panel" style={{ overflow: 'visible' }}>
        <div className="override-toggle" onClick={() => setShowOverrides(!showOverrides)}>
          <span><Settings2 size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Production Overrides</span>
          {showOverrides ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
        {showOverrides && (
          <div className="override-content">
            <div className="grid-4">
              <div>
                <div className="label-row" style={{ justifyContent: 'space-between' }}><span>CFG</span><span className="val-bubble">{cfg}</span></div>
                <input type="range" min="1.0" max="4.0" step="0.1" value={cfg} onChange={e => setCfg(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row" style={{ justifyContent: 'space-between' }}><span>Speed</span><span className="val-bubble">{speed}x</span></div>
                <input type="range" min="0.5" max="2.0" step="0.1" value={speed} onChange={e => setSpeed(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row" style={{ justifyContent: 'space-between' }}><span>t_shift</span><span className="val-bubble">{tShift}</span></div>
                <input type="range" min="0" max="1.0" step="0.05" value={tShift} onChange={e => setTShift(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row" style={{ justifyContent: 'space-between' }}><span>Pos Temp</span><span className="val-bubble">{posTemp}</span></div>
                <input type="range" min="0" max="10" step="0.5" value={posTemp} onChange={e => setPosTemp(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row" style={{ justifyContent: 'space-between' }}><span>Class Temp</span><span className="val-bubble">{classTemp}</span></div>
                <input type="range" min="0" max="2" step="0.1" value={classTemp} onChange={e => setClassTemp(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row" style={{ justifyContent: 'space-between' }}><span>Layer Pen</span><span className="val-bubble">{layerPenalty}</span></div>
                <input type="range" min="0" max="10" step="0.5" value={layerPenalty} onChange={e => setLayerPenalty(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row"><span>Duration</span></div>
                <input type="text" className="input-base" value={duration} onChange={e => setDuration(e.target.value)} placeholder="Auto" style={{ fontSize: '0.8rem' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={denoise} onChange={e => setDenoise(e.target.checked)} /> Denoise
                </label>
                <label style={{ fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={postprocess} onChange={e => setPostprocess(e.target.checked)} /> Postprocess
                </label>
              </div>
            </div>
          </div>
        )}

        <button className="btn-primary" onClick={handleGenerate} disabled={isGenerating}>
          {isGenerating ? <Sparkles className="spinner" size={16} /> : <Play size={16} />}
          {isGenerating ? `Synthesizing... (${generationTime}s)` : 'Synthesize Audio'}
        </button>
        {isGenerating && (
          <div className="progress-container">
            <div className="progress-fill" style={{ width: `${Math.min((generationTime / 8) * 100, 95)}%` }} />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
