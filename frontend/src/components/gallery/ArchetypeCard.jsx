import React from 'react';
import { Play, Loader, Star, Wand2, UserPlus } from 'lucide-react';
import {
  ArchetypeAvatar,
  AccentFlag,
  NowPlaying,
  USE_CASE_COLOR,
} from '../../utils/archetypeIcons';
import { facetLabel } from './constants';

// ── Archetype card ───────────────────────────────────────────────────────────
export default function ArchetypeCard({
  a,
  t,
  isFavorite,
  isPlaying,
  isLoadingPreview,
  onPreview,
  onUse,
  onDesign,
  onToggleFavorite,
}) {
  const color = USE_CASE_COLOR[a.use_case] || '#83a598';
  const sub = [a.facets.gender, a.facets.age, a.facets.pitch]
    .filter(Boolean)
    .map(facetLabel)
    .join(' · ');
  const dialect =
    a.attrs?.ChineseDialect && a.attrs.ChineseDialect !== 'Auto' ? a.attrs.ChineseDialect : null;
  const accentLabel = a.facets.accent
    ? facetLabel(a.facets.accent)
    : dialect || (a.language === 'Chinese' ? 'Chinese' : null);
  const hasChips = Boolean(accentLabel || a.facets.whisper);

  // Borderless by direction: the card keeps a transparent border only to reserve
  // the box width; the playing state is conveyed by an accent ring (box-shadow)
  // + lift, never a literal border.
  const cardBase =
    'group relative flex flex-col gap-[11px] p-[14px] rounded-[13px] border border-transparent ' +
    'bg-[linear-gradient(180deg,rgba(255,255,255,0.038),rgba(255,255,255,0.012))] ' +
    'transition-[transform,box-shadow] duration-150 ' +
    'hover:-translate-y-[2px] hover:shadow-[0_6px_22px_rgba(0,0,0,0.4)] ' +
    'motion-reduce:transition-none motion-reduce:hover:translate-y-0';
  const cardState = isPlaying
    ? 'shadow-[0_0_0_1px_var(--card-accent),0_6px_22px_rgba(0,0,0,0.4)]'
    : '';

  return (
    <div className={`${cardBase} ${cardState}`} style={{ '--card-accent': color }}>
      {/* Header — the name is the focal point; metadata recedes (smaller, muted). */}
      <div className="flex items-center gap-[11px]">
        <ArchetypeAvatar item={a} />
        <div className="flex-1 min-w-0">
          <div className="text-[0.86rem] font-semibold leading-tight text-[var(--color-fg)] truncate">
            {a.name}
          </div>
          {sub && (
            <div className="text-[0.66rem] text-[var(--color-fg-muted)] mt-[3px] truncate">
              {sub}
            </div>
          )}
        </div>
        <button
          className={`flex-shrink-0 flex items-center justify-center w-[26px] h-[26px] rounded-[7px] cursor-pointer transition-[color,background-color,opacity] hover:bg-[var(--chrome-hover-bg)] ${
            isFavorite
              ? 'text-[#fabd2f]'
              : 'text-[var(--color-fg-subtle)] opacity-70 group-hover:opacity-100 hover:text-[#fabd2f]'
          }`}
          onClick={() => onToggleFavorite(a.id)}
          title={t('gallery.favorite', { defaultValue: 'Favorite' })}
        >
          <Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
      </div>

      {/* Chips only render when present — no empty reserved row. Cards without
          chips stay compact; the grid stretches each row to equal height so the
          `mt-auto` action row still bottom-aligns across the grid. */}
      {hasChips && (
        <div className="flex flex-wrap items-center gap-[5px]">
          {accentLabel && (
            <span className="inline-flex items-center gap-[5px] pl-[5px] pr-[8px] py-[2px] rounded-[7px] bg-[var(--color-bg-elev-2)] text-[var(--color-fg-muted)] text-[0.64rem] leading-[1.6]">
              <AccentFlag accent={a.facets.accent} lang={a.language} size={14} />
              {accentLabel}
            </span>
          )}
          {a.facets.whisper && (
            <span className="inline-flex items-center gap-[5px] px-[8px] py-[2px] rounded-[7px] bg-[var(--color-bg-elev-2)] text-[var(--color-fg-muted)] text-[0.64rem] leading-[1.6]">
              {t('archetypes.facet_whisper', { defaultValue: 'Whisper' })}
            </span>
          )}
        </div>
      )}

      {/* Actions — quiet Preview (ghost, token hover), confident accent Use voice
          (tinted → solid accent with inverse text), subtle magic-wand icon. */}
      <div className="flex items-center gap-[6px] mt-auto">
        <button
          className="inline-flex items-center gap-[6px] px-[11px] py-[6px] rounded-[8px] bg-transparent text-[var(--color-fg-muted)] text-[0.7rem] cursor-pointer transition-colors hover:bg-[var(--chrome-hover-bg)] hover:text-[var(--color-fg)]"
          onClick={() => onPreview(a)}
          title={t('gallery.preview', { defaultValue: 'Preview' })}
        >
          {isLoadingPreview ? (
            <Loader className="spin" size={15} />
          ) : isPlaying ? (
            <NowPlaying color={color} />
          ) : (
            <Play size={15} />
          )}
          <span>{t('gallery.preview', { defaultValue: 'Preview' })}</span>
        </button>
        <button
          className="flex-1 inline-flex items-center justify-center gap-[6px] px-[10px] py-[6px] rounded-[8px] bg-[color-mix(in_srgb,var(--card-accent)_15%,transparent)] text-[var(--card-accent)] text-[0.72rem] font-semibold cursor-pointer transition-colors hover:bg-[var(--card-accent)] hover:text-[var(--color-fg-inverse)] focus-visible:bg-[var(--card-accent)] focus-visible:text-[var(--color-fg-inverse)]"
          onClick={() => onUse(a)}
        >
          <UserPlus size={14} /> {t('gallery.use_voice', { defaultValue: 'Use voice' })}
        </button>
        <button
          className="inline-flex items-center justify-center w-[30px] h-[30px] flex-shrink-0 rounded-[8px] bg-transparent text-[var(--color-fg-muted)] cursor-pointer opacity-50 transition-[opacity,color,background-color] duration-150 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--chrome-hover-bg)] hover:text-[var(--card-accent)]"
          onClick={() => onDesign(a)}
          title={t('gallery.open_designer', { defaultValue: 'Open in Designer' })}
        >
          <Wand2 size={14} />
        </button>
      </div>
    </div>
  );
}
