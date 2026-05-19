import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderOpen, History, DownloadCloud, Film, Save, ChevronDown, ChevronUp,
  Fingerprint, Wand2, Lock, Unlock, Trash2, Check, Clock, Play, Loader,
  Download as DownloadIcon, Volume2, Search, X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { API } from '../api/client';
import { clearDubHistory } from '../api/dub';
import { clearHistory as clearGenHistory } from '../api/generate';
import { Button } from '../ui';
import { useAppStore } from '../store';
import './Sidebar.css';
import { askConfirm } from '../utils/dialog';

const SIDEBAR_TABS = [
  { id: 'projects',  icon: FolderOpen,   accent: '#b8bb26' },
  { id: 'history',   icon: History,      accent: '#d3869b' },
  { id: 'downloads', icon: DownloadCloud, accent: '#8ec07c' },
];

export default function Sidebar(props) {
  const { t } = useTranslation();

  const {
    availableTabs = ['projects', 'history', 'downloads'],
    isSidebarProjectsCollapsed, setIsSidebarProjectsCollapsed,
    sidebarTab, setSidebarTab,
    studioProjects, profiles, history, dubHistory, exportHistory,
    dubVideoFile,
    selectedProfile,
    previewLoading,
    saveProject, loadProject, deleteProject,
    handleSelectProfile, handleDeleteProfile, handleOpenVoiceProfile,
    handleUnlockProfile, handleLockProfile, handlePreviewVoice,
    onOpenVoicePreview,
    restoreHistory, restoreDubHistory,
    handleSaveHistoryAsProfile,
    handleNativeExport, revealInFolder,
    deleteHistory,
    loadHistory, loadDubHistory,
  } = props;

  // Phase 2.2 — read UI + dub state straight from the store.
  const mode               = useAppStore(s => s.mode);
  const isSidebarCollapsed = useAppStore(s => s.isSidebarCollapsed);
  const dubStep            = useAppStore(s => s.dubStep);
  const activeProjectId    = useAppStore(s => s.activeProjectId);

  function timeAgo(ms) {
    const diff = Date.now() - ms;
    if (!isFinite(diff) || diff < 0) return '';
    const s = Math.floor(diff / 1000);
    if (s < 60) return t('common.seconds_ago', { s });
    const m = Math.floor(s / 60);
    if (m < 60) return t('common.minutes_ago', { m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('common.hours_ago', { h });
    const d = Math.floor(h / 24);
    if (d < 7) return t('common.days_ago', { d });
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  const [sbQuery, setSbQuery] = useState('');
  const qLower = sbQuery.trim().toLowerCase();
  const matchesSearch = (s) => !qLower || (s || '').toLowerCase().includes(qLower);
  const filteredProjects = useMemo(() => studioProjects.filter(p =>
    matchesSearch(p.name) || matchesSearch(p.video_path)
  ), [studioProjects, qLower]);
  const filteredProfiles = useMemo(() => profiles.filter(p =>
    matchesSearch(p.name) || matchesSearch(p.instruct)
  ), [profiles, qLower]);
  const filteredHistory = useMemo(() => history.filter(i =>
    matchesSearch(i.text) || matchesSearch(i.language) || matchesSearch(String(i.seed))
  ), [history, qLower]);
  const filteredDubHistory = useMemo(() => dubHistory.filter(i =>
    matchesSearch(i.filename) || matchesSearch(i.language) || matchesSearch(i.language_code)
  ), [dubHistory, qLower]);
  const filteredExport = useMemo(() => exportHistory.filter(i =>
    matchesSearch(i.filename) || matchesSearch(i.destination_path)
  ), [exportHistory, qLower]);

  const handleClearHistory = async () => {
    if (!(await askConfirm(t('sidebar.clearHistoryConfirm', { count: history.length + dubHistory.length, defaultValue: `Clear all ${history.length + dubHistory.length} history items? This cannot be undone.` })))) return;
    await clearGenHistory();
    await clearDubHistory();
    await loadHistory();
    await loadDubHistory();
    toast.success(t('sidebar.historyCleared', { defaultValue: 'History cleared' }));
  };

  const tabCount = {
    projects: mode === 'dub' ? studioProjects.length : (mode === 'clone' ? profiles.filter(p => !p.instruct).length : profiles.filter(p => !!p.instruct).length),
    history: history.length + dubHistory.length,
    downloads: exportHistory.length,
  };
  const tabLabel = { projects: t('sidebar.drive'), history: t('sidebar.history'), downloads: t('sidebar.exports') };

  return (
    <div className={`glass-panel history-panel sidebar ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
      {/* Tab bar — only tabs relevant to the current view */}
      <div className="sidebar__tabs">
        {SIDEBAR_TABS.filter(t => availableTabs.includes(t.id)).map(({ id, icon: Icon, accent }) => (
          <button
            key={id}
            onClick={() => setSidebarTab(id)}
            className={`sidebar__tab ${sidebarTab === id ? 'is-active' : ''}`}
            style={{ '--sidebar-tab-accent': accent }}
            title={`${tabLabel[id]} (${tabCount[id]})`}
          >
            <Icon size={13} />
            {tabCount[id] > 0 && <span className="sidebar__tab-badge">{tabCount[id]}</span>}
          </button>
        ))}
      </div>

      {!isSidebarCollapsed && (
        <div className="sidebar__search">
          <Search size={10} className="sidebar__search-icon" />
          <input
            className="input-base sidebar__search-input"
            placeholder={t('sidebar.search_placeholder')}
            value={sbQuery}
            onChange={(e) => setSbQuery(e.target.value)}
          />
          {sbQuery && (
            <Button
              variant="ghost"
              iconSize="sm"
              onClick={() => setSbQuery('')}
              title={t('common.clear')}
              className="sidebar__search-clear"
            >
              <X size={10} />
            </Button>
          )}
        </div>
      )}

      <div className={`sidebar__scroll ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
        {/* ── PROJECTS TAB ── */}
        {sidebarTab === 'projects' && (
          <>
            {mode === 'dub' && (dubStep !== 'idle' || dubVideoFile) && (
              isSidebarCollapsed ? (
                <Button
                  variant="subtle"
                  iconSize="md"
                  onClick={saveProject}
                  title={activeProjectId ? t('dub.save_dub_project') : t('dub.save_as_new_dub_project')}
                  className={`sidebar__save-btn ${activeProjectId ? 'is-active-project' : ''}`}
                >
                  <Save size={14} />
                </Button>
              ) : (
                <Button
                  variant="subtle"
                  block
                  onClick={saveProject}
                  leading={<Save size={13} />}
                  className={`sidebar__save-btn sidebar__save-btn--full ${activeProjectId ? 'is-active-project' : ''}`}
                >
                  {activeProjectId ? t('dub.save_dub_project') : t('dub.save_as_new_dub_project')}
                </Button>
              )
            )}

            {!isSidebarCollapsed && (
              <div
                className="sidebar__section-title"
                onClick={() => setIsSidebarProjectsCollapsed(!isSidebarProjectsCollapsed)}
              >
                <span>{mode === 'dub' ? t('sidebar.dub_projects') : (mode === 'clone' ? t('sidebar.voice_clones') : t('sidebar.designed_voices'))}</span>
                {isSidebarProjectsCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
              </div>
            )}

            {!isSidebarProjectsCollapsed && !isSidebarCollapsed && (
              <>
                {mode === 'dub' && (
                  <>
                    {filteredProjects.length === 0 ? (
                      <EmptyState
                        icon={Film}
                        title={t('dub.no_saved_dub_projects')}
                        hint={t('dub.no_saved_dub_hint')}
                      />
                    ) : (
                      filteredProjects.map(proj => (
                        <div key={proj.id}
                          className={`history-item history-item--dub ${activeProjectId === proj.id ? 'project-active' : ''}`}
                          onClick={() => loadProject(proj.id)}
                        >
                          <div className="history-row-head">
                            <span className="history-kind history-kind--audio">
                              <Film size={9} /> {t('sidebar.dub_kind')}
                            </span>
                            <span className="history-meta" title={new Date(proj.updated_at * 1000).toLocaleString()}>
                              {timeAgo(proj.updated_at * 1000)}
                            </span>
                          </div>
                          <div className="history-title">{proj.name}</div>
                          <div className="history-subtitle">
                            {proj.duration ? `${Math.round(proj.duration)}s` : t('sidebar.audio_subtitle')}
                            {(() => {
                              const basename = proj.video_path ? proj.video_path.split(/[\\/]/).pop() : '';
                              // Skip echoing the filename when it already matches the project name.
                              return basename && basename !== proj.name ? ` · ${basename}` : '';
                            })()}
                          </div>
                          <div className="history-actions">
                            <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); loadProject(proj.id); }}>
                              <FolderOpen size={10} /> {t('common.open')}
                            </button>
                            <button className="history-action-btn danger history-action-icon" onClick={(e) => { e.stopPropagation(); deleteProject(proj.id); }} title={t('common.delete')}>
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
                    {filteredProfiles.filter(p => mode === "clone" ? !p.instruct : !!p.instruct).length === 0 ? (
                      <EmptyState
                        icon={mode === 'clone' ? Fingerprint : Wand2}
                        title={mode === 'clone' ? t('sidebar.no_voice_clones') : t('sidebar.no_designed_voices')}
                        hint={mode === 'clone' ? t('sidebar.no_voice_clones_hint') : t('sidebar.no_designed_voices_hint')}
                      />
                    ) : (
                      (mode === 'clone' ? filteredProfiles.filter(p => !p.instruct) : filteredProfiles.filter(p => !!p.instruct)).map(proj => {
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
                                <KindIcon size={9} /> {proj.is_locked ? t('sidebar.locked_kind') : (mode === 'clone' ? t('sidebar.clone_kind') : t('sidebar.design_kind'))}
                              </span>
                              {proj.is_locked ? <span className="history-meta history-meta--locked">{t('sidebar.consistent_meta')}</span> : null}
                            </div>
                            <div className="history-title">{proj.name}</div>
                            {proj.instruct ? <div className="history-subtitle history-subtitle--italic">{proj.instruct}</div> : null}

                            <div className="history-actions">
                              <button className="history-action-btn history-action-icon" onClick={(e) => { e.stopPropagation(); handlePreviewVoice(proj, e); }} title={t('sidebar.preview_title')}>
                                {previewLoading === proj.id ? <Loader className="spinner" size={10} /> : <Play size={10} />}
                              </button>
                              {handleOpenVoiceProfile && (
                                <button
                                  className="history-action-btn"
                                  onClick={(e) => { e.stopPropagation(); handleOpenVoiceProfile(proj.id); }}
                                  title={t('sidebar.open_full_profile')}
                                >
                                  {t('common.open')}
                                </button>
                              )}
                              <button className="history-action-btn" onClick={(e) => { e.stopPropagation(); handleSelectProfile(proj); }}>
                                <Check size={10} /> {t('sidebar.select')}
                              </button>
                              {onOpenVoicePreview && (
                                <button
                                  className="history-action-btn accent"
                                  onClick={(e) => { e.stopPropagation(); onOpenVoicePreview(proj.id); }}
                                  title={t('sidebar.openVoicePreview', { defaultValue: 'Open interactive voice preview' })}
                                >
                                  <Volume2 size={10} /> {t('sidebar.try')}
                                </button>
                              )}
                              {proj.is_locked ? (
                                <button className="history-action-btn accent history-action-icon" onClick={(e) => { e.stopPropagation(); handleUnlockProfile(proj.id); }} title={t('voice.unlock')}>
                                  <Unlock size={10} />
                                </button>
                              ) : null}
                              <button className="history-action-btn danger history-action-icon" onClick={(e) => { e.stopPropagation(); handleDeleteProfile(proj.id); }} title={t('common.delete')}>
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

            {isSidebarCollapsed && mode === 'dub' && filteredProjects.map(proj => (
              <IconTile
                key={proj.id}
                title={t('sidebar.load_profile', { name: proj.name })}
                onClick={() => loadProject(proj.id)}
                active={activeProjectId === proj.id}
                rotSeed={proj.id}
              >
                <Film size={18} />
              </IconTile>
            ))}

            {isSidebarCollapsed && (mode === 'clone' || mode === 'design') && (mode === 'clone' ? filteredProfiles.filter(p => !p.instruct) : filteredProfiles.filter(p => !!p.instruct)).map(proj => (
              <IconTile
                key={proj.id}
                title={t('sidebar.select_profile', { name: proj.name })}
                onClick={() => handleSelectProfile(proj)}
                active={selectedProfile === proj.id}
                rotSeed={proj.id}
              >
                {mode === 'clone' ? <Fingerprint size={18} /> : <Wand2 size={18} />}
                {proj.is_locked && <Lock size={8} className="sidebar__icon-tile__lock" />}
              </IconTile>
            ))}
          </>
        )}

        {/* ── HISTORY TAB ── */}
        {sidebarTab === 'history' && (
          <>
            {!isSidebarCollapsed && <div className="sidebar__subtitle">{t('sidebar.generation_history')}</div>}
            {(history.length + dubHistory.length) === 0 ? (
              <EmptyState
                icon={History}
                title={t('sidebar.no_generation_history')}
                hint={t('sidebar.no_history_hint')}
              />
            ) : (
              <>
                {!isSidebarCollapsed && filteredDubHistory.map(item => (
                  <div key={`dub-${item.id}`} className="history-item history-item--dub"
                    onClick={() => restoreDubHistory(item)}
                  >
                    <div className="history-row-head">
                      <span className="history-kind history-kind--audio">
                        <Film size={9} /> {t('sidebar.dub_kind')}
                      </span>
                      <span className="history-meta">{item.segments_count} segs · {Math.round(item.duration || 0)}s</span>
                    </div>
                    <div className="history-title">{item.filename}</div>
                    <div className="history-subtitle">
                      {[item.language, item.language_code].filter(v => v && v !== 'und' && v !== 'Auto').join(' · ') || t('common.auto')}
                    </div>
                    <div className="history-actions">
                      <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); restoreDubHistory(item); }}>
                        <FolderOpen size={10} /> {t('common.open')}
                      </button>
                      <button className="history-action-btn danger history-action-icon" onClick={(e) => { e.stopPropagation(); deleteHistory(item.id, 'dub'); }} title={t('common.delete')}>
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                ))}

                {!isSidebarCollapsed && filteredHistory.map(item => {
                  const accent = item.mode === 'clone' ? '#d3869b' : '#b8bb26';
                  const KindIcon = item.mode === 'clone' ? Fingerprint : Wand2;
                  return (
                    <div key={item.id} className="history-item" style={{ '--row-accent': accent }}>
                      <div className="history-row-head">
                        <span className="history-kind" style={{ color: accent, borderColor: `${accent}40` }}>
                          <KindIcon size={9} /> {item.mode || t('sidebar.synth_kind')}
                        </span>
                        <span className="history-meta">
                          {item.language && item.language !== 'Auto' ? `${item.language} · ` : ''}
                          {item.generation_time ? `${item.generation_time}s` : ''}
                        </span>
                      </div>
                      <div className="history-title history-title--clamp" title={item.text}>
                        {item.text}
                      </div>
                      {item.seed != null && String(item.seed) !== ''
                        ? <div className="history-subtitle history-subtitle--seed">{t('sidebar.seed_label', { n: item.seed })}</div>
                        : null}
                      {item.audio_path ? (
                        <audio controls src={`${API}/audio/${item.audio_path}`} className="history-audio" />
                      ) : null}
                      {item.audio_path ? (
                        <div className="history-actions">
                          <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); handleSaveHistoryAsProfile(item); }}>
                            <Save size={10} /> {t('common.save')}
                          </button>
                          {item.profile_id ? (
                            <button className="history-action-btn accent history-action-icon"
                              onClick={(e) => { e.stopPropagation(); handleLockProfile(item.profile_id, item.id, item.seed); }}
                              title={t('sidebar.lock_voice_identity')}>
                              <Lock size={10} />
                            </button>
                          ) : null}
                          <button className="history-action-btn history-action-icon"
                            onClick={(e) => handleNativeExport(e, item.audio_path, item.audio_path, item.mode)}
                            title={t('common.export')}>
                            <DownloadIcon size={10} />
                          </button>
                          <button className="history-action-btn history-action-icon"
                            onClick={(e) => { e.stopPropagation(); restoreHistory(item); }}
                            title={t('sidebar.load_config')}>
                            <FolderOpen size={10} />
                          </button>
                          <button className="history-action-btn danger history-action-icon"
                            onClick={(e) => { e.stopPropagation(); deleteHistory(item.id, 'synth'); }}
                            title={t('common.delete')}>
                            <Trash2 size={10} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </>
            )}

            {isSidebarCollapsed && filteredDubHistory.map(item => (
              <div key={`dub-${item.id}`} title={`${t('sidebar.dub_kind')}: ${item.filename}`} onClick={() => restoreDubHistory(item)}
                className="sidebar-tile sidebar-tile--audio">
                <Film size={18} />
              </div>
            ))}

            {isSidebarCollapsed && filteredHistory.map(item => (
              <div key={item.id} title={`${item.mode || t('sidebar.history')}: ${item.text}`} onClick={() => restoreHistory(item)}
                className={`sidebar-tile ${item.mode === 'clone' ? 'sidebar-tile--clone' : 'sidebar-tile--design'}`}>
                {item.mode === 'clone' ? <Fingerprint size={18} /> : <Wand2 size={18} />}
              </div>
            ))}

            {(history.length + dubHistory.length) > 0 && !isSidebarCollapsed && (
              <Button
                variant="ghost"
                size="sm"
                block
                onClick={handleClearHistory}
                leading={<Trash2 size={10} />}
                className="sidebar__clear"
              >
                {t('sidebar.clear_history')}
              </Button>
            )}
          </>
        )}

        {/* ── DOWNLOADS TAB ── */}
        {sidebarTab === 'downloads' && (
          <>
            {!isSidebarCollapsed && <div className="sidebar__subtitle">{t('sidebar.recent_exports')}</div>}
            {exportHistory.length === 0 ? (
              <EmptyState
                icon={DownloadCloud}
                title={t('sidebar.no_downloaded_outputs')}
                hint={t('sidebar.no_exports_hint')}
              />
            ) : (
              <>
                {!isSidebarCollapsed && filteredExport.map(item => {
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
                      <div className="history-subtitle">{t('sidebar.in_folder', { folder: parentFolder })}</div>
                      <div className="history-actions">
                        <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); revealInFolder(item.destination_path); }}>
                          <FolderOpen size={10} /> {t('sidebar.show_in_folder')}
                        </button>
                      </div>
                    </div>
                  );
                })}

                {isSidebarCollapsed && filteredExport.map(item => (
                  <div key={item.id} title={t('sidebar.exported_file_title', { filename: item.filename })}
                    onClick={() => revealInFolder(item.destination_path)}
                    className={`sidebar-tile ${item.mode === 'audio' ? 'sidebar-tile--audio' : 'sidebar-tile--success'}`}
                  >
                    <FolderOpen size={18} />
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

/**
 * EmptyState — shared "nothing here yet" card across the three sidebar tabs.
 */
function EmptyState({ icon: Icon, title, hint }) {
  return (
    <div className="sidebar__empty">
      <Icon size={28} className="sidebar__empty-icon" />
      <p className="sidebar__empty-title">{title}</p>
      <p className="sidebar__empty-sub">{hint}</p>
    </div>
  );
}

/**
 * IconTile — hand-drawn sticker-style tile used in the collapsed-sidebar grid.
 * Deterministic rotation based on the id's last char keeps tiles wonky but stable.
 */
function IconTile({ children, title, onClick, active, rotSeed }) {
  const tilt = ((parseInt((rotSeed || '0').slice(-1), 36) % 5) - 2) * 0.8;
  return (
    <div
      title={title}
      onClick={onClick}
      className={`sidebar__icon-tile ${active ? 'is-active' : ''}`}
      style={{ transform: `rotate(${tilt}deg)` }}
    >
      {children}
    </div>
  );
}
