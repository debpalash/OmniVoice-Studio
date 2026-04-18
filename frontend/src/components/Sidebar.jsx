import React from 'react';
import {
  FolderOpen, History, DownloadCloud, Film, Save, ChevronDown, ChevronUp,
  Fingerprint, Wand2, Lock, Unlock, Trash2, Check, Clock, Play, Loader,
  Download as DownloadIcon, Volume2,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { API } from '../api/client';
import { clearDubHistory } from '../api/dub';
import { clearHistory as clearGenHistory } from '../api/generate';

function timeAgo(ms) {
  const diff = Date.now() - ms;
  if (!isFinite(diff) || diff < 0) return '';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function Sidebar(props) {
  const {
    mode,
    availableTabs = ['projects', 'history', 'downloads'],
    isSidebarCollapsed,
    isSidebarProjectsCollapsed, setIsSidebarProjectsCollapsed,
    sidebarTab, setSidebarTab,
    studioProjects, profiles, history, dubHistory, exportHistory,
    dubStep, dubVideoFile,
    selectedProfile, activeProjectId,
    previewLoading,
    saveProject, loadProject, deleteProject,
    handleSelectProfile, handleDeleteProfile,
    handleUnlockProfile, handleLockProfile, handlePreviewVoice,
    restoreHistory, restoreDubHistory,
    handleSaveHistoryAsProfile,
    handleNativeExport, revealInFolder,
    deleteHistory,
    loadHistory, loadDubHistory,
  } = props;

  const handleClearHistory = async () => {
    if (!confirm(`Clear all ${history.length + dubHistory.length} history items? This cannot be undone.`)) return;
    await clearGenHistory();
    await clearDubHistory();
    await loadHistory();
    await loadDubHistory();
    toast.success('History cleared');
  };

  return (
    <div className="glass-panel history-panel" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Tab bar — only tabs relevant to the current view */}
      <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--glass-border)', background: 'rgba(0,0,0,0.15)', flexShrink: 0, flexDirection: isSidebarCollapsed ? 'column' : 'row', justifyContent: 'center' }}>
        {availableTabs.includes('projects') && (
          <button
            onClick={() => setSidebarTab('projects')}
            style={{
              flex: 1, height: '26px', maxWidth: isSidebarCollapsed ? '100%' : '60px', cursor: 'pointer', border: '1px solid',
              borderColor: sidebarTab === 'projects' ? 'rgba(184,187,38,0.35)' : 'rgba(255,255,255,0.06)',
              background: sidebarTab === 'projects' ? 'rgba(184,187,38,0.15)' : 'rgba(0,0,0,0.2)',
              color: sidebarTab === 'projects' ? '#b8bb26' : '#a89984',
              borderRadius: 6, transition: 'all 0.2s ease', display: 'flex', justifyContent: 'center', alignItems: 'center',
            }}
            title={`Projects (${mode === 'dub' ? studioProjects.length : (mode === 'clone' ? profiles.filter(p => !p.instruct).length : profiles.filter(p => !!p.instruct).length)})`}
          >
            <FolderOpen size={13} />
          </button>
        )}
        {availableTabs.includes('history') && (
          <button
            onClick={() => setSidebarTab('history')}
            style={{
              flex: 1, height: '26px', maxWidth: isSidebarCollapsed ? '100%' : '60px', cursor: 'pointer', border: '1px solid',
              borderColor: sidebarTab === 'history' ? 'rgba(211,134,155,0.35)' : 'rgba(255,255,255,0.06)',
              background: sidebarTab === 'history' ? 'rgba(211,134,155,0.15)' : 'rgba(0,0,0,0.2)',
              color: sidebarTab === 'history' ? '#d3869b' : '#a89984',
              borderRadius: 6, transition: 'all 0.2s ease', display: 'flex', justifyContent: 'center', alignItems: 'center',
            }}
            title={`History (${history.length + dubHistory.length})`}
          >
            <History size={13} />
          </button>
        )}
        {availableTabs.includes('downloads') && (
          <button
            onClick={() => setSidebarTab('downloads')}
            style={{
              flex: 1, height: '26px', maxWidth: isSidebarCollapsed ? '100%' : '60px', cursor: 'pointer', border: '1px solid',
              borderColor: sidebarTab === 'downloads' ? 'rgba(142,192,124,0.35)' : 'rgba(255,255,255,0.06)',
              background: sidebarTab === 'downloads' ? 'rgba(142,192,124,0.15)' : 'rgba(0,0,0,0.2)',
              color: sidebarTab === 'downloads' ? '#8ec07c' : '#a89984',
              borderRadius: 6, transition: 'all 0.2s ease', display: 'flex', justifyContent: 'center', alignItems: 'center',
            }}
            title={`Exports (${exportHistory.length})`}
          >
            <DownloadCloud size={13} />
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: isSidebarCollapsed ? '8px 4px' : '8px', display: 'flex', flexDirection: 'column', alignItems: isSidebarCollapsed ? 'center' : 'stretch', gap: isSidebarCollapsed ? 8 : 0 }}>
        {/* ── PROJECTS TAB ── */}
        {sidebarTab === 'projects' && (
          <>
            {mode === 'dub' && (dubStep !== 'idle' || dubVideoFile) && !isSidebarCollapsed && (
              <button onClick={saveProject} style={{
                width: '100%', marginBottom: 10, padding: '7px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                background: activeProjectId ? 'rgba(184,187,38,0.15)' : 'rgba(131,165,152,0.15)',
                border: `1px solid ${activeProjectId ? 'rgba(184,187,38,0.35)' : 'rgba(131,165,152,0.3)'}`,
                borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 500,
                color: activeProjectId ? '#b8bb26' : '#83a598',
              }}>
                <Save size={13} /> {activeProjectId ? 'Save Dub Project' : 'Save as New Dub Project'}
              </button>
            )}
            {mode === 'dub' && (dubStep !== 'idle' || dubVideoFile) && isSidebarCollapsed && (
              <button onClick={saveProject} title={activeProjectId ? 'Save Dub Project' : 'Save as New Dub Project'} style={{
                width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8, flexShrink: 0,
                background: activeProjectId ? 'rgba(184,187,38,0.15)' : 'rgba(131,165,152,0.15)',
                border: `1px solid ${activeProjectId ? 'rgba(184,187,38,0.35)' : 'rgba(131,165,152,0.3)'}`,
                borderRadius: 6, cursor: 'pointer', color: activeProjectId ? '#b8bb26' : '#83a598',
              }}>
                <Save size={14} />
              </button>
            )}

            {!isSidebarCollapsed && (
              <div
                style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '2px 0' }}
                onClick={() => setIsSidebarProjectsCollapsed(!isSidebarProjectsCollapsed)}
              >
                <span>{mode === 'dub' ? 'Studio Projects (Dubbing)' : (mode === 'clone' ? 'Voice Clones (Audio)' : 'Designed Voices (Synthetic)')}</span>
                {isSidebarProjectsCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
              </div>
            )}

            {!isSidebarProjectsCollapsed && !isSidebarCollapsed && (
              <>
                {mode === 'dub' && (
                  <>
                    {studioProjects.length === 0 ? (
                      <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '24px 12px' }}>
                        <Film size={28} style={{ opacity: 0.3, marginBottom: 8 }} />
                        <p style={{ fontSize: '0.78rem', margin: 0, marginBottom: 4 }}>No saved dub projects</p>
                        <p style={{ fontSize: '0.62rem', margin: 0, opacity: 0.6 }}>Upload a video and click Save to keep your work.</p>
                      </div>
                    ) : (
                      studioProjects.map(proj => (
                        <div key={proj.id}
                          className={`history-item ${activeProjectId === proj.id ? 'project-active' : ''}`}
                          style={{ '--row-accent': '#83a598' }}
                          onClick={() => loadProject(proj.id)}
                        >
                          <div className="history-row-head">
                            <span className="history-kind" style={{ color: '#83a598', borderColor: 'rgba(131,165,152,0.25)' }}>
                              <Film size={9} /> Dub
                            </span>
                            <span className="history-meta" title={new Date(proj.updated_at * 1000).toLocaleString()}>
                              {timeAgo(proj.updated_at * 1000)}
                            </span>
                          </div>
                          <div className="history-title">{proj.name}</div>
                          <div className="history-subtitle">
                            {proj.duration ? `${Math.round(proj.duration)}s` : 'audio'}
                            {proj.video_path ? ` · ${proj.video_path.split(/[\\/]/).pop()}` : ''}
                          </div>
                          <div className="history-actions">
                            <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); loadProject(proj.id); }}>
                              <FolderOpen size={10} /> Open
                            </button>
                            <button className="history-action-btn danger history-action-icon" onClick={(e) => { e.stopPropagation(); deleteProject(proj.id); }} title="Delete">
                              <Trash2 size={10} />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </>
                )}

                {(mode === 'clone' || mode === 'design') && (
                  <>
                    {(mode === 'clone' ? profiles.filter(p => !p.instruct) : profiles.filter(p => !!p.instruct)).length === 0 ? (
                      <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '24px 12px' }}>
                        {mode === 'clone' ? <Fingerprint size={28} style={{ opacity: 0.3, marginBottom: 8 }} /> : <Wand2 size={28} style={{ opacity: 0.3, marginBottom: 8 }} />}
                        <p style={{ fontSize: '0.78rem', margin: 0, marginBottom: 4 }}>No {mode === 'clone' ? 'voice clones' : 'designed voices'} yet</p>
                        <p style={{ fontSize: '0.62rem', margin: 0, opacity: 0.6 }}>{mode === 'clone' ? 'Record or upload audio, then click Save as Voice Profile.' : 'Generate a voice and save it from History.'}</p>
                      </div>
                    ) : (
                      (mode === 'clone' ? profiles.filter(p => !p.instruct) : profiles.filter(p => !!p.instruct)).map(proj => {
                        const accent = proj.is_locked ? '#b8bb26' : (mode === 'clone' ? '#d3869b' : '#8ec07c');
                        const KindIcon = proj.is_locked ? Lock : (mode === 'clone' ? Fingerprint : Wand2);
                        return (
                          <div key={proj.id}
                            className={`history-item ${selectedProfile === proj.id ? 'project-active' : ''}`}
                            style={{ '--row-accent': accent }}
                            onClick={() => handleSelectProfile(proj)}
                          >
                            <div className="history-row-head">
                              <span className="history-kind" style={{ color: accent, borderColor: `${accent}40` }}>
                                <KindIcon size={9} /> {proj.is_locked ? 'Locked' : (mode === 'clone' ? 'Clone' : 'Design')}
                              </span>
                              {proj.is_locked ? <span className="history-meta" style={{ color: '#b8bb26', fontStyle: 'italic' }}>consistent</span> : null}
                            </div>
                            <div className="history-title">{proj.name}</div>
                            {proj.instruct ? <div className="history-subtitle" style={{ fontStyle: 'italic' }}>{proj.instruct}</div> : null}

                            <div className="history-actions">
                              <button className="history-action-btn history-action-icon" onClick={(e) => { e.stopPropagation(); handlePreviewVoice(proj, e); }} title="Preview">
                                {previewLoading === proj.id ? <Loader className="spinner" size={10} /> : <Play size={10} />}
                              </button>
                              <button className="history-action-btn" onClick={(e) => { e.stopPropagation(); handleSelectProfile(proj); }}>
                                <Check size={10} /> Select
                              </button>
                              {proj.is_locked ? (
                                <button className="history-action-btn accent history-action-icon" onClick={(e) => { e.stopPropagation(); handleUnlockProfile(proj.id); }} title="Unlock">
                                  <Unlock size={10} />
                                </button>
                              ) : null}
                              <button className="history-action-btn danger history-action-icon" onClick={(e) => { e.stopPropagation(); handleDeleteProfile(proj.id); }} title="Delete">
                                <Trash2 size={10} />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </>
                )}
              </>
            )}

            {isSidebarCollapsed && mode === 'dub' && studioProjects.map(proj => (
              <div key={proj.id} title={`Load: ${proj.name}`} onClick={() => loadProject(proj.id)}
                style={{
                  width: '34px', height: '34px', flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center',
                  borderRadius: '12px 16px 10px 18px / 14px 10px 16px 12px',
                  cursor: 'pointer',
                  background: activeProjectId === proj.id
                    ? 'linear-gradient(140deg, rgba(243,165,182,0.25), rgba(250,189,47,0.15))'
                    : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${activeProjectId === proj.id ? 'rgba(243,165,182,0.4)' : 'rgba(255,255,255,0.05)'}`,
                  color: activeProjectId === proj.id ? '#fff9ef' : '#a89984',
                  transform: `rotate(${(parseInt((proj.id || '0').slice(-1), 36) % 5 - 2) * 0.8}deg)`,
                  transition: 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1), background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'rotate(0deg) scale(1.08)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = `rotate(${(parseInt((proj.id || '0').slice(-1), 36) % 5 - 2) * 0.8}deg)`; }}
              >
                <Film size={14} />
              </div>
            ))}

            {isSidebarCollapsed && (mode === 'clone' || mode === 'design') && (mode === 'clone' ? profiles.filter(p => !p.instruct) : profiles.filter(p => !!p.instruct)).map(proj => (
              <div key={proj.id} title={`Select: ${proj.name}`} onClick={() => handleSelectProfile(proj)}
                style={{
                  width: '34px', height: '34px', flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center',
                  borderRadius: '12px 16px 10px 18px / 14px 10px 16px 12px',
                  cursor: 'pointer', position: 'relative',
                  background: selectedProfile === proj.id
                    ? 'linear-gradient(140deg, rgba(243,165,182,0.25), rgba(250,189,47,0.15))'
                    : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${selectedProfile === proj.id ? 'rgba(243,165,182,0.4)' : 'rgba(255,255,255,0.05)'}`,
                  color: selectedProfile === proj.id ? '#fff9ef' : '#a89984',
                  transform: `rotate(${(parseInt((proj.id || '0').slice(-1), 36) % 5 - 2) * 0.8}deg)`,
                  transition: 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1), background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'rotate(0deg) scale(1.08)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = `rotate(${(parseInt((proj.id || '0').slice(-1), 36) % 5 - 2) * 0.8}deg)`; }}
              >
                {mode === 'clone' ? <Fingerprint size={14} /> : <Wand2 size={14} />}
                {proj.is_locked ? <Lock size={8} style={{ position: 'absolute', bottom: 2, right: 2, color: '#b8bb26' }} /> : null}
              </div>
            ))}
          </>
        )}

        {/* ── HISTORY TAB ── */}
        {sidebarTab === 'history' && (
          <>
            {!isSidebarCollapsed && <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginBottom: 8 }}>Generation history · Stored in SQLite</div>}
            {(history.length + dubHistory.length) === 0 ? (
              <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '24px 12px' }}>
                <History size={28} style={{ opacity: 0.3, marginBottom: 8 }} />
                <p style={{ fontSize: '0.78rem', margin: 0, marginBottom: 4 }}>No generation history</p>
                <p style={{ fontSize: '0.62rem', margin: 0, opacity: 0.6 }}>Synthesize audio or dub a video — results will appear here.</p>
              </div>
            ) : (
              <>
                {!isSidebarCollapsed && dubHistory.map(item => (
                  <div key={`dub-${item.id}`} className="history-item"
                    style={{ '--row-accent': '#83a598' }}
                    onClick={() => restoreDubHistory(item)}
                  >
                    <div className="history-row-head">
                      <span className="history-kind" style={{ color: '#83a598', borderColor: 'rgba(131,165,152,0.25)' }}>
                        <Film size={9} /> Dub
                      </span>
                      <span className="history-meta">{item.segments_count} segs · {Math.round(item.duration || 0)}s</span>
                    </div>
                    <div className="history-title">{item.filename}</div>
                    <div className="history-subtitle">
                      {[item.language, item.language_code].filter(v => v && v !== 'und' && v !== 'Auto').join(' · ') || 'Auto'}
                    </div>
                    <div className="history-actions">
                      <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); restoreDubHistory(item); }}>
                        <FolderOpen size={10} /> Open
                      </button>
                      <button className="history-action-btn danger history-action-icon" onClick={(e) => { e.stopPropagation(); deleteHistory(item.id, 'dub'); }} title="Delete">
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                ))}

                {!isSidebarCollapsed && history.map(item => {
                  const accent = item.mode === 'clone' ? '#d3869b' : '#b8bb26';
                  const KindIcon = item.mode === 'clone' ? Fingerprint : Wand2;
                  return (
                    <div key={item.id} className="history-item" style={{ '--row-accent': accent }}>
                      <div className="history-row-head">
                        <span className="history-kind" style={{ color: accent, borderColor: `${accent}40` }}>
                          <KindIcon size={9} /> {item.mode || 'synth'}
                        </span>
                        <span className="history-meta">
                          {item.language && item.language !== 'Auto' ? `${item.language} · ` : ''}
                          {item.generation_time ? `${item.generation_time}s` : ''}
                        </span>
                      </div>
                      <div className="history-title" title={item.text} style={{ whiteSpace: 'normal', fontWeight: 500, fontSize: '0.74rem', lineHeight: 1.3, maxHeight: '3em', overflow: 'hidden' }}>
                        {item.text}
                      </div>
                      {item.seed != null && String(item.seed) !== ''
                        ? <div className="history-subtitle" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.58rem', color: '#6b6657' }}>seed {item.seed}</div>
                        : null}
                      {item.audio_path ? (
                        <audio controls src={`${API}/audio/${item.audio_path}`} style={{ height: 24, marginTop: 4, width: '100%', borderRadius: 999 }} />
                      ) : null}
                      {item.audio_path ? (
                        <div className="history-actions">
                          <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); handleSaveHistoryAsProfile(item); }}>
                            <Save size={10} /> Save
                          </button>
                          {item.profile_id ? (
                            <button className="history-action-btn accent history-action-icon"
                              onClick={(e) => { e.stopPropagation(); handleLockProfile(item.profile_id, item.id, item.seed); }}
                              title="Lock voice identity">
                              <Lock size={10} />
                            </button>
                          ) : null}
                          <button className="history-action-btn history-action-icon"
                            onClick={(e) => handleNativeExport(e, item.audio_path, item.audio_path, item.mode)}
                            title="Export">
                            <DownloadIcon size={10} />
                          </button>
                          <button className="history-action-btn history-action-icon"
                            onClick={(e) => { e.stopPropagation(); restoreHistory(item); }}
                            title="Load config">
                            <FolderOpen size={10} />
                          </button>
                          <button className="history-action-btn danger history-action-icon"
                            onClick={(e) => { e.stopPropagation(); deleteHistory(item.id, 'synth'); }}
                            title="Delete">
                            <Trash2 size={10} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </>
            )}

            {isSidebarCollapsed && dubHistory.map(item => (
              <div key={`dub-${item.id}`} title={`Dub: ${item.filename}`} onClick={() => restoreDubHistory(item)}
                style={{ width: '32px', height: '32px', flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', borderRadius: '6px', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', border: '1px solid transparent', color: '#83a598' }}>
                <Film size={14} />
              </div>
            ))}

            {isSidebarCollapsed && history.map(item => (
              <div key={item.id} title={`${item.mode || 'history'}: ${item.text}`} onClick={() => restoreHistory(item)}
                style={{ width: '32px', height: '32px', flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', borderRadius: '6px', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', border: '1px solid transparent', color: item.mode === 'clone' ? '#d3869b' : '#b8bb26' }}>
                {item.mode === 'clone' ? <Fingerprint size={14} /> : <Wand2 size={14} />}
              </div>
            ))}

            {(history.length + dubHistory.length) > 0 && !isSidebarCollapsed && (
              <button onClick={handleClearHistory}
                style={{ width: '100%', marginTop: 10, padding: 5, background: 'transparent', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, color: '#665c54', cursor: 'pointer', fontSize: '0.65rem' }}>
                <Trash2 size={10} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Clear History
              </button>
            )}
          </>
        )}

        {/* ── DOWNLOADS TAB ── */}
        {sidebarTab === 'downloads' && (
          <>
            {!isSidebarCollapsed && <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginBottom: 8 }}>Recent Exports</div>}
            {exportHistory.length === 0 ? (
              <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '24px 12px' }}>
                <DownloadCloud size={28} style={{ opacity: 0.3, marginBottom: 8 }} />
                <p style={{ fontSize: '0.78rem', margin: 0, marginBottom: 4 }}>No downloaded outputs</p>
                <p style={{ fontSize: '0.62rem', margin: 0, opacity: 0.6 }}>Export a file via Tauri to see it tracked here.</p>
              </div>
            ) : (
              <>
                {!isSidebarCollapsed && exportHistory.map(item => {
                  const pathParts = item.destination_path.split(/[\\/]/);
                  const parentFolder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : '…';
                  const accent = item.mode === 'audio' ? '#83a598' : '#8ec07c';
                  const KindIcon = item.mode === 'audio' ? Volume2 : Film;
                  return (
                    <div key={item.id} className="history-item"
                      style={{ '--row-accent': accent }}
                      onClick={() => revealInFolder(item.destination_path)}
                    >
                      <div className="history-row-head">
                        <span className="history-kind" style={{ color: accent, borderColor: `${accent}40` }}>
                          <KindIcon size={9} /> {item.mode}
                        </span>
                        <span className="history-meta">{timeAgo(item.created_at * 1000)}</span>
                      </div>
                      <div className="history-title">{item.filename}</div>
                      <div className="history-subtitle">in {parentFolder}</div>
                      <div className="history-actions">
                        <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); revealInFolder(item.destination_path); }}>
                          <FolderOpen size={10} /> Show in folder
                        </button>
                      </div>
                    </div>
                  );
                })}

                {isSidebarCollapsed && exportHistory.map(item => (
                  <div key={item.id} title={`Exported: ${item.filename}\nClick to open folder`}
                    onClick={() => revealInFolder(item.destination_path)}
                    style={{ width: '32px', height: '32px', flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', borderRadius: '6px', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', border: '1px solid transparent', color: item.mode === 'audio' ? '#83a598' : '#8ec07c' }}
                  >
                    <FolderOpen size={14} />
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
