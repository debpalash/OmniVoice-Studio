import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Globe, Fingerprint, Wand2, Film, FolderOpen, RefreshCw, Settings2, ChevronRight, ChevronDown, Zap, Building2, Library, FileText, Trash2 } from 'lucide-react';
import { Button, Badge } from '../ui';
import NotificationPanel from './NotificationPanel';

const VIEW_META = {
  launchpad:  { label: 'Launchpad',       Icon: Globe,       accent: '#f3a5b6', kicker: 'Studio' },
  clone:      { label: 'Voice Clone',     Icon: Fingerprint, accent: '#d3869b', kicker: 'Studio' },
  design:     { label: 'Voice Design',    Icon: Wand2,       accent: '#8ec07c', kicker: 'Studio' },
  dub:        { label: 'Dubbing',         Icon: Film,        accent: '#fe8019', kicker: 'Studio' },
  projects:   { label: 'OmniDrive',      Icon: FolderOpen,  accent: '#83a598', kicker: 'Library' },
  gallery:    { label: 'Gallery',         Icon: Library,     accent: '#b8bb26', kicker: 'Library' },
  transcriptions: { label: 'Transcriptions', Icon: FileText, accent: '#d3869b', kicker: 'Library' },
  settings:   { label: 'Settings',        Icon: Settings2,   accent: '#fabd2f', kicker: 'Preferences' },
  enterprise: { label: 'Commercial License', Icon: Building2, accent: '#fe8019', kicker: 'Licensing' },
};

function WaveBars({ color = '#f3a5b6', active }) {
  const heights = [4, 9, 5, 11, 6, 10, 5, 8];
  return (
    <div className={`hq-wave ${active ? 'is-active' : ''}`} aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className={active ? 'hq-wave-bar active' : 'hq-wave-bar'}
          style={{
            // Height + color are per-instance; animation-delay is per-bar.
            // These three are genuinely dynamic so stay inline.
            height: h,
            background: color,
            animationDelay: `${i * 0.08}s`,
          }}
        />
      ))}
    </div>
  );
}

