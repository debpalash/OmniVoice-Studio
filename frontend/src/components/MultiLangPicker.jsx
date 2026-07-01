import React, { useState, useMemo, useRef, useEffect } from 'react';
import { X, Search, Globe, Plus } from 'lucide-react';
import { POPULAR_LANGS } from '../utils/constants';
import { LANG_CODES } from '../utils/languages';
import { useTranslation } from 'react-i18next';

/**
 * MultiLangPicker — chip-based multi-language selector for batch dubbing.
 *
 * Shows selected languages as removable badges. Click "+" to open a
 * searchable dropdown with Popular + All Languages sections.
 */
export default function MultiLangPicker({
  selected = [], // array of { lang: string, code: string }
  onChange, // (newSelected) => void
  disabled = false,
}) {
  const { t } = useTranslation();
  const [dropOpen, setDropOpen] = useState(false);
  const [query, setQuery] = useState('');
  const dropRef = useRef(null);
  const inputRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setDropOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropOpen]);

  // Focus search when dropdown opens
  useEffect(() => {
    if (dropOpen && inputRef.current) inputRef.current.focus();
  }, [dropOpen]);

  const selectedCodes = useMemo(() => new Set(selected.map((s) => s.code)), [selected]);

  const addLang = (lang, code) => {
    if (selectedCodes.has(code)) return;
    onChange([...selected, { lang, code }]);
    setQuery('');
  };

  const removeLang = (code) => {
    onChange(selected.filter((s) => s.code !== code));
  };

  const filteredLangs = useMemo(() => {
    const q = query.toLowerCase().trim();
    return LANG_CODES.filter(
      (lc) =>
        !selectedCodes.has(lc.code) &&
        (!q || lc.label.toLowerCase().includes(q) || lc.code.toLowerCase().includes(q)),
    );
  }, [query, selectedCodes]);

  const popularFiltered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return POPULAR_LANGS.map((lang) => {
      const match = LANG_CODES.find((lc) => lc.label.toLowerCase() === lang.toLowerCase());
      return match ? { lang, code: match.code } : null;
    }).filter(
      (item) =>
        item &&
        !selectedCodes.has(item.code) &&
        (!q || item.lang.toLowerCase().includes(q) || item.code.includes(q)),
    );
  }, [query, selectedCodes]);

  return (
    <div className="relative" ref={dropRef}>
      <div className="flex flex-wrap gap-[4px] items-center min-h-[28px]">
        {selected.map((s) => (
          <span
            key={s.code}
            className="inline-flex items-center gap-[4px] px-[8px] py-[2px] bg-[var(--chrome-hover-bg)] border border-solid border-transparent rounded-full [font-family:var(--font-mono)] text-[0.68rem] font-medium text-[color:var(--chrome-fg)] uppercase"
          >
            <Globe size={9} />
            <span>{s.code}</span>
            {!disabled && (
              <button
                type="button"
                className="bg-transparent border-0 text-[color:var(--chrome-fg-muted)] cursor-pointer p-0 flex items-center rounded-full [transition:color_0.15s] hover:text-danger"
                onClick={() => removeLang(s.code)}
                aria-label={`Remove ${s.lang}`}
              >
                <X size={8} />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <button
            type="button"
            className="flex items-center justify-center w-[24px] h-[24px] rounded-full border border-dashed border-transparent bg-transparent text-[color:var(--chrome-fg-muted)] cursor-pointer [transition:all_0.15s] hover:bg-[var(--chrome-hover-bg)] hover:text-[color:var(--chrome-fg)] hover:border-solid"
            onClick={() => setDropOpen(!dropOpen)}
            title={t('dub.add_language')}
          >
            <Plus size={10} />
          </button>
        )}
      </div>

      {selected.length > 0 && (
        <div className="[font-family:var(--font-mono)] text-[0.62rem] text-[color:var(--chrome-fg-dim)] mt-[4px]">
          {t('dub.languages_selected', { count: selected.length })}
        </div>
      )}

      {dropOpen && (
        <div className="multi-lang__drop">
          <div className="flex items-center gap-[6px] px-[10px] py-[8px] border-b border-solid border-b-transparent text-[color:var(--chrome-fg-muted)]">
            <Search size={10} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('dub.search_languages')}
              spellCheck={false}
              className="flex-1 bg-transparent border-0 outline-none text-[color:var(--chrome-fg)] [font-family:var(--font-sans)] text-[0.78rem]"
            />
          </div>
          <div className="overflow-y-auto flex-1 py-[4px]">
            {popularFiltered.length > 0 && (
              <>
                <div className="[font-family:var(--font-mono)] text-[0.62rem] font-semibold uppercase [letter-spacing:0.04em] text-[color:var(--chrome-fg-dim)] pt-[6px] px-[10px] pb-[2px]">
                  {t('dub.popular')}
                </div>
                {popularFiltered.map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    className="flex items-center gap-[8px] w-full px-[10px] py-[5px] bg-transparent border-0 text-[color:var(--chrome-fg)] [font-family:var(--font-sans)] text-[0.76rem] cursor-pointer text-left [transition:background_0.1s] hover:bg-[var(--chrome-hover-bg)]"
                    onClick={() => addLang(item.lang, item.code)}
                  >
                    <span className="[font-family:var(--font-mono)] text-[0.68rem] text-[color:var(--chrome-accent)] min-w-[28px] font-semibold">
                      {item.code}
                    </span>
                    <span>{item.lang}</span>
                  </button>
                ))}
              </>
            )}
            <div className="[font-family:var(--font-mono)] text-[0.62rem] font-semibold uppercase [letter-spacing:0.04em] text-[color:var(--chrome-fg-dim)] pt-[6px] px-[10px] pb-[2px]">
              {t('dub.all_languages')}
            </div>
            {filteredLangs.slice(0, 50).map((lc) => (
              <button
                key={lc.code}
                type="button"
                className="flex items-center gap-[8px] w-full px-[10px] py-[5px] bg-transparent border-0 text-[color:var(--chrome-fg)] [font-family:var(--font-sans)] text-[0.76rem] cursor-pointer text-left [transition:background_0.1s] hover:bg-[var(--chrome-hover-bg)]"
                onClick={() => addLang(lc.label, lc.code)}
              >
                <span className="[font-family:var(--font-mono)] text-[0.68rem] text-[color:var(--chrome-accent)] min-w-[28px] font-semibold">
                  {lc.code}
                </span>
                <span>{lc.label}</span>
              </button>
            ))}
            {filteredLangs.length > 50 && (
              <div className="px-[10px] py-[8px] text-[0.7rem] text-[color:var(--chrome-fg-dim)] text-center">
                {t('dub.more_to_narrow', { count: filteredLangs.length - 50 })}
              </div>
            )}
            {filteredLangs.length === 0 && popularFiltered.length === 0 && (
              <div className="px-[10px] py-[8px] text-[0.7rem] text-[color:var(--chrome-fg-dim)] text-center">
                {t('dub.no_matches')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
