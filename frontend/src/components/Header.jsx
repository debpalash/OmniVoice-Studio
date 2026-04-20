import React, { useState } from 'react';
import { Globe, Fingerprint, Wand2, Film, RefreshCw, Settings2, ChevronRight, Zap } from 'lucide-react';

const VIEW_META = {
  launchpad: { label: 'Launchpad',       Icon: Globe,       accent: '#f3a5b6', kicker: 'Studio' },
  clone:     { label: 'Voice Clone',     Icon: Fingerprint, accent: '#d3869b', kicker: 'Studio' },
  design:    { label: 'Voice Design',    Icon: Wand2,       accent: '#8ec07c', kicker: 'Studio' },
  dub:       { label: 'Dubbing',         Icon: Film,        accent: '#fe8019', kicker: 'Studio' },
  settings:  { label: 'Settings',        Icon: Settings2,   accent: '#fabd2f', kicker: 'Preferences' },
};

function WaveBars({ color = '#f3a5b6', active }) {
  const heights = [4, 9, 5, 11, 6, 10, 5, 8];
  return (
    <div className="hq-wave" aria-hidden="true" style={{ opacity: active ? 1 : 0.35 }}>
      {heights.map((h, i) => (
        <span
          key={i}
          className={active ? 'hq-wave-bar active' : 'hq-wave-bar'}
          style={{
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
  mode, setMode, uiScale, setUiScale, sysStats, modelStatus, doubleClickMaximize,
  activeProjectName, onFlushMemory,
}) {
  const [flushing, setFlushing] = useState(false);
  const view = VIEW_META[mode] || VIEW_META.launchpad;
  const ViewIcon = view.Icon;
  return (
    <div
      className="header-area"
      data-tauri-drag-region
      onDoubleClick={doubleClickMaximize}
      style={{
        display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center',
        gridColumn: '1 / -1', gridRow: '1', cursor: 'default', paddingRight: '8px',
      }}
    >
      {/* Left: view title + breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', justifySelf: 'start', minWidth: 0 }}>
        <div style={{ minWidth: 80, flexShrink: 0 }} />
        <div className="hq-view-title">
          <span className="hq-view-dot" style={{ background: view.accent, boxShadow: `0 0 10px ${view.accent}90` }} />
          <span className="hq-view-kicker">{view.kicker}</span>
          <ChevronRight size={10} color="#504945" style={{ margin: '0 2px' }} />
          <span className="hq-view-label" style={{ color: view.accent }}>
            <ViewIcon size={12} style={{ marginRight: 4, verticalAlign: '-1px' }} />
            {view.label}
          </span>
          {activeProjectName ? (
            <>
              <ChevronRight size={10} color="#504945" style={{ margin: '0 2px' }} />
              <span className="hq-view-project" title={activeProjectName}>{activeProjectName}</span>
            </>
          ) : null}
        </div>
        {import.meta.env.DEV && (
          <button
            onClick={() => window.location.reload()}
            title="Force Reload UI"
            style={{
              display: 'flex', alignItems: 'center', gap: 4, background: 'transparent',
              border: '1px solid rgba(250,189,47,0.3)', color: '#fabd2f',
              padding: '3px 8px', borderRadius: 999, fontSize: '0.55rem', cursor: 'pointer', flexShrink: 0,
              fontFamily: 'Nunito, sans-serif', fontWeight: 700,
            }}
          >
            <RefreshCw size={9} /> Reload
          </button>
        )}
      </div>

      {/* Center: logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifySelf: 'center', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f3a5b6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(-6deg)' }}>
          <circle cx="12" cy="12" r="10" opacity="0.18" fill="#f3a5b6" />
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v12" />
          <path d="M8 9v6" />
          <path d="M16 9v6" />
        </svg>
        <span style={{
          fontSize: '1.05rem', fontWeight: 800, color: '#f7e7c3',
          letterSpacing: '-0.02em',
          fontFamily: 'Fraunces, Georgia, serif',
          fontStyle: 'italic',
        }}>
          Omni<span style={{ color: '#f3a5b6' }}>Voice</span>
        </span>
      </div>

      {/* Right: wave + UI scale + sys stats */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', justifySelf: 'end', minWidth: 0, overflow: 'hidden' }}>
        <WaveBars color={view.accent} active={modelStatus === 'ready' || modelStatus === 'loading'} />
        <div className="hq-scale" style={{ display: 'flex', gap: 2, background: 'rgba(0,0,0,0.28)', padding: 3, borderRadius: 999, border: '1px solid rgba(255,255,255,0.05)', flexShrink: 1 }}>
          {[{ v: 1, l: 'S' }, { v: 1.3, l: 'M' }, { v: 1.5, l: 'L' }].map(({ v, l }) => (
            <button
              key={l}
              onClick={() => setUiScale(v)}
              style={{
                fontFamily: 'Nunito, sans-serif',
                fontSize: '0.6rem', fontWeight: 800,
                padding: '2px 9px', border: 'none', borderRadius: 999, cursor: 'pointer',
                background: uiScale === v ? 'rgba(243,165,182,0.25)' : 'transparent',
                color: uiScale === v ? '#fff9ef' : '#7c6f64',
                whiteSpace: 'nowrap', transition: 'background 0.15s ease, color 0.15s ease',
              }}
            >
              {l}
            </button>
          ))}
        </div>
        {sysStats && (
          <div className="hq-stats" style={{ display: 'flex', gap: '8px', fontFamily: 'Nunito, sans-serif', fontSize: '0.58rem', color: '#7c6f64', background: 'rgba(0,0,0,0.28)', padding: '3px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.05)', whiteSpace: 'nowrap', flexShrink: 1, alignItems: 'center', overflow: 'hidden' }}>
            <span><b style={{ color: '#a89984', fontWeight: 500 }}>RAM</b> {sysStats.ram.toFixed(1)}/{sysStats.total_ram.toFixed(0)}G</span>
            <span><b style={{ color: '#a89984', fontWeight: 500 }}>CPU</b> {sysStats.cpu.toFixed(0)}%</span>
            <span style={{ borderLeft: '1px solid rgba(255,255,255,0.06)', paddingLeft: 5 }}>
              <b style={{ color: sysStats.gpu_active ? '#8ec07c' : '#a89984', fontWeight: 500 }}>VRAM</b> {sysStats.vram.toFixed(1)}G
            </span>
            <span style={{ borderLeft: '1px solid rgba(255,255,255,0.06)', paddingLeft: 5, display: 'flex', alignItems: 'center', gap: 3 }}>
              <span
                style={{
                  width: 5, height: 5, borderRadius: '50%', display: 'inline-block',
                  background: modelStatus === 'ready' ? '#8ec07c' : modelStatus === 'loading' ? '#fabd2f' : '#504945',
                  boxShadow: modelStatus === 'loading' ? '0 0 4px rgba(250,189,47,0.4)' : 'none',
                  animation: modelStatus === 'loading' ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }}
              />
              <span style={{ color: modelStatus === 'ready' ? '#8ec07c' : modelStatus === 'loading' ? '#fabd2f' : '#504945' }}>
                {modelStatus === 'ready' ? 'Ready' : modelStatus === 'loading' ? 'Loading…' : 'Idle'}
              </span>
            </span>
            {onFlushMemory && (
              <button
                title="Flush RAM/VRAM caches. Alt+Click to also unload model."
                disabled={flushing}
                onClick={async (e) => {
                  setFlushing(true);
                  try { await onFlushMemory(e.altKey); } finally { setFlushing(false); }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 2, padding: '1px 6px',
                  background: flushing ? 'rgba(250,189,47,0.15)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${flushing ? 'rgba(250,189,47,0.3)' : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: 999, cursor: flushing ? 'wait' : 'pointer',
                  color: flushing ? '#fabd2f' : '#7c6f64', fontSize: '0.55rem', fontWeight: 700,
                  fontFamily: 'Nunito, sans-serif', transition: 'all 0.15s ease',
                  marginLeft: 2,
                }}
              >
                <Zap size={8} style={flushing ? { animation: 'pulse 0.8s ease-in-out infinite' } : {}} />
                {flushing ? '…' : 'Flush'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
