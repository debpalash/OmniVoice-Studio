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
  History,
  Fingerprint,
  Wand2,
  Film,
  Save,
  Lock,
  Download as DownloadIcon,
  FolderOpen,
  Trash2,
} from 'lucide-react';
import WaveformPlayer from './WaveformPlayer';
import { API } from '../api/client';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'clone', label: 'Clone' },
  { id: 'design', label: 'Design' },
];

/**
 * Row title for display: drop leading [laughter]/[question-en]-style control
 * tokens — they're synthesis instructions, not content, and they were eating
 * the two visible lines. The untouched original stays in the hover tooltip
 * and in restore/save flows.
 */
const displayTitle = (text) => {
  const stripped = (text || '').replace(/^(\s*\[[^\]]{1,30}\]\s*)+/, '').trim();
  return stripped || text || '';
};

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
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: '100px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [visible]);
  if (visible) return <WaveformPlayer height={height} className={className} {...rest} />;
  return <div ref={ref} className={className} style={{ height }} aria-hidden="true" />;
}

export default function WorkspaceHistory({
  variant = 'voice', // 'voice' (clone/design synth) | 'dub'
  history = [],
  dubHistory = [],
  restoreDubHistory,
  handleSaveHistoryAsProfile,
  handleLockProfile,
  handleNativeExport,
  restoreHistory,
  deleteHistory,
  clearHistory, // clear-all for this workspace's history (#1032)
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(null); // row id with un-clamped title

  // Clear-all affordance (#1032): the old left Sidebar had one; the workspace
  // UX overhaul (#374) moved history here and dropped it. Confirm + endpoint
  // live in App.jsx (clearWorkspaceHistory) — this only renders the button.
  const clearAllButton = (count) =>
    clearHistory && count > 0 ? (
      <button
        type="button"
        className="history-action-btn danger flex-[0_0_auto]"
        onClick={clearHistory}
        title={t('sidebar.clear_history')}
      >
        <Trash2 size={10} /> {t('sidebar.clear_history')}
      </button>
    ) : null;

  // Voice workspace = clone + design generations (dub lives in its own workspace).
  const items = useMemo(() => {
    const synth = history.filter((h) => h.mode === 'clone' || h.mode === 'design');
    return filter === 'all' ? synth : synth.filter((h) => h.mode === filter);
  }, [history, filter]);

  // ── Dub variant: a flat list of dub jobs, no clone/design filter. ──
  if (variant === 'dub') {
    return (
      <aside className="flex-[1_1_0] flex flex-col min-h-0 overflow-hidden">
        <div className="flex-[0_0_auto] flex flex-col gap-[8px] py-[10px] px-[12px]">
          <div className="flex items-center justify-between gap-[6px]">
            <span className="inline-flex items-center gap-[6px] [font-family:var(--chrome-font-mono,var(--font-mono))] text-[0.72rem] font-semibold [letter-spacing:0.04em] uppercase text-[color:var(--chrome-fg-muted)]">
              <History size={13} /> {t('history.dub_title', { defaultValue: 'Dub history' })}
            </span>
            {clearAllButton(dubHistory.length)}
          </div>
        </div>
        <div className="flex-[1_1_auto] min-h-0 overflow-y-auto flex flex-col gap-[8px] p-[8px]">
          {dubHistory.length === 0 ? (
            <div className="text-[color:var(--chrome-fg-dim)] text-[0.72rem] [line-height:1.5] text-center py-[32px] px-[16px]">
              {t('history.empty_dub', { defaultValue: 'Your dubs will appear here.' })}
            </div>
          ) : (
            dubHistory.map((item) => (
              <div
                key={`dub-${item.id}`}
                className="history-item history-item--dub"
                onClick={() => restoreDubHistory(item)}
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span className="history-kind history-kind--audio">
                    <Film size={9} /> {t('sidebar.dub_label')}
                  </span>
                  <span className="history-meta">
                    {item.segments_count} segs · {Math.round(item.duration || 0)}s
                  </span>
                </div>
                <div className="history-title">{item.filename}</div>
                <div className="history-subtitle">
                  {[item.language, item.language_code]
                    .filter((v) => v && v !== 'und' && v !== 'Auto')
                    .join(' · ') || 'Auto'}
                </div>
                <div className="history-actions">
                  <button
                    className="history-action-btn accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      restoreDubHistory(item);
                    }}
                  >
                    <FolderOpen size={10} /> {t('sidebar.open')}
                  </button>
                  <button
                    className="history-action-btn danger history-action-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteHistory(item.id, 'dub');
                    }}
                    title="Delete"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex-[1_1_0] flex flex-col min-h-0 overflow-hidden">
      <div className="flex-[0_0_auto] flex flex-col gap-[8px] py-[10px] px-[12px]">
        <div className="flex items-center justify-between gap-[6px]">
          <span className="inline-flex items-center gap-[6px] [font-family:var(--chrome-font-mono,var(--font-mono))] text-[0.72rem] font-semibold [letter-spacing:0.04em] uppercase text-[color:var(--chrome-fg-muted)]">
            <History size={13} /> {t('history.title', { defaultValue: 'History' })}
          </span>
          {clearAllButton(history.length)}
        </div>
        <div className="flex flex-wrap gap-[4px]">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`flex-[0_0_auto] py-[2px] px-[10px] text-[0.68rem] font-medium rounded-[var(--chrome-radius-pill,999px)] cursor-pointer [transition:background_0.15s_ease,color_0.15s_ease] ${
                filter === f.id
                  ? 'text-[color:var(--color-brand,#d3869b)] bg-[color-mix(in_srgb,var(--color-brand,#d3869b)_12%,transparent)]'
                  : 'bg-transparent text-[color:var(--chrome-fg-muted)] hover:bg-[var(--chrome-hover-bg)] hover:text-[color:var(--chrome-fg)]'
              }`}
              onClick={() => setFilter(f.id)}
            >
              {t(`history.filter_${f.id}`, { defaultValue: f.label })}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-[1_1_auto] min-h-0 overflow-y-auto flex flex-col gap-[8px] p-[8px]">
        {items.length === 0 ? (
          <div className="text-[color:var(--chrome-fg-dim)] text-[0.72rem] [line-height:1.5] text-center py-[32px] px-[16px]">
            {t('history.empty', {
              defaultValue: 'Nothing here yet — your generations will appear on the right.',
            })}
          </div>
        ) : (
          items.map((item) => {
            const accent = item.mode === 'clone' ? '#d3869b' : '#b8bb26';
            const KindIcon = item.mode === 'clone' ? Fingerprint : Wand2;
            return (
              <div key={item.id} className="history-item" style={{ '--row-accent': accent }}>
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span
                    className="history-kind"
                    style={{ color: accent, background: `${accent}22` }}
                  >
                    <KindIcon size={9} /> {item.mode || 'synth'}
                  </span>
                  <span className="history-meta">
                    {item.language && item.language !== 'Auto' ? `${item.language} · ` : ''}
                    {item.generation_time ? `${item.generation_time}s` : ''}
                  </span>
                </div>
                <div
                  className={`history-title history-title--clamp ${expanded === item.id ? 'history-title--expanded' : ''}`}
                  title={item.text}
                  onClick={() => setExpanded((e) => (e === item.id ? null : item.id))}
                >
                  {displayTitle(item.text)}
                </div>
                {item.seed != null && String(item.seed) !== '' ? (
                  <div className="history-subtitle history-subtitle--seed">seed {item.seed}</div>
                ) : null}
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
                    <button
                      className="history-action-btn accent"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSaveHistoryAsProfile(item);
                      }}
                    >
                      <Save size={10} /> {t('sidebar.save_label')}
                    </button>
                    {item.profile_id ? (
                      <button
                        className="history-action-btn accent history-action-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleLockProfile(item.profile_id, item.id, item.seed);
                        }}
                        title={t('sidebar.lock_identity')}
                      >
                        <Lock size={10} />
                      </button>
                    ) : null}
                    <button
                      className="history-action-btn history-action-icon"
                      onClick={(e) =>
                        handleNativeExport(e, item.audio_path, item.audio_path, item.mode)
                      }
                      title="Export"
                    >
                      <DownloadIcon size={10} />
                    </button>
                    <button
                      className="history-action-btn history-action-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        restoreHistory(item);
                      }}
                      title="Load config"
                    >
                      <FolderOpen size={10} />
                    </button>
                    <button
                      className="history-action-btn danger history-action-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteHistory(item.id, 'synth');
                      }}
                      title="Delete"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
