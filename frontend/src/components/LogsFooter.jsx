import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from "../utils/copyText";
import {
  ChevronUp, ChevronDown, RefreshCw, Trash2, Copy, Bug, X,
  AlertTriangle, AlertCircle, Info, FileText, Heart, Mail,
} from 'lucide-react';

import toast from 'react-hot-toast';
import { clearSystemLogs, clearTauriLogs } from '../api/system';
import { useSystemLogs, useTauriLogs, useNotifications, useClearLogs, useClearTauriLogs } from '../api/hooks';
import { getFrontendLogs, clearFrontendLogs } from '../utils/consoleBuffer';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import NetworkToggle from './NetworkToggle';
import { APP_VERSION } from '../utils/appVersion';
import './LogsFooter.css';

/**
 * VSCode-style bottom panel for logs. Always-visible 28 px collapsed bar
 * shows error/warning counts per source (Backend, Frontend, Tauri); click
 * any pill or the chevron to expand into a resizable panel. State — which
 * tab is active, is it collapsed, panel height — persists in localStorage
 * so the panel remembers where the user left it across launches.
 */

const SOURCES = [
  { id: 'backend',  label: 'Backend',  icon: FileText },
  { id: 'frontend', label: 'Frontend', icon: FileText },
  { id: 'tauri',    label: 'Tauri',    icon: FileText },
  // Notifications used to live here as a 4th pill but that duplicated the
  // header's bell+badge (single source of truth for notifications). The
  // footer is logs-only now; bell handles notifications.
  // Updates tab moved to Settings → Updates (see Settings.jsx).
];

const LS_HEIGHT = 'omnivoice.logs.height';
const LS_ACTIVE = 'omnivoice.logs.active';

const MIN_H = 180;
const MAX_H = 720;

// Severity heuristics. We scan each line for these keywords so the UI
// can show badge counts per source without waiting for a structured
// logger. Matches word-boundary to avoid false positives on identifiers
// like `warning_count` or `error_handler`.
const RE_ERROR = /\b(error|fatal|exception|traceback)\b/i;
const RE_WARN  = /\b(warn(ing)?|deprecated)\b/i;

function classifyLine(raw) {
  const text = typeof raw === 'string' ? raw : (raw?.msg ?? String(raw));
  if (RE_ERROR.test(text)) return 'error';
  if (RE_WARN.test(text))  return 'warn';
  return 'info';
}

function countLevels(lines) {
  let error = 0, warn = 0;
  for (const l of lines) {
    const sev = classifyLine(l);
    if (sev === 'error') error++;
    else if (sev === 'warn') warn++;
  }
  return { error, warn, total: lines.length };
}

function formatFrontendLine(entry) {
  const ts = new Date(entry.t).toISOString().slice(11, 23);
  return `[${ts}] ${entry.level.toUpperCase()} ${entry.msg}`;
}

function SeverityIcon({ level, size = 11 }) {
  if (level === 'error') return <AlertCircle size={size} color="#fb4934" />;
  if (level === 'warn')  return <AlertTriangle size={size} color="#fabd2f" />;
  return <Info size={size} color="#7c6f64" />;
}

// UiScaleToggle and ThemePicker used to live here as always-visible
// controls in the footer chrome. Moved to Settings → Appearance (see
// AppearancePanel) so the footer can stay focused on logs. The store
// fields (uiScale, theme, setUiScale, setTheme) are unchanged; only the
// rendering moved.

function SourcePill({ source, counts, active, onClick }) {
  const hasErrors = counts.error > 0;
  const hasWarns  = counts.warn > 0;
  return (
    <button
      type="button"
      className={[
        'logs-footer__pill',
        active ? 'logs-footer__pill--active' : '',
        hasErrors ? 'logs-footer__pill--error' : hasWarns ? 'logs-footer__pill--warn' : '',
      ].filter(Boolean).join(' ')}
      onClick={onClick}
      aria-label={`${source.label} logs${hasErrors ? `, ${counts.error} errors` : hasWarns ? `, ${counts.warn} warnings` : ''}`}
    >
      <span className="logs-footer__pill-label">{source.label}</span>
      {hasErrors && (
        <span className="logs-footer__badge logs-footer__badge--error">{counts.error}</span>
      )}
      {!hasErrors && hasWarns && (
        <span className="logs-footer__badge logs-footer__badge--warn">{counts.warn}</span>
      )}
      {!hasErrors && !hasWarns && counts.total > 0 && (
        <span className="logs-footer__badge">{counts.total}</span>
      )}
    </button>
  );
}

