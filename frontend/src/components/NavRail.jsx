import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Globe,
  Fingerprint,
  Film,
  FolderOpen,
  Settings2,
  ArrowLeftRight,
  Library,
  FileText,
  BookOpen,
  BookMarked,
} from 'lucide-react';

const ITEM_DEFS = [
  { id: 'launchpad', Icon: Globe, tKey: 'launchpad', accent: '#f3a5b6' },
  { id: 'studio', Icon: Fingerprint, tKey: 'voice', accent: '#d3869b' },
  { id: 'dub', Icon: Film, tKey: 'dub', accent: '#fe8019' },
  { id: 'stories', Icon: BookOpen, tKey: 'stories', accent: '#fabd2f' },
  { id: 'audiobook', Icon: BookMarked, tKey: 'audiobook', accent: '#8ec07c' },
  { id: 'gallery', Icon: Library, tKey: 'gallery', accent: '#b8bb26' },
  { id: 'transcriptions', Icon: FileText, tKey: 'transcripts', accent: '#d3869b' },
  { id: 'projects', Icon: FolderOpen, tKey: 'omnidrive', accent: '#83a598' },
];
const FOOTER_DEFS = [{ id: 'settings', Icon: Settings2, tKey: 'settings', accent: '#fabd2f' }];

// Shared icon-button base for the chrome rail (was `.rail-btn`). `group` enables
// the hover-reveal of the per-button tooltip label below.
const RAIL_BTN_BASE =
  'group relative inline-flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-[var(--chrome-radius-pill)] [transition:background_0.14s,color_0.14s,border-color_0.14s]';

// Hover-reveal tooltip label (was `.rail-btn .rail-label`); flips to the opposite
// edge when the rail sits on the right.
function railLabelCls(side) {
  const sideCls =
    side === 'right'
      ? 'left-auto right-[48px] [transform:translate(4px,-50%)]'
      : 'left-[46px] [transform:translate(-4px,-50%)]';
  return `pointer-events-none absolute top-1/2 z-[10000] whitespace-nowrap rounded-[var(--chrome-radius-pill)] bg-[var(--chrome-bg)] px-[8px] py-[3px] font-sans text-[11px] font-medium text-[var(--chrome-fg)] opacity-0 [border:1px_solid_var(--chrome-border-strong)] [transition:opacity_0.15s,transform_0.15s] group-hover:opacity-100 group-hover:[transform:translate(0,-50%)] ${sideCls}`;
}

function RailBtn({ active, Icon, label, accent, side, onClick }) {
  // Active = accent-tinted fill/border + an accent indicator bar (`::before`)
  // hanging off the rail edge; flips edges with the rail side.
  const stateCls = active
    ? `text-[var(--rail-accent,var(--chrome-accent))] bg-[color-mix(in_srgb,var(--rail-accent,var(--chrome-accent))_12%,transparent)] [border:1px_solid_color-mix(in_srgb,var(--rail-accent,var(--chrome-accent))_35%,transparent)] before:absolute before:top-[20%] before:bottom-[20%] before:w-[3px] before:rounded-[2px] before:bg-[var(--rail-accent,#f3a5b6)] before:content-[''] before:[box-shadow:0_0_10px_color-mix(in_srgb,var(--rail-accent,#f3a5b6)_50%,transparent)] ${
        side === 'right' ? 'before:right-[-8px]' : 'before:left-[-8px]'
      }`
    : 'bg-transparent text-[var(--chrome-fg-dim)] [border:1px_solid_transparent] hover:bg-[var(--chrome-hover-bg)] hover:text-[var(--chrome-fg)]';
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`${RAIL_BTN_BASE} ${stateCls}`}
      style={{ '--rail-accent': accent }}
    >
      <Icon size={18} />
      <span className={railLabelCls(side)}>{label}</span>
    </button>
  );
}

export default function NavRail({ mode, setMode, side = 'left', onFlipSide }) {
  const { t } = useTranslation();
  const items = React.useMemo(
    () => ITEM_DEFS.map((d) => ({ ...d, label: t(`nav.${d.tKey}`) })),
    [t],
  );
  const footerItems = React.useMemo(
    () => FOOTER_DEFS.map((d) => ({ ...d, label: t(`nav.${d.tKey}`) })),
    [t],
  );

  // `nav-rail` is retained purely as the layout hook the (out-of-scope)
  // `.app-container > .nav-rail` grid rules position by; all visual styling now
  // lives in the utilities below. Border flips to the inner edge when on the right.
  const asideBorder =
    side === 'right'
      ? '[border-left:1px_solid_var(--chrome-border)]'
      : '[border-right:1px_solid_var(--chrome-border)]';

  return (
    <aside
      className={`nav-rail z-50 flex select-none flex-col items-center gap-[6px] bg-[var(--chrome-bg)] py-[8px] ${asideBorder}`}
    >
      <div className="flex flex-1 flex-col items-center gap-[4px]">
        {items.map((it) => (
          <RailBtn
            key={it.id}
            {...it}
            side={side}
            active={mode === it.id}
            onClick={() => setMode(it.id)}
          />
        ))}
      </div>
      <div className="flex flex-col items-center gap-[4px]">
        {footerItems.map((it) => (
          <RailBtn
            key={it.id}
            {...it}
            side={side}
            active={mode === it.id}
            onClick={() => setMode(it.id)}
          />
        ))}
        <button
          onClick={onFlipSide}
          title={side === 'left' ? t('nav.move_rail_right') : t('nav.move_rail_left')}
          aria-label={t('nav.flip_rail')}
          className="relative mt-[6px] inline-flex h-[30px] w-[36px] cursor-pointer items-center justify-center rounded-none bg-transparent pt-[10px] text-[var(--chrome-fg-dim)] [border-top:1px_solid_var(--chrome-border)] [border-right:1px_solid_transparent] [border-bottom:1px_solid_transparent] [border-left:1px_solid_transparent] [transition:background_0.14s,color_0.14s,border-color_0.14s] hover:bg-transparent hover:text-[var(--chrome-accent)] hover:[transform:rotate(180deg)]"
        >
          <ArrowLeftRight size={15} />
        </button>
      </div>
    </aside>
  );
}
