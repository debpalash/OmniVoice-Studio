import React from 'react';
import { Command, X } from 'lucide-react';
import './KeyboardCheatsheet.css';

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
  return <span className="kcs-kbd">{children}</span>;
}

export default function KeyboardCheatsheet({ open, onClose }) {
  if (!open) return null;
  return (
    <div onClick={onClose} className="kcs-overlay">
      <div onClick={(e) => e.stopPropagation()} className="kcs-panel">
        <div className="kcs-header">
          <div className="kcs-header__left">
            <Command size={16} color="var(--chrome-accent)" />
            <h2 className="kcs-title">Keyboard shortcuts</h2>
          </div>
          <button onClick={onClose} className="kcs-close">
            <X size={16} />
          </button>
        </div>

        <div className="kcs-grid">
          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <div className="kcs-section-title">{sec.title}</div>
              <div className="kcs-items">
                {sec.items.map(([keys, desc]) => (
                  <div key={keys} className="kcs-row">
                    <span className="kcs-desc">{desc}</span>
                    <span className="kcs-keys">
                      {keys.split(' / ').map((group, i, arr) => (
                        <React.Fragment key={group}>
                          <span className="kcs-key-group">
                            {group.split('+').map((k) => <Kbd key={k}>{k}</Kbd>)}
                          </span>
                          {i < arr.length - 1 && <span className="kcs-or">or</span>}
                        </React.Fragment>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="kcs-footer">
          Press <Kbd>?</Kbd> any time to open this.
        </div>
      </div>
    </div>
  );
}