// ── Seasonal / random donate heart ──────────────────────────────────────
// Christmas (Dec), Diwali (~Oct-Nov), Valentine's (Feb), Eid (~Mar-Apr),
// default pool rotates daily based on day-of-year.
const HEART_POOL = ['❤️', '🩷', '💜', '💙', '🧡', '💛', '🩵', '💖', '💗'];
const SEASONAL = [
  { month: 12, emoji: '🎄',  color: '#e74c3c', title: 'Merry Christmas! Support this project' },
  { month: 2,  emoji: '💝',  color: '#ff6b81', title: 'Happy Valentine\'s! Support this project' },
  // Diwali window — roughly Kartik Amavasya (Oct–Nov)
  { month: 10, emoji: '🪔',  color: '#f5a623', title: 'Happy Diwali! Support this project' },
  { month: 11, emoji: '✨',  color: '#f5a623', title: 'Happy Diwali! Support this project' },
];

function DonateHeart() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);

  const seasonal = SEASONAL.find(s => s.month === month);
  if (seasonal) {
    return <span style={{ fontSize: 14, lineHeight: 1 }} title={seasonal.title}>{seasonal.emoji}</span>;
  }
  // Rotate through the pool daily
  const pick = HEART_POOL[dayOfYear % HEART_POOL.length];
  return <span style={{ fontSize: 14, lineHeight: 1 }}>{pick}</span>;
}

