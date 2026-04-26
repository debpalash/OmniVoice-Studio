import React, { useState, useMemo, useRef, useEffect } from 'react';
import { X, Search, Globe, Plus } from 'lucide-react';
import { POPULAR_LANGS } from '../utils/constants';
import { LANG_CODES } from '../utils/languages';
import './MultiLangPicker.css';

/**
 * MultiLangPicker — chip-based multi-language selector for batch dubbing.
 *
 * Shows selected languages as removable badges. Click "+" to open a
 * searchable dropdown with Popular + All Languages sections.
 */
export default function MultiLangPicker({
  selected = [],         // array of { lang: string, code: string }
  onChange,              // (newSelected) => void
  disabled = false,
}) {
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

  const selectedCodes = useMemo(() => new Set(selected.map(s => s.code)), [selected]);

  const addLang = (lang, code) => {
    if (selectedCodes.has(code)) return;
    onChange([...selected, { lang, code }]);
    setQuery('');
  };

  const removeLang = (code) => {
    onChange(selected.filter(s => s.code !== code));
  };

  const filteredLangs = useMemo(() => {
    const q = query.toLowerCase().trim();
    return LANG_CODES.filter(lc =>
      !selectedCodes.has(lc.code) &&
      (!q || lc.label.toLowerCase().includes(q) || lc.code.toLowerCase().includes(q))
    );
  }, [query, selectedCodes]);

  const popularFiltered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return POPULAR_LANGS
      .map(lang => {
        const match = LANG_CODES.find(lc => lc.label.toLowerCase() === lang.toLowerCase());
        return match ? { lang, code: match.code } : null;
      })
      .filter(item => item && !selectedCodes.has(item.code) && (!q || item.lang.toLowerCase().includes(q) || item.code.includes(q)));
  }, [query, selectedCodes]);

  return (
    <div className="multi-lang" ref={dropRef}>
      <div className="multi-lang__chips">
        {selected.map(s => (
          <span key={s.code} className="multi-lang__chip">
            <Globe size={9} />
            <span>{s.code}</span>
            {!disabled && (
              <button
                type="button"
                className="multi-lang__chip-x"
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
            className="multi-lang__add"
            onClick={() => setDropOpen(!dropOpen)}
            title="Add language"
          >
            <Plus size={10} />
          </button>
        )}
      </div>

      {selected.length > 0 && (
        <div className="multi-lang__summary">
          {selected.length} language{selected.length > 1 ? 's' : ''} selected
        </div>
      )}

      {dropOpen && (
        <div className="multi-lang__drop">
          <div className="multi-lang__search">
            <Search size={10} />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search languages…"
              spellCheck={false}
            />
          </div>
          <div className="multi-lang__list">
            {popularFiltered.length > 0 && (
              <>
                <div className="multi-lang__section">Popular</div>
                {popularFiltered.map(item => (
                  <button
                    key={item.code}
                    type="button"
                    className="multi-lang__option"
                    onClick={() => addLang(item.lang, item.code)}
                  >
                    <span className="multi-lang__option-code">{item.code}</span>
                    <span>{item.lang}</span>
                  </button>
                ))}
              </>
            )}
            <div className="multi-lang__section">All Languages</div>
            {filteredLangs.slice(0, 50).map(lc => (
              <button
                key={lc.code}
                type="button"
                className="multi-lang__option"
                onClick={() => addLang(lc.label, lc.code)}
              >
                <span className="multi-lang__option-code">{lc.code}</span>
                <span>{lc.label}</span>
              </button>
            ))}
            {filteredLangs.length > 50 && (
              <div className="multi-lang__more">
                +{filteredLangs.length - 50} more — type to narrow
              </div>
            )}
            {filteredLangs.length === 0 && popularFiltered.length === 0 && (
              <div className="multi-lang__empty">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
