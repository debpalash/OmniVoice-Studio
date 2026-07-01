import React, { useState, useMemo, useEffect } from 'react';
import { Loader, Star, RotateCcw, Grid, List } from 'lucide-react';
import { Button, Select, Segmented } from '../../ui';
import { useArchetypeCategories, useArchetypes } from '../../api/hooks';
import { ArchetypeIcon } from '../../utils/archetypeIcons';
import { titleCase, facetLabel } from './constants';
import ArchetypeCard from './ArchetypeCard';

const BROWSE_PAGE = 60;

// Facet vocabularies — values must match the backend taxonomy tokens exactly.
const FACETS = {
  gender: ['male', 'female'],
  age: ['child', 'teenager', 'young adult', 'middle-aged', 'elderly'],
  pitch: ['very low pitch', 'low pitch', 'moderate pitch', 'high pitch', 'very high pitch'],
  accent: [
    'american accent',
    'british accent',
    'australian accent',
    'canadian accent',
    'indian accent',
    'chinese accent',
    'japanese accent',
    'korean accent',
    'portuguese accent',
    'russian accent',
  ],
  // English + Chinese come from the generated catalog; the rest are curated
  // multilingual designed voices. Values must match the archetype `language`
  // field (a languages.json entry) exactly — that drives the backend filter.
  lang: [
    'English',
    'Chinese',
    'Spanish',
    'French',
    'German',
    'Italian',
    'Portuguese',
    'Russian',
    'Hindi',
    'Japanese',
    'Korean',
  ],
};

const hasActiveFilters = (f) => Object.values(f).some((v) => v !== null && v !== '');

