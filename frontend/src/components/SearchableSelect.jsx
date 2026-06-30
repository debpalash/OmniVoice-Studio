import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, Check, Star, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const MAX_DISPLAY = 200;

const readRecents = (key) => {
  if (!key || typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const writeRecents = (key, list) => {
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(list.slice(0, 8)));
  } catch {}
};

const normalize = (s) => (s || '').toString().toLowerCase();

// Migrated `.ss-group-label` — used for both the pinned header and lazy group
// headers, so share one string.
const GROUP_LABEL_CLS =
  'pt-[4px] px-[10px] pb-[2px] text-[0.55rem] uppercase tracking-[0.06em] text-[color:var(--text-secondary)] opacity-70 flex items-center gap-[4px]';

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
  const getLabel = useCallback(
    (o) => {
      if (renderLabel) return renderLabel(o);
      if (typeof o === 'string') return o;
      return o?.label ?? o?.value ?? '';
    },
    [renderLabel],
  );

  const byVal = useMemo(() => {
    const m = new Map();
    for (const o of options) m.set(getVal(o), o);
    return m;
  }, [options, getVal]);

  const currentLabel = useMemo(() => {
    const o = byVal.get(value);
    return o ? getLabel(o) : value || placeholder;
  }, [byVal, value, getLabel, placeholder]);

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return options;
    return options.filter(
      (o) => normalize(getLabel(o)).includes(q) || normalize(getVal(o)).includes(q),
    );
  }, [options, query, getLabel, getVal]);

  const pinned = useMemo(() => {
    if (query) return [];
    const out = [];
    const seen = new Set();
    for (const v of recents) {
      const o = byVal.get(v);
      if (o && !seen.has(v)) {
        out.push({ o, kind: 'recent' });
        seen.add(v);
      }
      if (out.length >= 5) break;
    }
    for (const v of popular) {
      if (seen.has(v)) continue;
      const o = byVal.get(v);
      if (o) {
        out.push({ o, kind: 'popular' });
        seen.add(v);
      }
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
      const next = [v, ...recents.filter((r) => r !== v)].slice(0, 8);
      setRecents(next);
      writeRecents(recentsKey, next);
    }
    setOpen(false);
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(flatItems.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatItems[highlight];
      if (item) commit(item.o);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  // `.ss-sm/.ss-md` only sized the trigger (`.ss-{sm,md} .ss-trigger`); apply
  // that directly on the trigger now that the descendant selectors are gone.
  const triggerSizeCls = size === 'sm' ? 'text-[0.65rem] px-[8px] py-[4px]' : 'text-[0.75rem]';

  return (
    // `ss-wrap` is retained as a marker class: residual.css targets
    // `.voice-selector > .ss-wrap` (cross-file child combinator). Its own
    // position/width rule now lives in these utilities.
    <div ref={wrapRef} className="ss-wrap relative w-full">
      <button
        type="button"
        className={`${buttonClassName} flex items-center justify-between gap-[6px] w-full text-left cursor-pointer [font-family:inherit] disabled:cursor-not-allowed disabled:opacity-50 ${triggerSizeCls}`}
        style={buttonStyle}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={currentLabel}
      >
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[color:var(--text-primary)]">
          {currentLabel}
        </span>
        <ChevronDown size={12} className="text-[color:var(--text-secondary)] shrink-0" />
      </button>

      {open && (
        <div
          className="absolute top-[calc(100%+4px)] left-0 right-0 z-[1000] bg-[rgba(29,32,33,0.98)] [border:1px_solid_rgba(255,255,255,0.1)] rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.5)] [backdrop-filter:blur(12px)] overflow-hidden min-w-[220px] max-w-[min(360px,90vw)]"
          role="listbox"
        >
          <div className="relative p-[6px] [border-bottom:1px_solid_rgba(255,255,255,0.06)] flex items-center gap-[6px]">
            <Search
              size={12}
              className="absolute left-[12px] top-1/2 -translate-y-1/2 text-[color:var(--text-secondary)] pointer-events-none"
            />
            <input
              ref={inputRef}
              className="flex-1 w-full bg-[rgba(0,0,0,0.25)] [border:1px_solid_rgba(255,255,255,0.08)] rounded-[4px] py-[5px] pr-[8px] pl-[24px] text-[0.72rem] text-[color:var(--text-primary)] outline-none [font-family:inherit] focus:[border-color:rgba(250,189,47,0.4)]"
              placeholder={t('common.search')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKey}
            />
          </div>

          <div
            ref={listRef}
            className="max-h-[280px] overflow-y-auto py-[2px] [&::-webkit-scrollbar]:w-[6px] [&::-webkit-scrollbar-thumb]:bg-[rgba(255,255,255,0.1)] [&::-webkit-scrollbar-thumb]:rounded-[3px]"
          >
            {flatItems.length === 0 && (
              <div className="py-[8px] px-[10px] text-[0.65rem] text-[color:var(--text-secondary)] italic text-center">
                {t('common.no_matches')}
              </div>
            )}

            {pinned.length > 0 && (
              <div className={GROUP_LABEL_CLS}>
                {recents.length ? (
                  <>
                    <Clock size={9} /> {t('common.recent_and_popular')}
                  </>
                ) : (
                  <>
                    <Star size={9} /> {t('common.popular_label')}
                  </>
                )}
              </div>
            )}

            {(() => {
              let lastGroup;
              return flatItems.map((it, idx) => {
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
                  it.o &&
                  it.o.groupLabel &&
                  it.o.group !== lastGroup;
                if (it.kind === 'main') lastGroup = it.o?.group;
                return (
                  <React.Fragment key={`${it.kind}-${v}-${idx}`}>
                    {showHeader && <div className={GROUP_LABEL_CLS}>{it.o.groupLabel}</div>}
                    <div
                      data-idx={idx}
                      // Migrated `.ss-option`/`.ss-hl`/`.ss-sel` cascade. Selected
                      // wins its color/weight; selected+highlighted gets the
                      // stronger amber wash; highlight (and hover, when neither
                      // selected nor highlighted) gets the amber accent.
                      className={[
                        'flex items-center gap-[6px] py-[5px] px-[10px] text-[0.72rem] cursor-pointer select-none',
                        selected
                          ? 'text-[#8ec07c] font-medium'
                          : highlighted
                            ? 'text-[color:var(--accent)]'
                            : 'text-[color:var(--text-primary)] hover:text-[color:var(--accent)]',
                        selected && highlighted
                          ? 'bg-[rgba(250,189,47,0.18)]'
                          : selected
                            ? 'bg-[rgba(142,192,124,0.1)]'
                            : highlighted
                              ? 'bg-[rgba(250,189,47,0.12)]'
                              : 'hover:bg-[rgba(250,189,47,0.12)]',
                      ].join(' ')}
                      onMouseEnter={() => setHighlight(idx)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commit(it.o);
                      }}
                      role="option"
                      aria-selected={selected}
                    >
                      {it.kind === 'recent' && (
                        <Clock size={9} className="text-[color:var(--text-secondary)] shrink-0" />
                      )}
                      {it.kind === 'popular' && (
                        <Star size={9} className="text-[color:var(--text-secondary)] shrink-0" />
                      )}
                      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {renderOption ? renderOption(it.o) : getLabel(it.o)}
                      </span>
                      {selected && <Check size={10} className="text-[#8ec07c] shrink-0" />}
                    </div>
                  </React.Fragment>
                );
              });
            })()}

            {!query && filtered.length > MAX_DISPLAY && (
              <div className="py-[8px] px-[10px] text-[0.65rem] text-[color:var(--text-secondary)] italic text-center [border-top:1px_solid_rgba(255,255,255,0.04)]">
                {t('common.showing_of', { shown: MAX_DISPLAY, total: filtered.length })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
