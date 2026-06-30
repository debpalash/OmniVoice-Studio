/**
 * WorkspaceProjects — the right-side "Dub projects" panel.
 *
 * Relocates the saved-dub-project list (and the Save-project button) out of the
 * left Sidebar so the Dub workspace can dissolve its sidebar, mirroring the
 * Voice workspace's WorkspaceVoices. Card markup + actions mirror the former
 * Sidebar section 1:1 (open/load, delete).
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Film, FolderOpen, Trash2, Save, Pencil, Check, X } from 'lucide-react';
import { Button } from '../ui';
import './WorkspaceVoices.css';

// Local copy of the sidebar's relative-time formatter (small, self-contained).
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

export default function WorkspaceProjects({
  projects = [],
  activeProjectId,
  canSave = false,
  saveProject,
  loadProject,
  deleteProject,
  renameProject,
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const qLower = q.trim().toLowerCase();
  // Inline rename: which project id is being edited + the draft name.
  const [editingId, setEditingId] = useState(null);
  const [draftName, setDraftName] = useState('');

  const startRename = (proj) => {
    setEditingId(proj.id);
    setDraftName(proj.name || '');
  };
  const cancelRename = () => {
    setEditingId(null);
    setDraftName('');
  };
  const commitRename = (proj) => {
    const next = draftName.trim();
    if (next && next !== proj.name) renameProject?.(proj.id, next);
    cancelRename();
  };

  const items = useMemo(() => {
    if (!qLower) return projects;
    return projects.filter((p) => (p.name || '').toLowerCase().includes(qLower));
  }, [projects, qLower]);

  return (
    <section className={`wv ${items.length === 0 ? 'wv--collapsed' : ''}`}>
      <div className="wv__head">
        <span className="wv__title">
          {t('sidebar.dub_projects', { defaultValue: 'Dub projects' })}
        </span>
        {canSave && (
          <Button
            variant="subtle"
            block
            onClick={saveProject}
            leading={<Save size={13} />}
            className={`sidebar__save-btn sidebar__save-btn--full ${activeProjectId ? 'is-active-project' : ''}`}
          >
            {activeProjectId ? t('sidebar.save_project') : t('sidebar.save_new_project')}
          </Button>
        )}
        <div className="wv__search">
          <Search size={12} className="wv__search-icon" />
          <input
            className="input-base wv__search-input"
            placeholder={t('sidebar.search', { defaultValue: 'Search…' })}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="wv__scroll">
        {items.length === 0 ? (
          <div className="wv__empty">
            {t('sidebar.no_dub_projects', { defaultValue: 'No dub projects yet' })}
          </div>
        ) : (
          items.map((proj) => (
            <div
              key={proj.id}
              className={`history-item history-item--dub ${activeProjectId === proj.id ? 'project-active' : ''}`}
              onClick={() => loadProject(proj.id)}
            >
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="history-kind history-kind--audio">
                  <Film size={9} /> {t('sidebar.dub_label')}
                </span>
                <span
                  className="history-meta"
                  title={new Date(proj.updated_at * 1000).toLocaleString()}
                >
                  {timeAgo(proj.updated_at * 1000)}
                </span>
              </div>
              {editingId === proj.id ? (
                <input
                  className="input-base wv__rename-input"
                  autoFocus
                  value={draftName}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation();
                      commitRename(proj);
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      cancelRename();
                    }
                  }}
                  onBlur={() => commitRename(proj)}
                />
              ) : (
                <div className="history-title">{proj.name}</div>
              )}
              <div className="history-subtitle">
                {proj.duration ? `${Math.round(proj.duration)}s` : 'audio'}
                {(() => {
                  const basename = proj.video_path ? proj.video_path.split(/[\\/]/).pop() : '';
                  return basename && basename !== proj.name ? ` · ${basename}` : '';
                })()}
              </div>
              <div className="history-actions">
                {editingId === proj.id ? (
                  <>
                    <button
                      className="history-action-btn accent"
                      onClick={(e) => {
                        e.stopPropagation();
                        commitRename(proj);
                      }}
                      title={t('sidebar.rename_save', { defaultValue: 'Save name' })}
                    >
                      <Check size={10} /> {t('common.save', { defaultValue: 'Save' })}
                    </button>
                    <button
                      className="history-action-btn history-action-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelRename();
                      }}
                      title={t('common.cancel', { defaultValue: 'Cancel' })}
                    >
                      <X size={10} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="history-action-btn accent"
                      onClick={(e) => {
                        e.stopPropagation();
                        loadProject(proj.id);
                      }}
                    >
                      <FolderOpen size={10} /> {t('sidebar.open')}
                    </button>
                    {renameProject && (
                      <button
                        className="history-action-btn history-action-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(proj);
                        }}
                        title={t('sidebar.rename', { defaultValue: 'Rename' })}
                      >
                        <Pencil size={10} />
                      </button>
                    )}
                    <button
                      className="history-action-btn danger history-action-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteProject(proj.id);
                      }}
                      title="Delete"
                    >
                      <Trash2 size={10} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