// ── Archetypes zone ─────────────────────────────────────────────────────────
export default function ArchetypesZone({
  t,
  filters,
  setFilter,
  resetFilters,
  favorites,
  toggleFavorite,
  viewMode,
  setViewMode,
  playingId,
  loadingPreviewId,
  onPreview,
  onUse,
  onDesign,
}) {
  const [favOnly, setFavOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(0);
  }, [filters]);

  const cleanFilters = useMemo(() => {
    const out = {};
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== null && v !== '') out[k] = v;
    });
    return out;
  }, [filters]);

  // The Featured strip shows only when nothing is filtered; in that case Browse
  // excludes featured to avoid duplicating it. Once any filter is active the
  // Featured strip is hidden (see below), so Browse must include featured too —
  // otherwise the curated multilingual languages (Spanish/French/…), which have
  // *only* featured archetypes, would filter down to an empty list.
  const showFeatured = !hasActiveFilters(filters) && !favOnly;

  const categoriesQ = useArchetypeCategories();
  const featuredQ = useArchetypes({ featured: true, limit: 100 });
  const browseQ = useArchetypes({
    ...cleanFilters,
    ...(showFeatured ? { featured: false } : {}),
    limit: BROWSE_PAGE,
    offset,
  });

  const categories = categoriesQ.data || [];
  const featured = featuredQ.data?.items || [];
  const browse = browseQ.data?.items || [];
  const total = browseQ.data?.total ?? 0;

  const favSet = useMemo(() => new Set(favorites), [favorites]);
  const applyFav = (list) => (favOnly ? list.filter((a) => favSet.has(a.id)) : list);

  // NOTE: no `key` here — React keys must be passed directly on the element,
  // not spread in (spreading a `key` prop triggers a dev warning + is ignored).
  const cardProps = (a) => ({
    a,
    t,
    viewMode,
    isFavorite: favSet.has(a.id),
    isPlaying: playingId === a.id,
    isLoadingPreview: loadingPreviewId === a.id,
    onPreview,
    onUse,
    onDesign,
    onToggleFavorite: toggleFavorite,
  });

  const facetGroup =
    'flex items-center gap-[5px] flex-nowrap min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]';
  const facetToggle =
    'inline-flex items-center gap-[5px] h-[26px] box-border px-[9px] rounded-[7px] border border-transparent bg-[var(--chrome-hover-bg)] text-[var(--chrome-fg-muted)] text-[0.68rem] whitespace-nowrap cursor-pointer hover:text-[var(--chrome-fg)] hover:border-[color:var(--chrome-border-strong)]';
  const gridClass =
    viewMode === 'grid'
      ? 'grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-[10px]'
      : 'flex flex-col gap-[6px]';

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
      <div className="flex flex-row items-center gap-[10px] flex-nowrap shrink-0 pt-[2px] pb-[10px] mb-[8px] border-b border-transparent">
        {/* Three filter lanes (categories · facets · toggles), each its own
            horizontally-scrollable portion; the view toggle is pinned right. */}
        <div className={`${facetGroup} flex-[2.4_1_0]`}>
          <Button
            variant="chip"
            active={!filters.use_case}
            onClick={() => setFilter('use_case', null)}
          >
            {t('gallery.all', { defaultValue: 'All' })}
          </Button>
          {categories.map((c) => (
            <Button
              key={c.id}
              variant="chip"
              active={filters.use_case === c.id}
              leading={<ArchetypeIcon name={c.icon} size={13} />}
              onClick={() => setFilter('use_case', filters.use_case === c.id ? null : c.id)}
              title={c.name}
            >
              {t(`archetypes.use_${c.id}`, { defaultValue: c.name })}
            </Button>
          ))}
        </div>

        <div className={`${facetGroup} flex-[1.6_1_0] pl-[10px] border-l border-transparent`}>
          {['gender', 'age', 'pitch', 'accent', 'lang'].map((dim) => (
            <Select
              key={dim}
              size="sm"
              value={filters[dim] ?? ''}
              onChange={(e) => setFilter(dim, e.target.value || null)}
            >
              <option value="">
                {t(`archetypes.facet_${dim}`, { defaultValue: titleCase(dim) })}
              </option>
              {FACETS[dim].map((opt) => (
                <option key={opt} value={opt}>
                  {facetLabel(opt)}
                </option>
              ))}
            </Select>
          ))}
        </div>

        <div className={`${facetGroup} flex-[1_1_0] pl-[10px] border-l border-transparent`}>
          <label className={facetToggle}>
            <input
              type="checkbox"
              checked={filters.whisper === true}
              onChange={(e) => setFilter('whisper', e.target.checked ? true : null)}
            />
            {t('archetypes.facet_whisper', { defaultValue: 'Whisper' })}
          </label>
          <label className={facetToggle}>
            <input
              type="checkbox"
              checked={favOnly}
              onChange={(e) => setFavOnly(e.target.checked)}
            />
            <Star size={12} /> {t('gallery.favorites', { defaultValue: 'Favorites' })}
          </label>
          <Button
            variant="ghost"
            size="sm"
            leading={<RotateCcw size={12} />}
            onClick={() => {
              resetFilters();
              setFavOnly(false);
            }}
          >
            {t('gallery.reset', { defaultValue: 'Reset' })}
          </Button>
        </div>

        <Segmented
          size="xs"
          value={viewMode}
          onChange={setViewMode}
          items={[
            { value: 'grid', label: <Grid size={14} />, title: 'Grid' },
            { value: 'list', label: <List size={14} />, title: 'List' },
          ]}
        />
      </div>

      {showFeatured && (
        <section className="mb-[14px]">
          <div className="flex justify-between items-center pb-[8px] shrink-0">
            <div className="text-[0.85rem] font-medium">
              {t('archetypes.featured', { defaultValue: 'Featured' })}
            </div>
          </div>
          <div className={gridClass}>
            {applyFav(featured).map((a) => (
              <ArchetypeCard key={a.id} {...cardProps(a)} />
            ))}
          </div>
        </section>
      )}

      <section className="mb-[14px]">
        <div className="flex justify-between items-center pb-[8px] shrink-0">
          <div className="text-[0.85rem] font-medium">
            {t('archetypes.browse_all', { defaultValue: 'Browse all' })}
            <span className="ml-[6px] px-[7px] py-[1px] rounded-[10px] bg-bg-elev-2 text-[var(--text-secondary)] text-[0.65rem] font-normal">
              {total}
            </span>
          </div>
        </div>
        {browseQ.isLoading ? (
          <div className="flex items-center justify-center p-[24px] text-[var(--text-secondary)]">
            <Loader className="spin" size={18} />
          </div>
        ) : (
          <>
            <div className={gridClass}>
              {applyFav(browse).map((a) => (
                <ArchetypeCard key={a.id} {...cardProps(a)} />
              ))}
            </div>
            {applyFav(browse).length === 0 && (
              <div className="flex flex-col items-center justify-center px-[16px] py-[32px] text-[var(--text-secondary)] text-center">
                {t('gallery.no_matches', { defaultValue: 'No voices match these filters.' })}
              </div>
            )}
            {offset + BROWSE_PAGE < total && !favOnly && (
              <div className="flex justify-center py-[12px]">
                <Button
                  variant="ghost"
                  onClick={() => setOffset(offset + BROWSE_PAGE)}
                  disabled={browseQ.isFetching}
                >
                  {browseQ.isFetching ? <Loader className="spin" size={14} /> : null}
                  {t('gallery.load_more', { defaultValue: 'Load more' })}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