export default function Header({
  mode, setMode, sysStats, modelStatus, doubleClickMaximize,
  activeProjectName, onFlushMemory,
}) {
  const [flushing, setFlushing] = useState(false);
  const [flushOpen, setFlushOpen] = useState(false);
  const [loadedModels, setLoadedModels] = useState([]);
  const [unloading, setUnloading] = useState(null);
  const flushRef = useRef(null);
  const flushBtnRef = useRef(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

  // Dynamically compute dropdown position from button rect
  const computePos = useCallback(() => {
    if (!flushBtnRef.current) return;
    const rect = flushBtnRef.current.getBoundingClientRect();
    const dropW = 260;
    const dropH = 220; // approximate max height
    const pad = 6;

    // Default: below button, right-aligned
    let top = rect.bottom + pad;
    let left = rect.right - dropW;

    // Flip up if too close to bottom
    if (top + dropH > window.innerHeight - 10) {
      top = rect.top - dropH - pad;
    }
    // Clamp left so it doesn't go off-screen
    if (left < 8) left = 8;
    if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8;

    setDropdownPos({ top, left });
  }, []);

  // Recompute on open, resize, and scroll
  useEffect(() => {
    if (!flushOpen) return;
    computePos();
    window.addEventListener('resize', computePos);
    window.addEventListener('scroll', computePos, true);
    return () => {
      window.removeEventListener('resize', computePos);
      window.removeEventListener('scroll', computePos, true);
    };
  }, [flushOpen, computePos]);
  const view = VIEW_META[mode] || VIEW_META.launchpad;
  const ViewIcon = view.Icon;

  // Fetch loaded models when dropdown opens
  useEffect(() => {
    if (!flushOpen) return;
    const fetchModels = async () => {
      try {
        const { API } = await import('../api/client');
        const res = await fetch(`${API}/model/loaded`);
        if (res.ok) {
          const data = await res.json();
          setLoadedModels(data.models || []);
        }
      } catch {}
    };
    fetchModels();
  }, [flushOpen]);

  // Click outside to close (must check both the button wrapper AND the portal dropdown)
  const dropdownRef = useRef(null);
  useEffect(() => {
    if (!flushOpen) return;
    const handler = (e) => {
      const inBtn = flushRef.current && flushRef.current.contains(e.target);
      const inDrop = dropdownRef.current && dropdownRef.current.contains(e.target);
      if (!inBtn && !inDrop) setFlushOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [flushOpen]);

  const unloadModel = async (modelId) => {
    setUnloading(modelId);
    try {
      const { API } = await import('../api/client');
      const res = await fetch(`${API}/model/unload/${modelId}`, { method: 'POST' });
      if (res.ok) {
        setLoadedModels(prev => prev.filter(m => m.id !== modelId));
      }
    } catch {} finally {
      setUnloading(null);
    }
  };
  // Dynamic accent color must stay inline — it's driven by the current view.
  const dotStyle   = { background: view.accent, boxShadow: `0 0 10px ${view.accent}90` };
  const labelStyle = { color: view.accent };
  return (
    <div
      className="header-area"
      data-tauri-drag-region
      onDoubleClick={doubleClickMaximize}
    >
      {/* Left: view title + breadcrumb */}
      <div className="hq-col-left">
        <div className="hq-col-left__spacer" />
        <div className="hq-view-title">
          <span className="hq-view-dot" style={dotStyle} />
          <span className="hq-view-kicker">{view.kicker}</span>
          <ChevronRight size={10} color="#504945" className="hq-breadcrumb-sep" />
          <span className="hq-view-label" style={labelStyle}>
            <ViewIcon size={12} className="hq-view-icon" />
            {view.label}
          </span>
          {activeProjectName ? (
            <>
              <ChevronRight size={10} color="#504945" className="hq-breadcrumb-sep" />
              <span className="hq-view-project" title={activeProjectName}>{activeProjectName}</span>
            </>
          ) : null}
        </div>
        {import.meta.env.DEV && (
          <Button
            variant="ghost"
            size="sm"
            title="Force Reload UI"
            onClick={() => window.location.reload()}
            leading={<RefreshCw size={9} />}
            className="hq-reload-btn"
          >
            Reload
          </Button>
        )}
      </div>

      {/* Center: logo */}
      <div className="hq-col-center">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f3a5b6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="hq-logo-mark">
          <circle cx="12" cy="12" r="10" opacity="0.18" fill="#f3a5b6" />
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v12" />
          <path d="M8 9v6" />
          <path d="M16 9v6" />
        </svg>
        <span className="hq-logo-word">
          Omni<span className="hq-logo-word__accent">Voice</span>
        </span>
      </div>

      {/* Right: wave + sys stats. UI scale (S/M/L) lives in the bottom
          LogsFooter bar so all app-wide chrome sits together. */}
      <div className="hq-col-right">
        <NotificationPanel onNavigate={setMode} />
        <WaveBars color={view.accent} active={modelStatus === 'ready' || modelStatus === 'loading'} />
        {sysStats && (
          <div className="hq-stats">
            <span><b className="hq-stats__key">RAM</b> {sysStats.ram.toFixed(1)}/{sysStats.total_ram.toFixed(0)}G</span>
            <span><b className="hq-stats__key">CPU</b> {sysStats.cpu.toFixed(0)}%</span>
            <span className="hq-stats__sep" aria-label={`VRAM usage: ${sysStats.vram.toFixed(1)} gigabytes`}>
              <b className={`hq-stats__key ${sysStats.gpu_active ? 'hq-stats__key--gpu-active' : ''}`}>VRAM</b> {sysStats.vram.toFixed(1)}G
            </span>
            <span className="hq-stats__status-wrap">
              <Badge
                tone={modelStatus === 'ready' ? 'success' : modelStatus === 'loading' ? 'warn' : 'neutral'}
                size="xs"
                dot
                className={`hq-stats__status-badge ${modelStatus === 'loading' ? 'ui-badge--pulse' : ''}`}
              >
                {modelStatus === 'ready' ? 'Ready' : modelStatus === 'loading' ? 'Loading…' : 'Idle'}
              </Badge>
            </span>
            {onFlushMemory && (
              <div ref={flushRef} style={{ position: 'relative' }}>
                <Button
                  ref={flushBtnRef}
                  variant="subtle"
                  size="sm"
                  title="Memory management"
                  loading={flushing}
                  leading={!flushing && <Zap size={8} />}
                  trailing={<ChevronDown size={8} />}
                  onClick={() => setFlushOpen(o => !o)}
                  className="hq-flush-btn"
                >
                  Flush
                </Button>
                {flushOpen && createPortal(
                  <div
                    className="hq-flush-dropdown"
                    style={{ top: dropdownPos.top, left: dropdownPos.left }}
                    ref={dropdownRef}
                  >
                    <div className="hq-flush-dropdown__header">Loaded Models</div>
                    {loadedModels.length === 0 ? (
                      <div className="hq-flush-dropdown__empty">No models loaded</div>
                    ) : (
                      loadedModels.map(m => (
                        <div key={m.id} className="hq-flush-dropdown__item">
                          <div className="hq-flush-dropdown__info">
                            <span className="hq-flush-dropdown__name">{m.name}</span>
                            <span className="hq-flush-dropdown__meta">
                              {m.device} {m.vram_mb > 0 ? `· ${m.vram_mb.toFixed(0)} MB` : ''}
                            </span>
                          </div>
                          {m.unloadable && (
                            <button
                              className="hq-flush-dropdown__unload"
                              onClick={() => unloadModel(m.id)}
                              disabled={unloading === m.id}
                              aria-label={`Unload ${m.name}`}
                            >
                              {unloading === m.id ? '…' : 'Unload'}
                            </button>
                          )}
                        </div>
                      ))
                    )}
                    <div className="hq-flush-dropdown__divider" />
                    <button
                      className="hq-flush-dropdown__action"
                      onClick={async () => {
                        setFlushing(true);
                        setFlushOpen(false);
                        try { await onFlushMemory(false); } finally { setFlushing(false); }
                      }}
                    >
                      <Zap size={10} /> Flush caches
                    </button>
                    <button
                      className="hq-flush-dropdown__action hq-flush-dropdown__action--danger"
                      onClick={async () => {
                        setFlushing(true);
                        setFlushOpen(false);
                        try { await onFlushMemory(true); } finally { setFlushing(false); }
                      }}
                    >
                      <Trash2 size={10} /> Unload all + flush
                    </button>
                  </div>,
                  document.body
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
