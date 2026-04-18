import React, { Suspense, lazy } from 'react';
import {
  PanelLeftOpen, PanelLeftClose, Film, Save, UploadCloud, Sparkles, Loader, Square,
  FileText, Play, DownloadIcon, Volume2, Music, Package, Layers,
  Languages, ChevronDown, ChevronUp, Wand2, Trash2, Check, Globe, UserSquare2, User,
} from 'lucide-react';
// lucide-react exports DownloadIcon as "Download"; alias here to match App.jsx naming.
import { Download as Download } from 'lucide-react';
import SearchableSelect from '../components/SearchableSelect';
import WaveformTimeline from '../components/WaveformTimeline';
import ALL_LANGUAGES from '../languages.json';
import { POPULAR_LANGS, POPULAR_ISO, PRESETS } from '../utils/constants';
import { LANG_CODES } from '../utils/languages';
import { formatTime } from '../utils/format';
import { API } from '../api/client';

const DubSegmentTable = lazy(() => import('../components/DubSegmentTable'));

const LazyFallback = () => (
  <div style={{ padding: 12, color: '#6b6657', fontSize: '0.7rem' }}>Loading…</div>
);

export default function DubTab(props) {
  const {
    // State
    dubJobId, dubStep, dubVideoFile, dubFilename, dubDuration, dubSegments, dubTranscript,
    dubLang, dubLangCode, dubInstruct, dubTracks, dubError, dubProgress, dubLocalBlobUrl,
    activeProjectName,
    isSidebarCollapsed, setIsSidebarCollapsed,
    transcribeElapsed, translateProvider, setTranslateProvider,
    isTranslating,
    preserveBg, setPreserveBg, defaultTrack, setDefaultTrack,
    exportTracks, setExportTracks,
    showTranscript, setShowTranscript,
    profiles,
    segmentPreviewLoading,
    selectedSegIds,
    // Setters
    setDubVideoFile, setDubStep, setDubLocalBlobUrl, setDubSegments,
    setDubLang, setDubLangCode, setDubInstruct,
    // Handlers
    handleDubAbort, handleDubUpload, handleDubStop, handleDubGenerate,
    handleDubDownload, handleDubAudioDownload,
    handleSegmentPreview, handleTranslateAll, handleCleanupSegments,
    triggerDownload, fileToMediaUrl,
    editSegments, saveProject, resetDub,
    segmentEditField, segmentDelete, segmentRestoreOriginal, segmentSplit, segmentMerge,
    toggleSegSelect, selectAllSegs, clearSegSelection,
    bulkApplyToSelected, bulkDeleteSelected,
  } = props;

  const showIdleSkeleton = !(dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done'));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* ── Idle: show full editor skeleton with drop zone ── */}
      {showIdleSkeleton && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Header bar */}
          <div className="studio-panel" style={{ padding: '4px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <div className="label-row" style={{ marginBottom: 0, alignItems: 'center' }}>
              <button
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3px', marginRight: '6px', background: isSidebarCollapsed ? 'rgba(211,134,155,0.1)' : 'rgba(255,255,255,0.05)', border: `1px solid ${isSidebarCollapsed ? 'rgba(211,134,155,0.3)' : 'rgba(255,255,255,0.08)'}`, color: isSidebarCollapsed ? '#d3869b' : '#a89984', borderRadius: 4, cursor: 'pointer' }}
                title="Toggle Sidebar"
              >
                {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
              </button>
              <Film className="label-icon" size={11} /> <span style={{ fontWeight: 600 }}>{dubVideoFile ? dubVideoFile.name : 'Video Dubbing Studio'}</span>
              {dubVideoFile && <span style={{ color: '#a89984', fontWeight: 400 }}> · {(dubVideoFile.size / 1024 / 1024).toFixed(1)} MB</span>}
              {activeProjectName && <span style={{ color: '#b8bb26', marginLeft: 6 }}>— {activeProjectName}</span>}
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button disabled style={{ background: 'none', border: '1px solid rgba(184,187,38,0.15)', color: '#665c54', fontSize: '0.62rem', padding: '2px 6px', borderRadius: 3, cursor: 'default', display: 'flex', alignItems: 'center', gap: 3 }}>
                <Save size={9} /> Save
              </button>
              <button disabled style={{ background: 'none', border: '1px solid rgba(251,73,52,0.12)', color: '#665c54', fontSize: '0.62rem', padding: '2px 6px', borderRadius: 3, cursor: 'default' }}>Reset</button>
            </div>
          </div>

          {/* SPLIT LAYOUT skeleton */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, flex: 1, minHeight: 0 }}>
            {/* LEFT */}
            <div className="studio-panel" style={{ marginBottom: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                          <Loader className="spinner" size={20} color="#d3869b" />
                          <span style={{ color: '#ebdbb2', fontWeight: 500, fontSize: '0.85rem' }}>Extracting audio…</span>
                          <button onClick={handleDubAbort} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: 'rgba(251,73,52,0.15)', border: '1px solid rgba(251,73,52,0.4)', color: '#fb4934', borderRadius: 6, fontSize: '0.75rem', cursor: 'pointer' }}>
                            <Square size={11} /> Stop
                          </button>
                        </div>
                      ) : dubStep === 'transcribing' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, width: '100%' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Loader className="spinner" size={18} color="#d3869b" />
                            <span style={{ color: '#ebdbb2', fontWeight: 500, fontSize: '0.85rem' }}>Transcribing with Whisper…</span>
                          </div>
                          <div style={{ display: 'flex', gap: 14, fontSize: '0.78rem', color: '#a89984' }}>
                            <span>⏱ {Math.floor(transcribeElapsed / 60)}:{String(transcribeElapsed % 60).padStart(2, '0')} elapsed</span>
                            {dubDuration > 0 && (() => {
                              const est = Math.max(10, Math.ceil(dubDuration / 60) * 3 + 8);
                              return <span>~{Math.max(0, est - transcribeElapsed)}s remaining</span>;
                            })()}
                          </div>
                          {dubDuration > 0 && (
                            <div className="progress-container" style={{ width: '80%', maxWidth: 340 }}>
                              <div className="progress-fill" style={{ width: `${Math.min(95, (transcribeElapsed / Math.max(10, Math.ceil(dubDuration / 60) * 3 + 8)) * 100)}%` }} />
                            </div>
                          )}
                          <button onClick={handleDubAbort} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: 'rgba(251,73,52,0.15)', border: '1px solid rgba(251,73,52,0.4)', color: '#fb4934', borderRadius: 6, fontSize: '0.75rem', cursor: 'pointer' }}>
                            <Square size={11} /> Stop
                          </button>
                        </div>
                      ) : null
                    }
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <label htmlFor="video-upload" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem', color: '#a89984' }}>
                      <Film size={13} /> Change file
                    </label>
                    <button className="btn-primary" style={{ flex: 1, marginTop: 0 }}
                      onClick={handleDubUpload}
                      disabled={dubStep === 'uploading' || dubStep === 'transcribing'}>
                      {dubStep === 'uploading' || dubStep === 'transcribing'
                        ? <><Loader className="spinner" size={14} /> Processing…</>
                        : <><Sparkles size={14} /> Upload &amp; Transcribe</>}
                    </button>
                  </div>
                </>
              ) : (
                <label htmlFor="video-upload" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, cursor: 'pointer', border: '2px dashed rgba(255,255,255,0.06)', borderRadius: 8, transition: 'all 0.3s', margin: 4 }}
                  onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = '#d3869b'; e.currentTarget.style.background = 'rgba(211,134,155,0.05)'; }}
                  onDragLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'; e.currentTarget.style.background = 'transparent'; }}
                  onDrop={e => {
                    e.preventDefault();
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
                    e.currentTarget.style.background = 'transparent';
                    const file = e.dataTransfer.files[0];
                    if (file && file.type.startsWith('video/')) {
                      setDubVideoFile(file);
                      setDubStep('idle');
                      fileToMediaUrl(file, null).then(urls => setDubLocalBlobUrl(urls));
                    }
                  }}>
                  <div style={{ width: 60, height: 60, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(211,134,155,0.06)', border: '1px solid rgba(211,134,155,0.1)' }}>
                    <UploadCloud color="#d3869b" size={28} />
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '0.9rem', color: '#ebdbb2', fontWeight: 500, marginBottom: 4 }}>Drop video here</div>
                    <div style={{ fontSize: '0.7rem', color: '#665c54' }}>MP4 · MOV · MKV · WEBM</div>
                  </div>
                </label>
              )}

              <input type="file" accept="video/*" id="video-upload" style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files[0];
                  if (!file) return;
                  setDubVideoFile(file);
                  setDubStep('idle');
                  setDubLocalBlobUrl(prev => { fileToMediaUrl(file, prev).then(urls => setDubLocalBlobUrl(urls)); return prev; });
                }} />

              <div style={{ marginTop: 4, padding: '3px 6px', background: 'rgba(255,255,255,0.015)', borderRadius: 4, border: '1px solid rgba(255,255,255,0.03)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: '0.62rem', color: '#504945', fontWeight: 600 }}>CAST</span>
                  <span style={{ fontSize: '0.62rem', color: '#504945' }}>Speaker 1:</span>
                  <span style={{ fontSize: '0.62rem', color: '#504945', padding: '1px 4px', background: 'rgba(255,255,255,0.02)', borderRadius: 2 }}>Default</span>
                </div>
              </div>
            </div>

            {/* RIGHT: Ghost settings + segment table */}
            <div className="studio-panel" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap', alignItems: 'flex-end', opacity: 0.4 }}>
                <div style={{ flex: 1, minWidth: 90 }}>
                  <div className="label-row"><Globe className="label-icon" size={9} /> Language</div>
                  <select className="input-base" disabled style={{ fontSize: '0.65rem' }}>
                    <option>Auto</option>
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: 80 }}>
                  <div className="label-row">ISO Code</div>
                  <select className="input-base" disabled style={{ fontSize: '0.65rem' }}>
                    <option>en — English</option>
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: 90 }}>
                  <div className="label-row"><UserSquare2 className="label-icon" size={9} /> Style</div>
                  <input className="input-base" disabled placeholder="e.g. female" style={{ fontSize: '0.65rem' }} />
                </div>
                <button disabled style={{ padding: '3px 8px', background: 'rgba(131,165,152,0.08)', border: '1px solid rgba(131,165,152,0.12)', color: '#504945', borderRadius: 4, fontSize: '0.62rem', display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
                  <Languages size={10} /> Translate All
                </button>
              </div>
              <div style={{ marginBottom: 4 }}>
                <div className="override-toggle" style={{ marginTop: 0, padding: '2px 6px', fontSize: '0.65rem', opacity: 0.3, cursor: 'default' }}>
                  <span><FileText size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} /> Transcript</span>
                  <ChevronDown size={10} />
                </div>
              </div>
              <div className="segment-table" style={{ flex: 1, maxHeight: 'none', overflowY: 'auto', minHeight: 0 }}>
                <div className="segment-header">
                  <span style={{ width: 55 }}>Time</span>
                  <span style={{ width: 50 }}>Spkr</span>
                  <span style={{ flex: 1 }}>Text</span>
                  <span style={{ width: 90 }}>Voice</span>
                  <span style={{ width: 40 }}></span>
                </div>
                {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                  <div key={i} className="segment-row" style={{ opacity: 0.15 + (0.04 * (8 - i)) }}>
                    <span className="segment-time" style={{ width: 55 }}>0:00.0–0:00.0</span>
                    <span style={{ width: 50, fontSize: '0.58rem', color: '#504945' }}>Speaker 1</span>
                    <div style={{ flex: 1, height: 18, background: 'rgba(255,255,255,0.03)', borderRadius: 3 }} />
                    <span style={{ width: 90, fontSize: '0.6rem', color: '#504945' }}>Default</span>
                    <div style={{ display: 'flex', gap: 1, width: 40 }}>
                      <span className="segment-del" style={{ opacity: 0.3 }}><Trash2 size={9} /></span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Ghost footer */}
          <div className="studio-panel" style={{ padding: '4px 8px', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="btn-primary" disabled style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem', opacity: 0.4 }}>
                <Play size={11} /> Generate Dub
              </button>
              <button className="btn-primary" disabled style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem', opacity: 0.4 }}>
                <Download size={11} /> MP4
              </button>
              <button className="btn-primary" disabled style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem', opacity: 0.4 }}>
                <Volume2 size={11} /> WAV
              </button>
              <button className="btn-primary" disabled style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem', opacity: 0.4 }}>
                <FileText size={11} /> SRT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── After transcription: side-by-side editor ── */}
      {dubJobId && (dubStep === 'editing' || dubStep === 'generating' || dubStep === 'done') && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="studio-panel" style={{ padding: '4px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <div className="label-row" style={{ marginBottom: 0, alignItems: 'center' }}>
              <button
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3px', marginRight: '6px', background: isSidebarCollapsed ? 'rgba(211,134,155,0.1)' : 'rgba(255,255,255,0.05)', border: `1px solid ${isSidebarCollapsed ? 'rgba(211,134,155,0.3)' : 'rgba(255,255,255,0.08)'}`, color: isSidebarCollapsed ? '#d3869b' : '#a89984', borderRadius: 4, cursor: 'pointer' }}
                title="Toggle Sidebar"
              >
                {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
              </button>
              <FileText className="label-icon" size={11} /> <span style={{ fontWeight: 600 }}>{dubFilename}</span>
              <span style={{ color: '#a89984', fontWeight: 400 }}> · {formatTime(dubDuration)} · {dubSegments.length} segs</span>
              {activeProjectName && <span style={{ color: '#b8bb26', marginLeft: 6 }}>— {activeProjectName}</span>}
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button onClick={saveProject} style={{ background: 'none', border: '1px solid rgba(184,187,38,0.3)', color: '#b8bb26', fontSize: '0.62rem', padding: '2px 6px', borderRadius: 3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
                <Save size={9} /> Save
              </button>
              <button onClick={resetDub} style={{ background: 'none', border: '1px solid rgba(251,73,52,0.25)', color: '#fb4934', fontSize: '0.62rem', padding: '2px 6px', borderRadius: 3, cursor: 'pointer' }}>Reset</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, flex: 1, minHeight: 0 }}>
            {/* LEFT: Waveform + Video */}
            <div className="studio-panel" style={{ marginBottom: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <WaveformTimeline
                audioSrc={`${API}/dub/audio/${dubJobId}`}
                videoSrc={`${API}/dub/media/${dubJobId}`}
                segments={dubSegments}
                onSegmentsChange={setDubSegments}
                disabled={dubStep === 'generating' || dubStep === 'stopping'}
                overlayContent={(dubStep === 'generating' || dubStep === 'stopping') ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {dubStep === 'stopping' ? <Loader className="spinner" size={14} color="#a89984" /> : <Sparkles className="spinner" size={14} color="#d3869b" />}
                      <span style={{ color: dubStep === 'stopping' ? '#a89984' : '#ebdbb2', fontWeight: 500, fontSize: '0.72rem' }}>
                        {dubStep === 'stopping' ? 'Stopping…' : `Dubbing ${dubProgress.current}/${dubProgress.total}…`}
                      </span>
                    </div>
                    {dubStep === 'generating' && (
                      <>
                        <div className="progress-container" style={{ width: '80%', maxWidth: 240 }}>
                          <div className="progress-fill" style={{ width: `${dubProgress.total ? (dubProgress.current / dubProgress.total) * 100 : 0}%` }} />
                        </div>
                        {dubProgress.text && <span style={{ fontSize: '0.65rem', color: '#a89984' }}>{dubProgress.text}</span>}
                      </>
                    )}
                  </div>
                ) : null}
              />

              {/* Cast Diarization */}
              {dubSegments.some(s => s.speaker_id) && (
                <div style={{ marginTop: 4, padding: '3px 6px', background: 'rgba(255,255,255,0.02)', borderRadius: 4, border: '1px solid rgba(255,255,255,0.04)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.62rem', color: '#a89984', fontWeight: 600 }} title="Assign a voice profile to each speaker detected in the video">SPEAKER VOICES</span>
                    {[...new Set(dubSegments.map(s => s.speaker_id).filter(Boolean))].map(spk => (
                      <div key={spk} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ fontSize: '0.62rem', color: '#ebdbb2' }}>{spk}:</span>
                        <select className="input-base" style={{ width: 100, padding: '1px 4px', fontSize: '0.62rem' }}
                          value={dubSegments.find(s => s.speaker_id === spk)?.profile_id || ''}
                          onChange={e => {
                            const val = e.target.value;
                            setDubSegments(dubSegments.map(s => s.speaker_id === spk ? { ...s, profile_id: val } : s));
                          }}>
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
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT: Settings + Segment Table */}
            <div className="studio-panel" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 90 }}>
                  <div className="label-row"><Globe className="label-icon" size={9} /> Language</div>
                  <SearchableSelect
                    size="sm"
                    value={dubLang}
                    options={ALL_LANGUAGES}
                    popular={POPULAR_LANGS}
                    recentsKey="omnivoice.recents.dubLang"
                    onChange={(lang) => {
                      setDubLang(lang);
                      const match = LANG_CODES.find(lc => lc.label.toLowerCase() === lang.toLowerCase());
                      if (match) setDubLangCode(match.code);
                    }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 80 }}>
                  <div className="label-row">ISO Code</div>
                  <SearchableSelect
                    size="sm"
                    value={dubLangCode}
                    options={LANG_CODES.map(lc => ({ value: lc.code, label: `${lc.code} — ${lc.label}` }))}
                    popular={POPULAR_ISO}
                    recentsKey="omnivoice.recents.dubIso"
                    onChange={setDubLangCode}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 90 }}>
                  <div className="label-row"><UserSquare2 className="label-icon" size={9} /> Style</div>
                  <input className="input-base" placeholder="e.g. female" value={dubInstruct} onChange={e => setDubInstruct(e.target.value)} style={{ fontSize: '0.65rem' }} />
                </div>
                <div style={{ flex: 1, minWidth: 90 }}>
                  <div className="label-row">Engine</div>
                  <select className="input-base" value={translateProvider} onChange={e => setTranslateProvider(e.target.value)} style={{ fontSize: '0.65rem', padding: '5px 8px' }}>
                    {[{ id: 'argos', name: 'Argos (Fast Local)' }, { id: 'nllb', name: 'NLLB (Heavy Local)' }, { id: 'google', name: 'Google (Online)' }, { id: 'openai', name: 'OpenAI (LLM)' }].map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <button onClick={handleTranslateAll} disabled={isTranslating || !dubSegments.length}
                  style={{ padding: '3px 8px', background: 'rgba(131,165,152,0.12)', border: '1px solid rgba(131,165,152,0.25)', color: '#83a598', borderRadius: 4, cursor: 'pointer', fontSize: '0.62rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
                  {isTranslating ? <Loader className="spinner" size={9} /> : <Languages size={10} />}
                  {isTranslating ? 'Translating…' : 'Translate All'}
                </button>
                <button
                  onClick={() => editSegments(dubSegments.map(s => ({ ...s, text: s.text_original || s.text, translate_error: undefined })))}
                  disabled={!dubSegments.some(s => s.text_original && s.text_original !== s.text)}
                  title="Restore all segments to the original transcribed text"
                  style={{ padding: '3px 8px', background: 'rgba(131,165,152,0.08)', border: '1px solid rgba(131,165,152,0.2)', color: '#83a598', borderRadius: 4, cursor: 'pointer', fontSize: '0.62rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
                  ↺ Restore
                </button>
                <button onClick={handleCleanupSegments} disabled={!dubSegments.length || !dubJobId}
                  title="Merge tiny fragments and adjacent short segments"
                  style={{ padding: '3px 8px', background: 'rgba(250,189,47,0.10)', border: '1px solid rgba(250,189,47,0.22)', color: '#fabd2f', borderRadius: 4, cursor: 'pointer', fontSize: '0.62rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
                  <Wand2 size={10} /> Clean Up
                </button>
              </div>

              {dubTranscript && (
                <div style={{ marginBottom: 4 }}>
                  <div className="override-toggle" onClick={() => setShowTranscript(!showTranscript)} style={{ marginTop: 0, padding: '2px 6px', fontSize: '0.65rem' }}>
                    <span><FileText size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} /> Transcript</span>
                    {showTranscript ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </div>
                  {showTranscript && (
                    <div style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.04)', borderTop: 'none', borderRadius: '0 0 4px 4px', padding: 6, fontSize: '0.65rem', color: 'var(--text-secondary)', lineHeight: 1.5, maxHeight: 80, overflowY: 'auto' }}>
                      {dubTranscript}
                    </div>
                  )}
                </div>
              )}

              {dubSegments.length > 0 && profiles.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, padding: '3px 6px', background: 'rgba(142,192,124,0.06)', border: '1px solid rgba(142,192,124,0.12)', borderRadius: 4 }}>
                  <User size={10} color="#8ec07c" />
                  <span style={{ fontSize: '0.62rem', color: '#8ec07c', fontWeight: 600, whiteSpace: 'nowrap' }}>Apply Voice to All:</span>
                  <select className="input-base" style={{ flex: 1, fontSize: '0.62rem', padding: '2px 4px' }}
                    value=""
                    onChange={e => {
                      const val = e.target.value;
                      if (val === '__reset__') {
                        setDubSegments(dubSegments.map(s => ({ ...s, profile_id: '' })));
                      } else if (val) {
                        setDubSegments(dubSegments.map(s => ({ ...s, profile_id: val })));
                      }
                    }}>
                    <option value="">— Select profile —</option>
                    <option value="__reset__">⊘ Default (reset all)</option>
                    {profiles.filter(p => !p.instruct).length > 0 && (
                      <optgroup label="Clone Profiles">
                        {profiles.filter(p => !p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                    {profiles.filter(p => !!p.instruct).length > 0 && (
                      <optgroup label="Designed Voices">
                        {profiles.filter(p => !!p.instruct).map(p => <option key={p.id} value={p.id}>{p.name}{p.is_locked ? ' 🔒' : ''}</option>)}
                      </optgroup>
                    )}
                  </select>
                </div>
              )}

              {selectedSegIds.size > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', background: 'rgba(211,134,155,0.08)', border: '1px solid rgba(211,134,155,0.25)', borderRadius: 4, marginBottom: 4 }}>
                  <span style={{ fontSize: '0.62rem', color: '#d3869b', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {selectedSegIds.size} selected
                  </span>
                  <select className="input-base" style={{ fontSize: '0.62rem', padding: '2px 4px', minWidth: 100 }}
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
                  <select className="input-base" style={{ fontSize: '0.62rem', padding: '2px 4px', width: 90 }}
                    value="" onChange={(e) => { if (e.target.value === '__def__') bulkApplyToSelected({ target_lang: null }); else if (e.target.value) bulkApplyToSelected({ target_lang: e.target.value }); }}>
                    <option value="">Set lang…</option>
                    <option value="__def__">(Default)</option>
                    {LANG_CODES.map(lc => <option key={lc.code} value={lc.code}>{lc.code.toUpperCase()}</option>)}
                  </select>
                  <button onClick={bulkDeleteSelected}
                    style={{ padding: '2px 8px', background: 'rgba(251,73,52,0.1)', border: '1px solid rgba(251,73,52,0.3)', color: '#fb4934', borderRadius: 4, cursor: 'pointer', fontSize: '0.62rem' }}>
                    Delete
                  </button>
                  <button onClick={clearSegSelection}
                    style={{ marginLeft: 'auto', padding: '2px 8px', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: '#a89984', borderRadius: 4, cursor: 'pointer', fontSize: '0.62rem' }}>
                    Clear
                  </button>
                </div>
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
                  onSplit={segmentSplit}
                  onMerge={segmentMerge}
                />
              </Suspense>
            </div>
          </div>

          {/* Actions footer */}
          <div className="studio-panel" style={{ padding: '4px 8px', flexShrink: 0 }}>
            {dubStep === 'done' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4, padding: '3px 6px', background: 'rgba(142,192,124,0.08)', border: '1px solid rgba(142,192,124,0.2)', borderRadius: 4 }}>
                <Check size={10} color="#8ec07c" />
                <span style={{ color: '#8ec07c', fontSize: '0.65rem' }}>Done! Tracks: {dubTracks.join(', ')}</span>
              </div>
            )}
            {dubError && (
              <div style={{ marginBottom: 4, padding: '3px 6px', background: 'rgba(251,73,52,0.08)', border: '1px solid rgba(251,73,52,0.2)', borderRadius: 4 }}>
                <span style={{ color: '#fb4934', fontSize: '0.62rem' }}>{dubError}</span>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, padding: '0 4px', fontSize: '0.65rem', color: '#a89984', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, color: '#ebdbb2' }}>Output Options:</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} style={{ cursor: 'pointer' }} /> Mix BG Audio
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                Default Track:
                <select className="input-base" value={defaultTrack} onChange={e => setDefaultTrack(e.target.value)} style={{ fontSize: '0.6rem', padding: '2px 4px', width: '120px' }}>
                  <option value="original">Original</option>
                  {dubLangCode && <option value={dubLangCode}>{dubLangCode} (Selected Dub)</option>}
                  {dubTracks.filter(t => t !== dubLangCode).map(t => (
                    <option key={t} value={t}>{t} (Dub)</option>
                  ))}
                </select>
              </label>
            </div>
            {dubTracks.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '4px 6px', fontSize: '0.62rem', color: '#a89984', background: 'rgba(0,0,0,0.15)', borderRadius: 4, border: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: '#ebdbb2', fontSize: '0.62rem' }}>Export Tracks:</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', color: exportTracks['original'] ? '#ebdbb2' : '#665c54' }}>
                  <input type="checkbox" checked={exportTracks['original'] !== false} onChange={e => setExportTracks(prev => ({ ...prev, original: e.target.checked }))} style={{ cursor: 'pointer', accentColor: '#a89984' }} />
                  <span>Original</span>
                </label>
                {dubTracks.map(t => (
                  <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', color: exportTracks[t] !== false ? '#8ec07c' : '#665c54' }}>
                    <input type="checkbox" checked={exportTracks[t] !== false} onChange={e => setExportTracks(prev => ({ ...prev, [t]: e.target.checked }))} style={{ cursor: 'pointer', accentColor: '#8ec07c' }} />
                    <span style={{ textTransform: 'uppercase' }}>{t}</span>
                  </label>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 4 }}>
              {dubStep === 'stopping' ? (
                <button className="btn-primary" disabled style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem', background: 'linear-gradient(135deg,#504945,#3c3836)', opacity: 0.8 }}>
                  <Loader className="spinner" size={9} /> Stopping…
                </button>
              ) : dubStep === 'generating' ? (
                <button className="btn-primary" style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem', background: 'linear-gradient(135deg,#fb4934,#cc241d)' }}
                  onClick={handleDubStop}>
                  <Square size={9} /> Stop ({dubProgress.current}/{dubProgress.total})
                </button>
              ) : (
                <button className="btn-primary" style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem' }} onClick={handleDubGenerate} disabled={!dubSegments.length}>
                  <Play size={11} /> Generate Dub
                </button>
              )}
              <button className="btn-primary" style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem', background: dubStep === 'done' ? 'linear-gradient(135deg,#8ec07c,#689d6a)' : undefined }}
                onClick={handleDubDownload} disabled={dubStep !== 'done'}>
                <Download size={11} /> MP4
              </button>
              <button className="btn-primary" style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem', background: dubStep === 'done' ? 'linear-gradient(135deg,#83a598,#458588)' : undefined }}
                onClick={handleDubAudioDownload} disabled={dubStep !== 'done'}>
                <Volume2 size={11} /> WAV
              </button>
              <button className="btn-primary" style={{ marginTop: 0, flex: 1, padding: '4px 8px', fontSize: '0.7rem', background: dubSegments.length ? 'linear-gradient(135deg,#d3869b,#b16286)' : undefined }}
                onClick={() => triggerDownload(`${API}/dub/srt/${dubJobId}/subtitles.srt`, 'subtitles.srt')} disabled={!dubSegments.length}>
                <FileText size={11} /> SRT
              </button>
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              <button className="btn-primary" style={{ marginTop: 0, flex: 1, padding: '4px 7px', fontSize: '0.62rem', background: dubSegments.length ? 'linear-gradient(135deg,#b8bb26,#98971a)' : undefined }}
                onClick={() => triggerDownload(`${API}/dub/vtt/${dubJobId}/subtitles.vtt`, 'subtitles.vtt')} disabled={!dubSegments.length}>
                <FileText size={10} /> VTT
              </button>
              <button className="btn-primary" style={{ marginTop: 0, flex: 1, padding: '4px 7px', fontSize: '0.62rem', background: dubStep === 'done' ? 'linear-gradient(135deg,#fabd2f,#d79921)' : undefined }}
                onClick={() => triggerDownload(`${API}/dub/download-mp3/${dubJobId}/audio.mp3?preserve_bg=${preserveBg}`, 'dubbed_audio.mp3')} disabled={dubStep !== 'done'}>
                <Music size={10} /> MP3
              </button>
              <button className="btn-primary" style={{ marginTop: 0, flex: 1, padding: '4px 7px', fontSize: '0.62rem', background: dubStep === 'done' ? 'linear-gradient(135deg,#fe8019,#d65d0e)' : undefined }}
                onClick={() => triggerDownload(`${API}/dub/export-segments/${dubJobId}`, 'segments.zip')} disabled={dubStep !== 'done'}>
                <Package size={10} /> Clips
              </button>
              <button className="btn-primary" style={{ marginTop: 0, flex: 1, padding: '4px 7px', fontSize: '0.62rem', background: dubStep === 'done' ? 'linear-gradient(135deg,#d3869b,#b16286)' : undefined }}
                onClick={() => triggerDownload(`${API}/dub/export-stems/${dubJobId}`, 'stems.zip')} disabled={dubStep !== 'done'}>
                <Layers size={10} /> Stems
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
