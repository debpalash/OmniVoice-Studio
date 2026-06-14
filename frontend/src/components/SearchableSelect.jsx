import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, Check, Star, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const MAX_DISPLAY = 200;

const readRecents = (key) => {
  if (!key || typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
};

const writeRecents = (key, list) => {
  if (!key || typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, JSON.stringify(list.slice(0, 8))); } catch {}
};

const normalize = (s) => (s || '').toString().toLowerCase();

export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  popular = [],
  recentsKey = '',
  renderLabel,
  renderOption,
  disabled = false,
  buttonStyle,
  buttonClassName = 'input-base',
  size = 'md',
  // When true, emit a `.ss-group-label` header each time `option.group` changes
  // (and `option.groupLabel` is non-empty) while walking the MAIN rows. Default
  // false so the two pre-existing call sites are unaffected. (#22)
  renderGroupHeaders = false,
  // Gate which committed values get recorded as recents. Default records all
  // (back-compat). VoiceSelector passes a guard so sentinel values
  // ('' / preset: / auto:) never pollute the recents list. (#22)
  isRecentable = () => true,
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [recents, setRecents] = useState(() => readRecents(recentsKey));
  const wrapRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const getVal = useCallback((o) => (typeof o === 'string' ? o : o?.value), []);
  const getLabel = useCallback((o) => {
    if (renderLabel) return renderLabel(o);
    if (typeof o === 'string') return o;
    return o?.label ?? o?.value ?? '';
  }, [renderLabel]);

  const byVal = useMemo(() => {
    const m = new Map();
    for (const o of options) m.set(getVal(o), o);
    return m;
  }, [options, getVal]);

  const currentLabel = useMemo(() => {
    const o = byVal.get(value);
    return o ? getLabel(o) : (value || placeholder);
  }, [byVal, value, getLabel, placeholder]);

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return options;
    return options.filter(o => normalize(getLabel(o)).includes(q) || normalize(getVal(o)).includes(q));
  }, [options, query, getLabel, getVal]);

  const pinned = useMemo(() => {
    if (query) return [];
    const out = [];
    const seen = new Set();
    for (const v of recents) {
      const o = byVal.get(v);
      if (o && !seen.has(v)) { out.push({ o, kind: 'recent' }); seen.add(v); }
      if (out.length >= 5) break;
    }
    for (const v of popular) {
      if (seen.has(v)) continue;
      const o = byVal.get(v);
      if (o) { out.push({ o, kind: 'popular' }); seen.add(v); }
      if (out.length >= 12) break;
    }
    return out;
  }, [query, recents, popular, byVal]);

  const displayed = useMemo(() => filtered.slice(0, MAX_DISPLAY), [filtered]);

  const flatItems = useMemo(() => {
    const list = [];
    for (const p of pinned) list.push({ o: p.o, kind: p.kind });
    for (const o of displayed) list.push({ o, kind: 'main' });
    return list;
  }, [pinned, displayed]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (open) {
      setHighlight(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery('');
    }
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${highlight}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const commit = (o) => {
    const v = getVal(o);
    onChange?.(v);
    if (recentsKey && isRecentable(v)) {
      const next = [v, ...recents.filter(r => r !== v)].slice(0, 8);
      setRecents(next);
      writeRecents(recentsKey, next);
    }
    setOpen(false);
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(flatItems.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatItems[highlight];
      if (item) commit(item.o);
    } else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  const sizeCls = size === 'sm' ? 'ss-sm' : 'ss-md';

  return (
    <div ref={wrapRef} className={`ss-wrap ${sizeCls}`}>
      <button
        type="button"
        className={`${buttonClassName} ss-trigger`}
        style={buttonStyle}
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={currentLabel}
      >
        <span className="ss-trigger-label">{currentLabel}</span>
        <ChevronDown size={12} className="ss-chev" />
      </button>

      {open && (
        <div className="ss-pop" role="listbox">
          <div className="ss-search">
            <Search size={12} className="ss-search-icon" />
            <input
              ref={inputRef}
              className="ss-search-input"
              placeholder={t('common.search')}
              value={query}
              onChange={e => { setQuery(e.target.value); setHighlight(0); }}
              onKeyDown={onKey}
            />
          </div>

          <div ref={listRef} className="ss-list">
            {flatItems.length === 0 && (
              <div className="ss-empty">{t('common.no_matches')}</div>
            )}

            {pinned.length > 0 && (
              <div className="ss-group-label">
                {recents.length ? <><Clock size={9}/> {t('common.recent_and_popular')}</> : <><Star size={9}/> {t('common.popular_label')}</>}
              </div>
            )}

            {(() => { let lastGroup; return flatItems.map((it, idx) => {
              const v = getVal(it.o);
              const selected = v === value;
              const highlighted = idx === highlight;
              // Group header: emitted lazily on the first MAIN row of a new
              // group whose option carries a non-empty groupLabel (#22). Pinned
              // recent/popular rows never trigger a header. `lastGroup` advances
              // only on main rows so a pinned row can't swallow the first header.
              const showHeader =
                renderGroupHeaders &&
                it.kind === 'main' &&
                it.o && it.o.groupLabel &&
                it.o.group !== lastGroup;
              if (it.kind === 'main') lastGroup = it.o?.group;
              return (
                <React.Fragment key={`${it.kind}-${v}-${idx}`}>
                  {showHeader && <div className="ss-group-label">{it.o.groupLabel}</div>}
                  <div
                    data-idx={idx}
                    className={`ss-option ${highlighted ? 'ss-hl' : ''} ${selected ? 'ss-sel' : ''}`}
                    onMouseEnter={() => setHighlight(idx)}
                    onMouseDown={(e) => { e.preventDefault(); commit(it.o); }}
                    role="option"
                    aria-selected={selected}
                  >
                    {it.kind === 'recent' && <Clock size={9} className="ss-kind-icon"/>}
                    {it.kind === 'popular' && <Star size={9} className="ss-kind-icon"/>}
                    <span className="ss-option-label">
                      {renderOption ? renderOption(it.o) : getLabel(it.o)}
                    </span>
                    {selected && <Check size={10} className="ss-check"/>}
                  </div>
                </React.Fragment>
              );
            }); })()}

            {!query && filtered.length > MAX_DISPLAY && (
              <div className="ss-more">{t('common.showing_of', { shown: MAX_DISPLAY, total: filtered.length })}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
