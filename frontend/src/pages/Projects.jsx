import React, { useMemo, useState } from 'react';
import {
  Search, FolderOpen, Film, Fingerprint, Wand2, Music, Download,
  LayoutGrid, List as ListIcon, Clock,
} from 'lucide-react';
import './Projects.css';

/**
 * Projects — browse everything (studio dubs, voice profiles, generation
 * history, exports) in one place.
 *
 * Shape:
 *   ┌─────────────────────────────────────────────┐
 *   │ header strip (search + view toggle)         │
 *   ├─ filter rail ─┬── content grid/list ────────┤
 *   │ All           │                              │
 *   │ Dubs      (3) │   [card] [card] [card]      │
 *   │ Profiles (12) │   [card] [card] ...         │
 *   │ History  (48) │                              │
 *   │ Exports   (7) │                              │
 *   └───────────────┴──────────────────────────────┘
 *
 * Props reuse what App.jsx already loads — no new fetchers are added so
 * this page stays in sync with the Sidebar and Launchpad automatically.
 */

const FILTERS = [
  { id: 'all',      label: 'All',          Icon: FolderOpen  },
  { id: 'dubs',     label: 'Dub Projects', Icon: Film        },
  { id: 'profiles', label: 'Voice Profiles', Icon: Fingerprint },
  { id: 'history',  label: 'History',      Icon: Music       },
  { id: 'exports',  label: 'Exports',      Icon: Download    },
];

function fmtTime(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(d)) return '';
  const diff = Date.now() - d;
  const s = Math.floor(diff / 1000);
  if (s < 60)     return `${s}s ago`;
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtDuration(sec) {
  if (!sec) return '';
  const n = Number(sec);
  if (!Number.isFinite(n)) return '';
  if (n < 60) return `${Math.floor(n)}s`;
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}m ${s}s`;
}

function Card({ kind, accent, title, subtitle, trailing, onClick, IconC }) {
  return (
    <button
      type="button"
      className="projects__card"
      onClick={onClick}
      style={{ '--card-accent': accent }}
    >
      <div className="projects__card-head">
        <span className="projects__card-kind">
          {IconC && <IconC size={11} />}
          {kind}
        </span>
        <span className="projects__card-trailing">{trailing}</span>
      </div>
      <div className="projects__card-title" title={title}>{title}</div>
      {subtitle && <div className="projects__card-sub" title={subtitle}>{subtitle}</div>}
    </button>
  );
}

export default function Projects({
  studioProjects = [],
  profiles = [],
  history = [],
  exportHistory = [],
  onOpenDub,           // (projectId) => void — loads project + switches to dub mode
  onOpenProfile,       // (voiceId)   => void
  onRevealExport,      // (path)      => void
}) {
  const [filter, setFilter]   = useState('all');
  const [query, setQuery]     = useState('');
  const [view, setView]       = useState('grid');  // grid | list

  // Normalise every source into a common shape so the filter + search +
  // sort pipeline is identical regardless of origin.
  const items = useMemo(() => {
    const list = [];
    for (const p of studioProjects) {
      list.push({
        type: 'dubs',
        id: p.id,
        title: p.name || p.video_path?.split('/').pop() || p.id,
        subtitle: fmtDuration(p.duration),
        ts: (p.updated_at || p.created_at || 0) * 1000,
        accent: '#fe8019',
        Icon: Film,
        onClick: () => onOpenDub?.(p.id),
      });
    }
    for (const pr of profiles) {
      const kind = pr.kind || 'clone';
      list.push({
        type: 'profiles',
        id: pr.id,
        title: pr.name || pr.id,
        subtitle: kind === 'design' ? 'Designed voice' : 'Cloned voice',
        ts: (pr.updated_at || pr.created_at || 0) * 1000,
        accent: kind === 'design' ? '#8ec07c' : '#d3869b',
        Icon: kind === 'design' ? Wand2 : Fingerprint,
        onClick: () => onOpenProfile?.(pr.id),
      });
    }
    for (const h of history) {
      list.push({
        type: 'history',
        id: h.filename || h.id || String(Math.random()),
        title: (h.text || h.prompt || h.filename || 'Generated audio').slice(0, 80),
        subtitle: h.language || h.voice || '',
        ts: h.timestamp || h.created_at || 0,
        accent: '#f3a5b6',
        Icon: Music,
        onClick: undefined,
      });
    }
    for (const e of exportHistory) {
      list.push({
        type: 'exports',
        id: e.path || e.id,
        title: e.path?.split('/').pop() || e.filename || 'Export',
        subtitle: e.mode || '',
        ts: (e.created_at || 0) * 1000,
        accent: '#fabd2f',
        Icon: Download,
        onClick: () => e.path && onRevealExport?.(e.path),
      });
    }
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return list;
  }, [studioProjects, profiles, history, exportHistory, onOpenDub, onOpenProfile, onRevealExport]);

  const counts = useMemo(() => {
    const c = { all: items.length };
    for (const it of items) c[it.type] = (c[it.type] || 0) + 1;
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(it => {
      if (filter !== 'all' && it.type !== filter) return false;
      if (!q) return true;
      return (it.title + ' ' + (it.subtitle || '')).toLowerCase().includes(q);
    });
  }, [items, filter, query]);

  return (
    <div className="projects">
      <div className="projects__header">
        <h1 className="projects__title">Projects</h1>
        <div className="projects__toolbar">
          <div className="projects__search">
            <Search size={12} />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search projects, profiles, history, exports…"
              spellCheck={false}
            />
          </div>
          <div className="projects__view-toggle">
            <button
              className={view === 'grid' ? 'is-active' : ''}
              onClick={() => setView('grid')}
              title="Card grid"
              type="button"
            >
              <LayoutGrid size={12} />
            </button>
            <button
              className={view === 'list' ? 'is-active' : ''}
              onClick={() => setView('list')}
              title="List"
              type="button"
            >
              <ListIcon size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="projects__body">
        <aside className="projects__rail">
          {FILTERS.map(f => {
            const FI = f.Icon;
            const n = counts[f.id] ?? 0;
            return (
              <button
                key={f.id}
                type="button"
                className={`projects__rail-item ${filter === f.id ? 'is-active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                <FI size={12} />
                <span>{f.label}</span>
                <span className="projects__rail-count">{n}</span>
              </button>
            );
          })}
        </aside>

        <section className={`projects__content projects__content--${view}`}>
          {visible.length === 0 && (
            <div className="projects__empty">
              <FolderOpen size={28} />
              <p>{query ? `No matches for “${query}”` : 'Nothing here yet. Start a dub, design a voice, or generate audio to see it appear.'}</p>
            </div>
          )}
          {visible.map(it => (
            <Card
              key={`${it.type}:${it.id}`}
              kind={it.type.toUpperCase()}
              accent={it.accent}
              title={it.title}
              subtitle={it.subtitle}
              trailing={<span className="projects__card-time"><Clock size={10} />{fmtTime(it.ts)}</span>}
              onClick={it.onClick}
              IconC={it.Icon}
            />
          ))}
        </section>
      </div>
    </div>
  );
}
