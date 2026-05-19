import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Globe, Fingerprint, Wand2, Film, FolderOpen, Settings2, ArrowLeftRight,
  Library, FileText, BookOpen,
} from 'lucide-react';

const ITEMS = [
  { id: 'launchpad',       key: 'nav.launchpad',    Icon: Globe,       accent: '#f3a5b6' },
  { id: 'clone',           key: 'nav.clone',        Icon: Fingerprint, accent: '#d3869b' },
  { id: 'design',          key: 'nav.design',       Icon: Wand2,       accent: '#8ec07c' },
  { id: 'dub',             key: 'nav.dub',          Icon: Film,        accent: '#fe8019' },
  { id: 'stories',         key: 'nav.stories',      Icon: BookOpen,    accent: '#fabd2f' },
  { id: 'gallery',         key: 'nav.gallery',      Icon: Library,     accent: '#b8bb26' },
  { id: 'transcriptions',  key: 'nav.transcripts',  Icon: FileText,    accent: '#d3869b' },
  { id: 'projects',        key: 'nav.omnidrive',    Icon: FolderOpen,  accent: '#83a598' },
];
const FOOTER_ITEMS = [
  { id: 'settings', key: 'nav.settings', Icon: Settings2, accent: '#fabd2f' },
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
  const { t } = useTranslation();
  return (
    <aside className={`nav-rail rail-${side}`}>
      <div className="rail-top">
        {ITEMS.map((it) => (
          <RailBtn key={it.id} Icon={it.Icon} label={t(it.key)} accent={it.accent} active={mode === it.id} onClick={() => setMode(it.id)} />
        ))}
      </div>
      <div className="rail-bottom">
        {FOOTER_ITEMS.map((it) => (
          <RailBtn key={it.id} Icon={it.Icon} label={t(it.key)} accent={it.accent} active={mode === it.id} onClick={() => setMode(it.id)} />
        ))}
        <button
          onClick={onFlipSide}
          title={side === 'left' ? t('nav.flip_rail') : t('nav.flip_rail_alt')}
          aria-label={side === 'left' ? t('nav.flip_rail') : t('nav.flip_rail_alt')}
          className="rail-btn rail-flip"
        >
          <ArrowLeftRight size={15} />
        </button>
      </div>
    </aside>
  );
}