export default function LogsFooter() {
  // Always start collapsed on every launch — per-session toggling works
  // but nothing persists. Kill the legacy key on the way out so users
  // who had it stored as "open" before aren't stuck on the next load.
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('omnivoice.logs.collapsed');
  }
  const [collapsed, setCollapsed] = useState(true);
  const { t } = useTranslation();
  // Update availability drives the footer version badge's notification dot.
  const updateStatus = useAppStore((s) => s.updateStatus);
  const updateVersion = useAppStore((s) => s.updateVersion);
  const updateReady = updateStatus === 'available' || updateStatus === 'ready';
  const [height, setHeight] = useState(() => {
    const v = Number(localStorage.getItem(LS_HEIGHT));
    return Number.isFinite(v) && v >= MIN_H && v <= MAX_H ? v : 300;
  });
  const [active, setActive] = useState(() => {
    const v = localStorage.getItem(LS_ACTIVE);
    return SOURCES.some(s => s.id === v) ? v : 'backend';
  });

  // Raw log state per source. Backend / Tauri come from HTTP; frontend
  // comes from the in-process ring buffer in consoleBuffer.js.
  const [lines, setLines] = useState({ backend: [], frontend: [], tauri: [] });
  const [loading, setLoading] = useState(false);
  const [hfInput, setHfInput] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => localStorage.setItem(LS_HEIGHT, String(height)), [height]);
  useEffect(() => localStorage.setItem(LS_ACTIVE, active),         [active]);

  // Expose the current footer height as a CSS variable on :root so the
  // studio's .app-container grid + the setup-wizard wrapper both shrink
  // by exactly the right amount. Keeps sidebar + main content out from
  // under the expanded panel without any JS-driven layout math.
  useEffect(() => {
    const h = collapsed ? 28 : height;
    document.documentElement.style.setProperty('--logs-footer-height', `${h}px`);
    return () => {
      document.documentElement.style.setProperty('--logs-footer-height', '28px');
    };
  }, [collapsed, height]);

  // ── TanStack Query for backend + tauri logs ────────────────────────────
  // While collapsed only the count badge is visible, so poll lazily (45s);
  // tighten to 10s when the panel is open (same throttle idea as pullFrontend).
  const backendLogs = useSystemLogs(300, true, collapsed ? 45_000 : 10_000);
  const tauriLogs   = useTauriLogs(300, true, collapsed ? 45_000 : 10_000);

  // Sync query data into local state for the rendering pipeline
  useEffect(() => {
    if (backendLogs.data) {
      setLines(prev => ({ ...prev, backend: backendLogs.data.lines || [] }));
    }
  }, [backendLogs.data]);

  useEffect(() => {
    if (tauriLogs.data) {
      setLines(prev => ({ ...prev, tauri: tauriLogs.data.lines || [] }));
    }
  }, [tauriLogs.data]);

  // Skip the setLines (and the re-render it forces) when the console ring
  // buffer hasn't changed since the last pull — same length + same last
  // timestamp means nothing new arrived.
  const lastFrontendPull = useRef({ len: -1, t: 0 });
  const pullFrontend = useCallback(() => {
    const raw = getFrontendLogs();
    const lastT = raw.length ? raw[raw.length - 1].t : 0;
    const seen = lastFrontendPull.current;
    if (raw.length === seen.len && lastT === seen.t) return;
    lastFrontendPull.current = { len: raw.length, t: lastT };
    setLines(prev => ({
      ...prev,
      frontend: raw.map(formatFrontendLine),
    }));
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    backendLogs.refetch();
    tauriLogs.refetch();
    pullFrontend();
    setLoading(false);
  }, [backendLogs, tauriLogs, pullFrontend]);

  // Frontend logs still need a local interval (no API, reads from buffer)
  useEffect(() => {
    pullFrontend();
    const iv = setInterval(pullFrontend, collapsed ? 8000 : 3000);
    return () => clearInterval(iv);
  }, [pullFrontend, collapsed]);

  // ── Notifications (shared TanStack Query cache with the header bell) ────
  const notifQuery = useNotifications();
  const notifications = notifQuery.data?.notifications || [];

  // Allow header bell to open notifications tab
  useEffect(() => {
    const handler = () => {
      setActive('notifications');
      setCollapsed(false);
    };
    window.addEventListener('omni:open-notifications', handler);
    return () => window.removeEventListener('omni:open-notifications', handler);
  }, []);

  // Auto-scroll to bottom when new lines arrive and panel is open.
  useEffect(() => {
    if (collapsed) return;
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [lines, active, collapsed]);

  const counts = useMemo(() => ({
    backend:  countLevels(lines.backend),
    frontend: countLevels(lines.frontend),
    tauri:    countLevels(lines.tauri),
    notifications: {
      error: notifications.filter(n => n.level === 'error').length,
      warn: notifications.filter(n => n.level === 'warn').length,
      total: notifications.length,
    },
  }), [lines, notifications]);

  const openTo = (id) => { setActive(id); setCollapsed(false); };

  // Combined backend+frontend+tauri counts for the single collapsed "Logs" tab.
  const mergedCounts = useMemo(() => {
    const acc = { error: 0, warn: 0, total: 0 };
    for (const s of SOURCES) {
      const c = counts[s.id] || { error: 0, warn: 0, total: 0 };
      acc.error += c.error; acc.warn += c.warn; acc.total += c.total;
    }
    return acc;
  }, [counts]);

  // ── Resize handle (drag the top edge) ───────────────────────────────
  const dragRef = useRef(null);
  const onDragStart = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev) => {
      const dy = startY - ev.clientY;
      const next = Math.min(MAX_H, Math.max(MIN_H, startH + dy));
      setHeight(next);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // ── Actions ─────────────────────────────────────────────────────────
  const onClear = async () => {
    try {
      if (active === 'backend')       await clearSystemLogs();
      else if (active === 'tauri')    await clearTauriLogs();
      else if (active === 'frontend') clearFrontendLogs();
      setLines(prev => ({ ...prev, [active]: [] }));
      toast.success(t('logs.log_cleared', { source: active }));
    } catch (e) {
      toast.error(t('logs.clear_failed', { message: e?.message || e }));
    }
  };

  const onCopy = async () => {
    try {
      const raw = (lines[active] || []).join('\n');
      await copyText(raw);
      toast.success(t('logs.log_copied', { source: active }));
    } catch (e) {
      toast.error(t('logs.copy_failed', { message: e?.message || e }));
    }
  };

  const onReportIssue = async () => {
    // Collate a short diagnostic dump — last 80 lines per source + counts
    // + user agent — onto the clipboard so the user can paste into a
    // GitHub issue without hand-collecting files.
    const header = [
      `OmniVoice Studio — diagnostic report`,
      `When: ${new Date().toISOString()}`,
      `UA: ${navigator.userAgent}`,
      `Counts: backend err=${counts.backend.error}/warn=${counts.backend.warn}, ` +
        `frontend err=${counts.frontend.error}/warn=${counts.frontend.warn}, ` +
        `tauri err=${counts.tauri.error}/warn=${counts.tauri.warn}`,
      '',
    ].join('\n');
    const body = SOURCES.map(s => {
      const l = lines[s.id] || [];
      return `── ${s.label} (last ${Math.min(l.length, 80)} of ${l.length}) ──────────────\n` +
        l.slice(-80).join('\n');
    }).join('\n\n');
    try {
      await copyText(header + body);
      toast.success(t('logs.report_copied'));
    } catch (e) {
      toast.error(t('logs.report_failed', { message: e?.message || e }));
    }
  };

  // ── Render ──────────────────────────────────────────────────────────
  const current = lines[active] || [];
  const notifCounts = { error: 0, warn: notifications.filter(n => n.level === 'warn').length + notifications.filter(n => n.level === 'error').length, total: notifications.length };

  return (
    <div className={['logs-footer', collapsed ? 'logs-footer--collapsed' : 'logs-footer--open'].join(' ')}
         style={collapsed ? undefined : { height }}>
      {!collapsed && (
        <div
          ref={dragRef}
          className="logs-footer__resize"
          onMouseDown={onDragStart}
          title={t('logs.drag_resize')}
        />
      )}

      <div className="logs-footer__bar">
        <div className="logs-footer__left">
          {/* UI scale + theme picker moved to Settings → Appearance.
              Footer is logs-focused now; rarely-used display prefs don't
              belong in always-visible chrome. */}
          <button
            type="button"
            className="logs-footer__toggle"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? t('logs.expand') : t('logs.collapse')}
            aria-label={collapsed ? t('logs.expand_aria') : t('logs.collapse_aria')}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {collapsed ? (
            /* Collapsed: a single merged "Logs" tab with the combined count.
               Expanding reveals the per-source filter tabs below. */
            <SourcePill
              source={{ id: 'logs', label: t('logs.title') }}
              counts={mergedCounts}
              active={false}
              onClick={() => openTo(SOURCES.some(s => s.id === active) ? active : 'backend')}
            />
          ) : (
            <>
              <span className="logs-footer__title">{t('logs.title')}</span>
              {SOURCES.map(s => (
                <SourcePill
                  key={s.id}
                  source={s}
                  counts={counts[s.id]}
                  active={active === s.id}
                  onClick={() => setActive(s.id)}
                />
              ))}
            </>
          )}
        </div>
        <div className="logs-footer__right">
          {!collapsed && (
            <div className="logs-footer__actions">
              <button className="logs-footer__icon-btn" onClick={refreshAll} disabled={loading} title={t('logs.refresh')} aria-label={t('logs.refresh_aria')}>
                <RefreshCw size={12} className={loading ? 'spinner' : ''} />
              </button>
              <button className="logs-footer__icon-btn" onClick={onCopy} title={t('logs.copy_visible')} aria-label={t('logs.copy_visible_aria')}>
                <Copy size={12} />
              </button>
              <button className="logs-footer__icon-btn" onClick={onClear} title={t('logs.clear')} aria-label={t('logs.clear_aria')}>
                <Trash2 size={12} />
              </button>
              <button className="logs-footer__icon-btn logs-footer__icon-btn--report" onClick={onReportIssue} title={t('logs.report_issue')} aria-label={t('logs.report_issue_aria')}>
                <Bug size={12} />
              </button>
              <button className="logs-footer__icon-btn" onClick={() => setCollapsed(true)} title={t('logs.close')} aria-label={t('logs.close_aria')}>
                <X size={12} />
              </button>
            </div>
          )}
          <button
            type="button"
            className={`logs-footer__version ${updateReady ? 'logs-footer__version--update' : ''}`}
            onClick={() => useAppStore.getState().openSettingsTab?.('updates')}
            title={updateReady
              ? t('logs.update_available', { version: updateVersion || '', defaultValue: 'Update available ({{version}}) — click to update' })
              : t('logs.version_updates', { defaultValue: 'Check for updates' })}
            aria-label={updateReady
              ? t('logs.update_available_aria', { version: updateVersion || '', defaultValue: 'Update available ({{version}}) — open updates' })
              : t('logs.version_updates_aria', { defaultValue: 'Open updates — app version {{v}}', v: APP_VERSION })}
          >
            v{APP_VERSION}
            {updateReady && <span className="logs-footer__version-dot" aria-hidden="true" />}
          </button>
          <NetworkToggle />
          <button
            type="button"
            className="logs-footer__discord"
            onClick={() => { import('../api/external').then(m => m.openExternal('https://discord.gg/bzQavDfVV9')); }}
            title={t('logs.join_discord')}
            aria-label={t('logs.join_discord_aria')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>
          </button>
          <button
            type="button"
            className="logs-footer__discord"
            onClick={() => useAppStore.getState().setMode?.('contact')}
            title={t('logs.contact', { defaultValue: 'Contact' })}
            aria-label={t('logs.contact_aria', { defaultValue: 'Open the contact page' })}
          >
            <Mail size={14} />
          </button>
          <button
            type="button"
            className="logs-footer__donate"
            onClick={() => useAppStore.getState().setMode?.('donate')}
            title={t('logs.support_project')}
            aria-label={t('logs.support_project_aria')}
          >
            <DonateHeart />
          </button>
        </div>
      </div>



      {!collapsed && active !== 'notifications' && (
        <div ref={scrollRef} className="logs-footer__body">
          {current.length === 0 && (
            <div className="logs-footer__empty">
              {active === 'frontend' ? t('logs.empty_frontend_short') : t('logs.empty_lines')}
            </div>
          )}
          {current.map((line, i) => {
            const level = classifyLine(line);
            return (
              <div key={i} className={`logs-footer__line logs-footer__line--${level}`}>
                <span className="logs-footer__line-icon"><SeverityIcon level={level} /></span>
                <pre className="logs-footer__line-text">{typeof line === 'string' ? line : JSON.stringify(line)}</pre>
              </div>
            );
          })}
        </div>
      )}

      {!collapsed && active === 'notifications' && (
        <div className="logs-footer__body logs-footer__notif-body">
          {notifications.length === 0 ? (
            <div className="logs-footer__empty">
              {t('logs.all_clear')}
            </div>
          ) : (
            notifications.map(notif => (
              <div
                key={notif.id}
                className={`logs-footer__notif-item logs-footer__notif-item--${notif.level} ${notif.action ? 'logs-footer__notif-item--clickable' : ''}`}
                onClick={() => {
                  if (!notif.action) return;
                  // Acting on the crash notice acknowledges it — the backend
                  // stores the seen crash-log size so it doesn't re-fire
                  // every session until a NEW crash grows the log.
                  if (notif.id === 'crash-last-session') {
                    import('../api/client')
                      .then(({ API }) => fetch(`${API}/system/crash/ack`, { method: 'POST' }))
                      .catch(() => {});
                  }
                  if (notif.action.type === 'navigate') {
                    useAppStore.getState().setMode?.(notif.action.target);
                    setCollapsed(true);
                  } else if (notif.action.type === 'link') {
                    import('../api/external').then(m => m.openExternal(notif.action.target));
                  }
                }}
                role={notif.action ? 'button' : undefined}
                tabIndex={notif.action ? 0 : undefined}
              >
                <span className="logs-footer__notif-icon">
                  <SeverityIcon level={notif.level} />
                </span>
                <div className="logs-footer__notif-content">
                  <strong>{notif.title}</strong>
                  <span className="logs-footer__notif-msg">{notif.message}</span>
                </div>
                {notif.action && (
                  <span className="logs-footer__notif-action">
                    {notif.action.label} →
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
