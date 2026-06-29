import React, { useState, useMemo, useEffect } from 'react';
import { Loader, Star, RotateCcw, Grid, List } from 'lucide-react';
import { Button } from '../../ui';
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
    'american accent', 'british accent', 'australian accent', 'canadian accent',
    'indian accent', 'chinese accent', 'japanese accent', 'korean accent',
    'portuguese accent', 'russian accent',
  ],
  // English + Chinese come from the generated catalog; the rest are curated
  // multilingual designed voices. Values must match the archetype `language`
  // field (a languages.json entry) exactly — that drives the backend filter.
  lang: [
    'English', 'Chinese', 'Spanish', 'French', 'German', 'Italian',
    'Portuguese', 'Russian', 'Hindi', 'Japanese', 'Korean',
  ],
};

const hasActiveFilters = (f) => Object.values(f).some((v) => v !== null && v !== '');

// ── Archetypes zone ─────────────────────────────────────────────────────────
export default function ArchetypesZone({
  t, filters, setFilter, resetFilters, favorites, toggleFavorite,
  viewMode, setViewMode, playingId, loadingPreviewId, onPreview, onUse, onDesign,
}) {
  const [favOnly, setFavOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  useEffect(() => { setOffset(0); }, [filters]);

  const cleanFilters = useMemo(() => {
    const out = {};
    Object.entries(filters).forEach(([k, v]) => { if (v !== null && v !== '') out[k] = v; });
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
    a, t, viewMode,
    isFavorite: favSet.has(a.id),
    isPlaying: playingId === a.id,
    isLoadingPreview: loadingPreviewId === a.id,
    onPreview, onUse, onDesign, onToggleFavorite: toggleFavorite,
  });

  return (
    <div className="gallery-content gallery-scroll">
      <div className="facet-bar">
        {/* Three filter lanes (categories · facets · toggles), each its own
            horizontally-scrollable portion; the view toggle is pinned right. */}
        <div className="facet-group facet-group--cats use-case-chips">
          <button className={`category-chip ${!filters.use_case ? 'selected' : ''}`} onClick={() => setFilter('use_case', null)}>
            {t('gallery.all', { defaultValue: 'All' })}
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              className={`category-chip ${filters.use_case === c.id ? 'selected' : ''}`}
              onClick={() => setFilter('use_case', filters.use_case === c.id ? null : c.id)}
              title={c.name}
            >
              <ArchetypeIcon name={c.icon} size={13} />
              {t(`archetypes.use_${c.id}`, { defaultValue: c.name })}
            </button>
          ))}
        </div>

        <div className="facet-group facet-group--facets facet-selects">
          {['gender', 'age', 'pitch', 'accent', 'lang'].map((dim) => (
            <select
              key={dim}
              className="facet-select"
              value={filters[dim] ?? ''}
              onChange={(e) => setFilter(dim, e.target.value || null)}
            >
              <option value="">{t(`archetypes.facet_${dim}`, { defaultValue: titleCase(dim) })}</option>
              {FACETS[dim].map((opt) => <option key={opt} value={opt}>{facetLabel(opt)}</option>)}
            </select>
          ))}
        </div>

        <div className="facet-group facet-group--toggles">
          <label className="facet-toggle">
            <input
              type="checkbox"
              checked={filters.whisper === true}
              onChange={(e) => setFilter('whisper', e.target.checked ? true : null)}
            />
            {t('archetypes.facet_whisper', { defaultValue: 'Whisper' })}
          </label>
          <label className="facet-toggle">
            <input type="checkbox" checked={favOnly} onChange={(e) => setFavOnly(e.target.checked)} />
            <Star size={12} /> {t('gallery.favorites', { defaultValue: 'Favorites' })}
          </label>
          <button className="facet-reset" onClick={() => { resetFilters(); setFavOnly(false); }}>
            <RotateCcw size={12} /> {t('gallery.reset', { defaultValue: 'Reset' })}
          </button>
        </div>

        <div className="view-toggle">
          <button className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')} title="Grid"><Grid size={14} /></button>
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')} title="List"><List size={14} /></button>
        </div>
      </div>

      {showFeatured && (
        <section className="archetype-section">
          <div className="content-header"><div className="content-title">{t('archetypes.featured', { defaultValue: 'Featured' })}</div></div>
          <div className={`archetype-grid ${viewMode}`}>
            {applyFav(featured).map((a) => <ArchetypeCard key={a.id} {...cardProps(a)} />)}
          </div>
        </section>
      )}

      <section className="archetype-section">
        <div className="content-header">
          <div className="content-title">
            {t('archetypes.browse_all', { defaultValue: 'Browse all' })}
            <span className="count-badge">{total}</span>
          </div>
        </div>
        {browseQ.isLoading ? (
          <div className="loading"><Loader className="spin" size={18} /></div>
        ) : (
          <>
            <div className={`archetype-grid ${viewMode}`}>
              {applyFav(browse).map((a) => <ArchetypeCard key={a.id} {...cardProps(a)} />)}
            </div>
            {applyFav(browse).length === 0 && (
              <div className="empty">{t('gallery.no_matches', { defaultValue: 'No voices match these filters.' })}</div>
            )}
            {offset + BROWSE_PAGE < total && !favOnly && (
              <div className="load-more">
                <Button variant="ghost" onClick={() => setOffset(offset + BROWSE_PAGE)} disabled={browseQ.isFetching}>
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
