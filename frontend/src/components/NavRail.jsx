import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Globe, Fingerprint, Film, FolderOpen, Settings2, ArrowLeftRight,
  Library, FileText, BookOpen, BookMarked,
} from 'lucide-react';

const ITEM_DEFS = [
  { id: 'launchpad',     Icon: Globe,       tKey: 'launchpad',   accent: '#f3a5b6' },
  { id: 'studio',        Icon: Fingerprint, tKey: 'voice',       accent: '#d3869b' },
  { id: 'dub',           Icon: Film,        tKey: 'dub',         accent: '#fe8019' },
  { id: 'stories',       Icon: BookOpen,    tKey: 'stories',     accent: '#fabd2f' },
  { id: 'audiobook',     Icon: BookMarked,  tKey: 'audiobook',   accent: '#8ec07c' },
  { id: 'gallery',       Icon: Library,     tKey: 'gallery',     accent: '#b8bb26' },
  { id: 'transcriptions',Icon: FileText,    tKey: 'transcripts', accent: '#d3869b' },
  { id: 'projects',      Icon: FolderOpen,  tKey: 'omnidrive',   accent: '#83a598' },
];
const FOOTER_DEFS = [
  { id: 'settings', Icon: Settings2, tKey: 'settings', accent: '#fabd2f' },
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
  const items = React.useMemo(() =>
    ITEM_DEFS.map(d => ({ ...d, label: t(`nav.${d.tKey}`) })), [t]);
  const footerItems = React.useMemo(() =>
    FOOTER_DEFS.map(d => ({ ...d, label: t(`nav.${d.tKey}`) })), [t]);

  return (
    <aside className={`nav-rail rail-${side}`}>
      <div className="rail-top">
        {items.map((it) => (
          <RailBtn key={it.id} {...it} active={mode === it.id} onClick={() => setMode(it.id)} />
        ))}
      </div>
      <div className="rail-bottom">
        {/* Quiet "Support" pill — warms to the accent on hover, opens the
            donate page. Sits with the footer nav (Settings / flip). (#007) */}
        <button
          onClick={() => setMode('donate')}
          title={t('donate.pill', { defaultValue: 'Support OmniVoice' })}
          aria-label={t('donate.pill', { defaultValue: 'Support OmniVoice' })}
          className={`rail-btn donate-pill ${mode === 'donate' ? 'active' : ''}`}
        >
          <span className="donate-pill__heart" aria-hidden="true">🩷</span>
          <span className="rail-label">{t('donate.pill', { defaultValue: 'Support OmniVoice' })}</span>
        </button>
        {footerItems.map((it) => (
          <RailBtn key={it.id} {...it} active={mode === it.id} onClick={() => setMode(it.id)} />
        ))}
        <button
          onClick={onFlipSide}
          title={side === 'left' ? t('nav.move_rail_right') : t('nav.move_rail_left')}
          aria-label={t('nav.flip_rail')}
          className="rail-btn rail-flip"
        >
          <ArrowLeftRight size={15} />
        </button>
      </div>
    </aside>
  );
}
