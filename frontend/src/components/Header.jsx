import React, { useState } from 'react';
import { Globe, Fingerprint, Wand2, Film, FolderOpen, RefreshCw, Settings2, ChevronRight, Zap } from 'lucide-react';
import { Button, Badge } from '../ui';

const VIEW_META = {
  launchpad: { label: 'Launchpad',       Icon: Globe,       accent: '#f3a5b6', kicker: 'Studio' },
  clone:     { label: 'Voice Clone',     Icon: Fingerprint, accent: '#d3869b', kicker: 'Studio' },
  design:    { label: 'Voice Design',    Icon: Wand2,       accent: '#8ec07c', kicker: 'Studio' },
  dub:       { label: 'Dubbing',         Icon: Film,        accent: '#fe8019', kicker: 'Studio' },
  projects:  { label: 'Projects',        Icon: FolderOpen,  accent: '#83a598', kicker: 'Library' },
  settings:  { label: 'Settings',        Icon: Settings2,   accent: '#fabd2f', kicker: 'Preferences' },
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
  const view = VIEW_META[mode] || VIEW_META.launchpad;
  const ViewIcon = view.Icon;
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
        <WaveBars color={view.accent} active={modelStatus === 'ready' || modelStatus === 'loading'} />
        {sysStats && (
          <div className="hq-stats">
            <span><b className="hq-stats__key">RAM</b> {sysStats.ram.toFixed(1)}/{sysStats.total_ram.toFixed(0)}G</span>
            <span><b className="hq-stats__key">CPU</b> {sysStats.cpu.toFixed(0)}%</span>
            <span className="hq-stats__sep">
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
              <Button
                variant="subtle"
                size="sm"
                title="Flush RAM/VRAM caches. Alt+Click to also unload model."
                loading={flushing}
                leading={!flushing && <Zap size={8} />}
                onClick={async (e) => {
                  setFlushing(true);
                  try { await onFlushMemory(e.altKey); } finally { setFlushing(false); }
                }}
                className="hq-flush-btn"
              >
                Flush
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
