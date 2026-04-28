import React from 'react';
import {
  Globe, Fingerprint, Wand2, Film, FolderOpen, Settings2, ArrowLeftRight,
  Library, FileText,
} from 'lucide-react';

const ITEMS = [
  { id: 'launchpad', label: 'Launchpad', Icon: Globe,       accent: '#f3a5b6' },
  { id: 'clone',     label: 'Clone',     Icon: Fingerprint, accent: '#d3869b' },
  { id: 'design',    label: 'Design',    Icon: Wand2,       accent: '#8ec07c' },
  { id: 'dub',       label: 'Dub',       Icon: Film,        accent: '#fe8019' },
  { id: 'gallery',   label: 'Gallery',   Icon: Library,     accent: '#b8bb26' },
  { id: 'transcriptions', label: 'Transcripts', Icon: FileText, accent: '#d3869b' },
  { id: 'projects',  label: 'OmniDrive',  Icon: FolderOpen,  accent: '#83a598' },
];
const FOOTER_ITEMS = [
  { id: 'settings', label: 'Settings', Icon: Settings2, accent: '#fabd2f' },
];

function RailBtn({ active, Icon, label, accent, onClick }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rail-btn ${active ? 'active' : ''}`}
      style={{ '--rail-accent': accent }}
    >
      <Icon size={18} />
      <span className="rail-label">{label}</span>
    </button>
  );
}

export default function NavRail({ mode, setMode, side = 'left', onFlipSide }) {
  return (
    <aside className={`nav-rail rail-${side}`}>
      <div className="rail-top">
        {ITEMS.map((it) => (
          <RailBtn key={it.id} {...it} active={mode === it.id} onClick={() => setMode(it.id)} />
        ))}
      </div>
      <div className="rail-bottom">
        {FOOTER_ITEMS.map((it) => (
          <RailBtn key={it.id} {...it} active={mode === it.id} onClick={() => setMode(it.id)} />
        ))}
        <button
          onClick={onFlipSide}
          title={`Move rail to the ${side === 'left' ? 'right' : 'left'}`}
          aria-label="Flip rail side"
          className="rail-btn rail-flip"
        >
          <ArrowLeftRight size={15} />
        </button>
      </div>
    </aside>
  );
}
