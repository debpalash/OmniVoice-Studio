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
  viewMode,
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

  return (
    <div
      className={`archetype-card ${viewMode} ${isPlaying ? 'playing' : ''}`}
      style={{ '--card-accent': color }}
    >
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
          className={`fav-btn ${isFavorite ? 'on' : ''}`}
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
          <span className="facet-chip with-flag">
            <AccentFlag accent={a.facets.accent} lang={a.language} size={14} />
            {accentLabel}
          </span>
        )}
        {a.facets.whisper && (
          <span className="facet-chip">
            {t('archetypes.facet_whisper', { defaultValue: 'Whisper' })}
          </span>
        )}
      </div>

      <div className="flex items-center gap-[6px] mt-auto">
        <button
          className="preview-btn"
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
        <button className="use-btn" onClick={() => onUse(a)}>
          <UserPlus size={14} /> {t('gallery.use_voice', { defaultValue: 'Use voice' })}
        </button>
        <button
          className="designer-btn"
          onClick={() => onDesign(a)}
          title={t('gallery.open_designer', { defaultValue: 'Open in Designer' })}
        >
          <Wand2 size={14} />
        </button>
      </div>
    </div>
  );
}
