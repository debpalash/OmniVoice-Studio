import React, { useMemo, useState } from 'react';
import { copyText } from "../utils/copyText";
import { useTranslation } from 'react-i18next';
import {
  Search, FolderOpen, Film, Fingerprint, Wand2, Music, Download,
  LayoutGrid, List as ListIcon, Clock, FileText, Mic, BookMarked, BookOpen,
} from 'lucide-react';
import { apiFetch } from '../api/client';
import { audioUrl } from '../api/generate';
import './Projects.css';

/**
 * OmniDrive — browse everything (studio dubs, voice profiles, generation
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
  storyProjects = [],
  onOpenDub,           // (projectId) => void — loads project + switches to dub mode
  onOpenProfile,       // (voiceId)   => void
  onOpenStory,         // (storyId)   => void — loads story + switches to stories mode
  onRevealExport,      // (path)      => void
}) {
  const [filter, setFilter]   = useState('all');
  const [query, setQuery]     = useState('');
  const [view, setView]       = useState('grid');  // grid | list
  const { t } = useTranslation();

  const FILTERS = [
    { id: 'all',      label: t('projects.all'),            Icon: FolderOpen  },
    { id: 'dubs',     label: t('projects.dub_projects'),   Icon: Film        },
    { id: 'stories',  label: t('projects.stories'),        Icon: BookOpen    },
    { id: 'profiles', label: t('projects.voice_profiles'), Icon: Fingerprint },
    { id: 'transcripts', label: t('projects.transcripts'), Icon: Mic         },
    { id: 'audiobooks', label: t('projects.audiobooks'),   Icon: BookMarked  },
    { id: 'history',  label: t('projects.history'),        Icon: Music       },
    { id: 'exports',  label: t('projects.exports'),        Icon: Download    },
  ];

  // Finished Audiobook + Story renders (server-side longform library).
  const [longformJobs, setLongformJobs] = useState([]);
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch('/longform/jobs');
        const data = await res.json();
        if (alive) setLongformJobs(data.jobs || []);
      } catch { /* offline / no backend — leave empty */ }
    })();
    return () => { alive = false; };
  }, []);

  // Load transcriptions from localStorage (same source as TranscriptionsPage)
  const [transcriptions, setTranscriptions] = useState(() => {
    try { return JSON.parse(localStorage.getItem('omni_transcriptions') || '[]'); }
    catch { return []; }
  });
  // Listen for new transcriptions
  React.useEffect(() => {
    const handler = () => {
      try { setTranscriptions(JSON.parse(localStorage.getItem('omni_transcriptions') || '[]')); }
      catch {}
    };
    window.addEventListener('omni:transcription-added', handler);
    return () => window.removeEventListener('omni:transcription-added', handler);
  }, []);

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
    for (const sp of storyProjects) {
      const tracks = (sp.tracks || []).length;
      const chars = new Set((sp.cast || []).map((c) => c.id)).size;
      list.push({
        type: 'stories',
        id: sp.id,
        title: sp.name || t('projects.untitled_story'),
        subtitle: [tracks ? t('projects.story_lines', { count: tracks }) : '',
                   chars ? t('projects.story_voices', { count: chars }) : ''].filter(Boolean).join(' · '),
        ts: sp.updatedAt || 0,
        accent: '#83a598',
        Icon: BookOpen,
        onClick: () => onOpenStory?.(sp.id),
      });
    }
    for (const pr of profiles) {
      const kind = pr.kind || 'clone';
      list.push({
        type: 'profiles',
        id: pr.id,
        title: pr.name || pr.id,
        subtitle: kind === 'design' ? t('projects.designed_voice') : t('projects.cloned_voice'),
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
        title: (h.text || h.prompt || h.filename || t('projects.generated_audio')).slice(0, 80),
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
        title: e.path?.split('/').pop() || e.filename || t('projects.export'),
        subtitle: e.mode || '',
        ts: (e.created_at || 0) * 1000,
        accent: '#fabd2f',
        Icon: Download,
        onClick: () => e.path && onRevealExport?.(e.path),
      });
    }
    for (const j of longformJobs) {
      const mins = j.duration_s ? `${Math.round(j.duration_s / 60)} min` : '';
      list.push({
        type: 'audiobooks',
        id: j.job_id,
        title: j.title || j.output,
        subtitle: [j.type === 'story' ? t('projects.story') : t('projects.audiobook'),
                   j.chapters ? `${j.chapters} ch` : '', mins].filter(Boolean).join(' · '),
        ts: (j.created_at || 0) * 1000,
        accent: '#d3869b',
        Icon: BookMarked,
        onClick: () => j.output && window.open(audioUrl(j.output), '_blank'),
      });
    }
    for (const tr of transcriptions) {
      list.push({
        type: 'transcripts',
        id: tr.id || String(Math.random()),
        title: (tr.text || t('projects.transcription')).slice(0, 120),
        subtitle: [tr.language, tr.duration_s ? `${Math.round(tr.duration_s)}s` : ''].filter(Boolean).join(' · '),
        ts: tr.timestamp ? Date.parse(tr.timestamp) : 0,
        accent: '#83a598',
        Icon: FileText,
        onClick: () => {
          copyText(tr.text || '');
        },
      });
    }
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return list;
  }, [studioProjects, profiles, history, exportHistory, transcriptions, longformJobs, storyProjects, onOpenDub, onOpenProfile, onOpenStory, onRevealExport, t]);

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
        <h1 className="projects__title">{t('projects.title')}</h1>
        <div className="projects__toolbar">
          <div className="projects__search">
            <Search size={12} />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('projects.search_placeholder')}
              spellCheck={false}
            />
          </div>
          <div className="projects__view-toggle">
            <button
              className={view === 'grid' ? 'is-active' : ''}
              onClick={() => setView('grid')}
              title={t('projects.card_grid')}
              type="button"
            >
              <LayoutGrid size={12} />
            </button>
            <button
              className={view === 'list' ? 'is-active' : ''}
              onClick={() => setView('list')}
              title={t('projects.list')}
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
              <p>{query ? t('projects.no_matches', { query }) : t('projects.empty_hint')}</p>
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
