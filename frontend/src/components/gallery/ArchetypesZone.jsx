import React, { useState, useMemo, useEffect } from 'react';
import { Loader, Star, RotateCcw, Grid, List, SlidersHorizontal } from 'lucide-react';
import { Button, Select, Segmented } from '../../ui';
import { useArchetypeCategories, useArchetypes } from '../../api/hooks';
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
  onUseInStories,
  onUseAsAudiobookDefault,
  materializingId,
}) {
  const [favOnly, setFavOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  const advancedFilterCount = ['gender', 'age', 'pitch', 'accent', 'lang', 'whisper'].filter(
    (key) => filters[key] !== null && filters[key] !== '',
  ).length;

  // NOTE: no `key` here — React keys must be passed directly on the element,
  // not spread in (spreading a `key` prop triggers a dev warning + is ignored).
  const cardProps = (a) => ({
    a,
    t,
    viewMode,
    isFavorite: favSet.has(a.id),
    isPlaying: playingId === a.id,
    isLoadingPreview: loadingPreviewId === a.id,
    previewLocked: Boolean(loadingPreviewId),
    onPreview,
    onUse,
    onDesign,
    onUseInStories,
    onUseAsAudiobookDefault,
    onToggleFavorite: toggleFavorite,
    isMaterializing: materializingId === a.id,
    materializationLocked: Boolean(materializingId),
  });

  const facetToggle =
    'inline-flex items-center gap-[5px] h-[26px] box-border px-[9px] rounded-[7px] border border-transparent bg-[var(--chrome-hover-bg)] text-[var(--chrome-fg-muted)] text-[0.68rem] whitespace-nowrap cursor-pointer hover:text-[var(--chrome-fg)] hover:border-[color:var(--chrome-border-strong)]';
  const gridClass =
    viewMode === 'grid'
      ? 'grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-[10px]'
      : 'flex flex-col gap-[6px]';

  return (
    // data-testid: stable e2e hook — locale-independent, unlike the translated
    // aria-labels/headings inside (see e2e/gallery.spec.ts).
    <div data-testid="archetypes-zone" className="flex-1 min-h-0 flex flex-col overflow-y-auto">
      <div className="shrink-0 mb-[8px] pb-[8px] border-b border-transparent">
        <div className="flex items-center gap-[6px] min-w-0">
          <Select
            size="sm"
            className="w-auto min-w-[132px] max-w-[190px] shrink-0"
            aria-label={t('gallery.zone_archetypes', { defaultValue: 'Archetypes' })}
            value={filters.use_case ?? ''}
            onChange={(e) => setFilter('use_case', e.target.value || null)}
          >
            <option value="">{t('gallery.all', { defaultValue: 'All' })}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {t(`archetypes.use_${c.id}`, { defaultValue: c.name })}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            active={filtersOpen}
            leading={<SlidersHorizontal size={13} />}
            trailing={
              advancedFilterCount > 0 ? (
                <span className="min-w-[16px] rounded-full bg-[var(--accent)] px-[4px] py-px text-center text-[0.58rem] leading-[14px] text-white">
                  {advancedFilterCount}
                </span>
              ) : null
            }
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            {t('gallery.filters', { defaultValue: 'Filters' })}
          </Button>
          <label className={facetToggle}>
            <input
              type="checkbox"
              checked={favOnly}
              onChange={(e) => setFavOnly(e.target.checked)}
            />
            <Star size={12} /> {t('gallery.favorites', { defaultValue: 'Favorites' })}
          </label>
          {hasActiveFilters(filters) || favOnly ? (
            <Button
              variant="icon"
              iconSize="md"
              onClick={() => {
                resetFilters();
                setFavOnly(false);
              }}
              title={t('gallery.reset', { defaultValue: 'Reset' })}
              aria-label={t('gallery.reset', { defaultValue: 'Reset' })}
            >
              <RotateCcw size={13} />
            </Button>
          ) : null}
          <div className="ml-auto shrink-0">
            <Segmented
              size="xs"
              value={viewMode}
              onChange={setViewMode}
              items={[
                {
                  value: 'grid',
                  label: <Grid size={14} />,
                  title: t('library.card_grid'),
                },
                { value: 'list', label: <List size={14} />, title: t('library.list') },
              ]}
            />
          </div>
        </div>

        {filtersOpen ? (
          <div className="mt-[6px] flex items-center gap-[6px] overflow-x-auto pb-px [scrollbar-width:thin]">
            {['gender', 'age', 'pitch', 'accent', 'lang'].map((dim) => (
              <Select
                key={dim}
                size="sm"
                className="w-auto min-w-[94px] max-w-[132px] shrink-0"
                aria-label={t(`archetypes.facet_${dim}`, { defaultValue: titleCase(dim) })}
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
            <label className={`${facetToggle} shrink-0`}>
              <input
                type="checkbox"
                checked={filters.whisper === true}
                onChange={(e) => setFilter('whisper', e.target.checked ? true : null)}
              />
              {t('archetypes.facet_whisper', { defaultValue: 'Whisper' })}
            </label>
          </div>
        ) : null}
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
