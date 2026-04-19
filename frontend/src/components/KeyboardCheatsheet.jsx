import React from 'react';
import { Command, X } from 'lucide-react';

const SECTIONS = [
  {
    title: 'Navigation',
    items: [
      ['?', 'Show this cheatsheet'],
      ['Esc', 'Close modal / cancel'],
      ['Cmd/Ctrl+S', 'Save project / commit trim'],
    ],
  },
  {
    title: 'Segment editor',
    items: [
      ['Cmd/Ctrl+D', 'Split segment at cursor'],
      ['Cmd/Ctrl+M', 'Merge with next segment'],
      ['Cmd/Ctrl+Z', 'Undo'],
      ['Cmd/Ctrl+Shift+Z', 'Redo'],
      ['Click row', 'Primary action'],
      ['Shift+click row', 'Range select'],
    ],
  },
  {
    title: 'Audio trimmer',
    items: [
      ['Space', 'Preview play / pause'],
      ['← / →', 'Nudge start handle'],
      ['Ctrl+← / →', 'Nudge end handle'],
      ['Shift+arrow', 'Fine nudge'],
      ['Alt+arrow', 'Coarse nudge'],
      ['+ / −', 'Zoom in / out'],
      ['Home / End', 'Fit all / Fit selection'],
      ['Enter', 'Confirm trim'],
    ],
  },
  {
    title: 'Dub',
    items: [
      ['Cmd/Ctrl+Enter', 'Generate dub'],
      ['Cmd/Ctrl+B', 'Toggle sidebar'],
    ],
  },
];

function Kbd({ children }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      padding: '2px 8px',
      minWidth: 28, height: 22,
      background: 'rgba(0,0,0,0.35)',
      border: '1px solid rgba(243,165,182,0.25)',
      borderRadius: 6,
      color: '#f5e6c5',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '0.68rem', fontWeight: 700,
      boxShadow: '0 2px 0 rgba(0,0,0,0.25)',
    }}>
      {children}
    </span>
  );
}

export default function KeyboardCheatsheet({ open, onClose }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'radial-gradient(circle at 30% 20%, rgba(243,165,182,0.08) 0%, rgba(0,0,0,0.82) 60%)',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 90vw)', maxHeight: '82vh', overflow: 'auto',
          padding: 22,
          background: 'linear-gradient(160deg, rgba(47,41,39,0.98), rgba(38,33,31,0.98))',
          border: '1px solid rgba(243,165,182,0.2)',
          borderRadius: '18px 22px 16px 24px / 20px 16px 22px 18px',
          boxShadow: '0 22px 50px -18px rgba(0,0,0,0.6), 0 0 0 1px rgba(243,165,182,0.08)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Command size={18} color="#f3a5b6" />
            <h2 style={{
              margin: 0, fontFamily: 'Fraunces, Georgia, serif',
              fontWeight: 700, fontSize: '1.3rem', color: '#f5e6c5',
            }}>
              Keyboard shortcuts
            </h2>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#a89984', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18 }}>
          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <div style={{
                fontFamily: 'Nunito, sans-serif', fontWeight: 800, fontSize: '0.62rem',
                textTransform: 'uppercase', letterSpacing: '0.14em',
                color: '#d3869b', marginBottom: 10, paddingBottom: 6,
                borderBottom: '1px dashed rgba(243,165,182,0.15)',
              }}>{sec.title}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sec.items.map(([keys, desc]) => (
                  <div key={keys} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontFamily: 'Nunito, sans-serif' }}>
                    <span style={{ color: '#a89984', fontSize: '0.78rem' }}>{desc}</span>
                    <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                      {keys.split(' / ').map((group, i, arr) => (
                        <React.Fragment key={group}>
                          <span style={{ display: 'flex', gap: 2 }}>
                            {group.split('+').map((k) => <Kbd key={k}>{k}</Kbd>)}
                          </span>
                          {i < arr.length - 1 && <span style={{ color: '#665c54', alignSelf: 'center', fontSize: '0.7rem' }}>or</span>}
                        </React.Fragment>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18, textAlign: 'center', color: '#6b6657', fontFamily: 'Nunito, sans-serif', fontSize: '0.7rem' }}>
          Press <Kbd>?</Kbd> any time to open this.
        </div>
      </div>
    </div>
  );
}
