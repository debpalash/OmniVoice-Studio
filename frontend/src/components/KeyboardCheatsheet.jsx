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
      background: 'var(--chrome-hover-bg)',
      border: '1px solid var(--chrome-border-strong)',
      borderRadius: 'var(--chrome-radius-pill)',
      color: 'var(--chrome-fg)',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.7rem', fontWeight: 500,
      boxShadow: 'none',
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
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'none', WebkitBackdropFilter: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 90vw)', maxHeight: '82vh', overflow: 'auto',
          padding: 22,
          background: 'var(--chrome-bg)',
          border: '1px solid var(--chrome-border-strong)',
          borderRadius: 'var(--chrome-radius-pill)',
          boxShadow: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Command size={16} color="var(--chrome-accent)" />
            <h2 style={{
              margin: 0, fontFamily: 'var(--font-serif)', fontStyle: 'italic',
              fontWeight: 400, fontSize: '1.5rem', color: 'var(--chrome-fg)',
              letterSpacing: '-0.01em',
            }}>
              Keyboard shortcuts
            </h2>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--chrome-fg-muted)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18 }}>
          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontWeight: 600,
                fontSize: 'var(--chrome-label-size)',
                textTransform: 'uppercase', letterSpacing: 'var(--chrome-label-track)',
                color: 'var(--chrome-fg-muted)', marginBottom: 10, paddingBottom: 6,
                borderBottom: '1px solid var(--chrome-border)',
              }}>{sec.title}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sec.items.map(([keys, desc]) => (
                  <div key={keys} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontFamily: 'var(--font-sans)' }}>
                    <span style={{ color: 'var(--chrome-fg-muted)', fontSize: '0.8rem' }}>{desc}</span>
                    <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                      {keys.split(' / ').map((group, i, arr) => (
                        <React.Fragment key={group}>
                          <span style={{ display: 'flex', gap: 2 }}>
                            {group.split('+').map((k) => <Kbd key={k}>{k}</Kbd>)}
                          </span>
                          {i < arr.length - 1 && <span style={{ color: 'var(--chrome-fg-dim)', alignSelf: 'center', fontSize: '0.7rem' }}>or</span>}
                        </React.Fragment>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18, textAlign: 'center', color: 'var(--chrome-fg-dim)', fontFamily: 'var(--font-sans)', fontSize: '0.72rem' }}>
          Press <Kbd>?</Kbd> any time to open this.
        </div>
      </div>
    </div>
  );
}
