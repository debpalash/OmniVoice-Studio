/**
 * WorkspaceHistory — the right-side, workspace-scoped generation history
 * (spec: docs/specs/voice-studio-unification.md, P1).
 *
 * Lifts the synth-history rows out of the left Sidebar so history lives next
 * to the work that produced it. For the Voice workspace it shows clone + design
 * generations with an [All][Clone][Design] filter; each row reuses the shared
 * <WaveformPlayer> and the same per-item actions the sidebar had
 * (save-as-profile, lock, export, load-config, delete).
 *
 * Pure presentational + local filter state — all data and handlers are passed
 * in from App.jsx (single source of truth for history + profile mutations).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  History, Fingerprint, Wand2, Film, Save, Lock, Download as DownloadIcon,
  FolderOpen, Trash2,
} from 'lucide-react';
import WaveformPlayer from './WaveformPlayer';
import { API } from '../api/client';
import './WorkspaceHistory.css';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'clone', label: 'Clone' },
  { id: 'design', label: 'Design' },
];

/**
 * Defer mounting <WaveformPlayer> (and its audio fetch + waveform decode)
 * until the row scrolls into view — the server returns up to 50 history rows,
 * which would otherwise fire 50 simultaneous fetches on panel mount.
 */
function LazyWaveform({ height = 36, className = '', ...rest }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { rootMargin: '100px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [visible]);
  if (visible) return <WaveformPlayer height={height} className={className} {...rest} />;
  return <div ref={ref} className={className} style={{ height }} aria-hidden="true" />;
}

export default function WorkspaceHistory({
  variant = 'voice',           // 'voice' (clone/design synth) | 'dub'
  history = [],
  dubHistory = [],
  restoreDubHistory,
  handleSaveHistoryAsProfile,
  handleLockProfile,
  handleNativeExport,
  restoreHistory,
  deleteHistory,
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('all');

  // Voice workspace = clone + design generations (dub lives in its own workspace).
  const items = useMemo(() => {
    const synth = history.filter(h => h.mode === 'clone' || h.mode === 'design');
    return filter === 'all' ? synth : synth.filter(h => h.mode === filter);
  }, [history, filter]);

  // ── Dub variant: a flat list of dub jobs, no clone/design filter. ──
  if (variant === 'dub') {
    return (
      <aside className="wh">
        <div className="wh__head">
          <span className="wh__title">
            <History size={13} /> {t('history.dub_title', { defaultValue: 'Dub history' })}
          </span>
        </div>
        <div className="wh__scroll">
          {dubHistory.length === 0 ? (
            <div className="wh__empty">
              {t('history.empty_dub', { defaultValue: 'Your dubs will appear here.' })}
            </div>
          ) : dubHistory.map(item => (
            <div
              key={`dub-${item.id}`}
              className="history-item history-item--dub"
              onClick={() => restoreDubHistory(item)}
            >
              <div className="history-row-head">
                <span className="history-kind history-kind--audio">
                  <Film size={9} /> {t('sidebar.dub_label')}
                </span>
                <span className="history-meta">{item.segments_count} segs · {Math.round(item.duration || 0)}s</span>
              </div>
              <div className="history-title">{item.filename}</div>
              <div className="history-subtitle">
                {[item.language, item.language_code].filter(v => v && v !== 'und' && v !== 'Auto').join(' · ') || 'Auto'}
              </div>
              <div className="history-actions">
                <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); restoreDubHistory(item); }}>
                  <FolderOpen size={10} /> {t('sidebar.open')}
                </button>
                <button className="history-action-btn danger history-action-icon" onClick={(e) => { e.stopPropagation(); deleteHistory(item.id, 'dub'); }} title="Delete">
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="wh">
      <div className="wh__head">
        <span className="wh__title">
          <History size={13} /> {t('history.title', { defaultValue: 'History' })}
        </span>
        <div className="wh__filters">
          {FILTERS.map(f => (
            <button
              key={f.id}
              type="button"
              className={`wh__chip ${filter === f.id ? 'is-active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {t(`history.filter_${f.id}`, { defaultValue: f.label })}
            </button>
          ))}
        </div>
      </div>

      <div className="wh__scroll">
        {items.length === 0 ? (
          <div className="wh__empty">
            {t('history.empty', { defaultValue: 'Nothing here yet — your generations will appear on the right.' })}
          </div>
        ) : items.map(item => {
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
              <div className="history-title history-title--clamp" title={item.text}>
                {item.text}
              </div>
              {item.seed != null && String(item.seed) !== ''
                ? <div className="history-subtitle history-subtitle--seed">seed {item.seed}</div>
                : null}
              {item.audio_path ? (
                <LazyWaveform
                  src={`${API}/audio/${item.audio_path}`}
                  source="history"
                  height={36}
                  compact
                  className="history-audio"
                />
              ) : null}
              {item.audio_path ? (
                <div className="history-actions">
                  <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); handleSaveHistoryAsProfile(item); }}>
                    <Save size={10} /> {t('sidebar.save_label')}
                  </button>
                  {item.profile_id ? (
                    <button className="history-action-btn accent history-action-icon"
                      onClick={(e) => { e.stopPropagation(); handleLockProfile(item.profile_id, item.id, item.seed); }}
                      title={t('sidebar.lock_identity')}>
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
      </div>
    </aside>
  );
}
