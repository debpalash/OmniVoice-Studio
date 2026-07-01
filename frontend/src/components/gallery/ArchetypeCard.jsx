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

  const cardBase =
    'group relative flex flex-col gap-[10px] p-[13px] rounded-[13px] ' +
    'bg-[linear-gradient(180deg,rgba(255,255,255,0.038),rgba(255,255,255,0.012))] border ' +
    'transition-[transform,border-color,box-shadow] duration-150 ' +
    'hover:-translate-y-[2px] hover:shadow-[0_6px_22px_rgba(0,0,0,0.4)] ' +
    'motion-reduce:transition-none motion-reduce:hover:translate-y-0';
  const cardState = isPlaying
    ? 'border-[color:var(--card-accent)] shadow-[0_0_0_1px_var(--card-accent),0_6px_22px_rgba(0,0,0,0.4)]'
    : 'border-transparent hover:border-transparent';

  return (
    <div className={`${cardBase} ${cardState}`} style={{ '--card-accent': color }}>
      <div className="flex items-center gap-[10px]">
        <ArchetypeAvatar item={a} />
        <div className="flex-1 min-w-0">
          <div className="text-[0.84rem] font-semibold text-[var(--text-primary)] truncate">
            {a.name}
          </div>
          {sub && (
            <div className="text-[0.68rem] text-[var(--text-secondary)] mt-[2px] truncate">
              {sub}
            </div>
          )}
        </div>
        <button
          className={`flex-shrink-0 flex items-center justify-center w-[26px] h-[26px] rounded-[7px] cursor-pointer transition-colors hover:bg-white/[0.05] ${
            isFavorite ? 'text-[#fabd2f]' : 'text-[var(--text-secondary)] hover:text-[#fabd2f]'
          }`}
          onClick={() => onToggleFavorite(a.id)}
          title={t('gallery.favorite', { defaultValue: 'Favorite' })}
        >
          <Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
      </div>

      {/* Always render the chip row (even when empty) so every card shares the
          same height and the action rows align across the grid. */}
      <div className="flex flex-wrap items-center gap-[5px] min-h-[21px]">
        {accentLabel && (
          <span className="inline-flex items-center gap-[5px] pl-[5px] pr-[8px] py-[2px] rounded-[7px] bg-white/[0.05] text-[var(--text-secondary)] text-[0.64rem] leading-[1.6]">
            <AccentFlag accent={a.facets.accent} lang={a.language} size={14} />
            {accentLabel}
          </span>
        )}
        {a.facets.whisper && (
          <span className="inline-flex items-center gap-[5px] px-[8px] py-[2px] rounded-[7px] bg-white/[0.05] text-[var(--text-secondary)] text-[0.64rem] leading-[1.6]">
            {t('archetypes.facet_whisper', { defaultValue: 'Whisper' })}
          </span>
        )}
      </div>

      <div className="flex items-center gap-[6px] mt-auto">
        <button
          className="inline-flex items-center gap-[6px] px-[11px] py-[6px] border border-transparent bg-white/[0.03] text-[var(--text-primary)] rounded-[8px] text-[0.7rem] cursor-pointer transition-colors hover:border-[color:var(--card-accent)] hover:text-[var(--card-accent)]"
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
          className="flex-1 inline-flex items-center justify-center gap-[6px] px-[10px] py-[6px] rounded-[8px] border border-[color:color-mix(in_srgb,var(--card-accent)_36%,transparent)] bg-[color-mix(in_srgb,var(--card-accent)_13%,transparent)] text-[var(--card-accent)] text-[0.72rem] font-semibold cursor-pointer transition-colors hover:bg-[var(--card-accent)] hover:border-[color:var(--card-accent)] hover:text-[#1d2021] focus-visible:bg-[var(--card-accent)] focus-visible:border-[color:var(--card-accent)] focus-visible:text-[#1d2021]"
          onClick={() => onUse(a)}
        >
          <UserPlus size={14} /> {t('gallery.use_voice', { defaultValue: 'Use voice' })}
        </button>
        <button
          className="inline-flex items-center justify-center w-[30px] h-[30px] flex-shrink-0 border border-transparent bg-white/[0.03] text-[var(--text-secondary)] rounded-[8px] cursor-pointer opacity-50 transition-[opacity,border-color,color] duration-150 group-hover:opacity-100 focus-visible:opacity-100 hover:text-[var(--card-accent)] hover:border-[color:var(--card-accent)]"
          onClick={() => onDesign(a)}
          title={t('gallery.open_designer', { defaultValue: 'Open in Designer' })}
        >
          <Wand2 size={14} />
        </button>
      </div>
    </div>
  );
}
