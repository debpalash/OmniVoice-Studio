import React from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * SettingsSearch — the filter box at the top of the Settings sidebar.
 *
 * Token-styled to match the chrome. Filters the category list (and, as a
 * bonus, matches individual setting labels — the orchestrator maps a setting
 * hit back to its category). Controlled: the parent owns the query string.
 *
 * @param {string}   value
 * @param {function} onChange  called with the next string
 * @param {function=} onClear  clears the query (defaults to onChange(''))
 */
export default function SettingsSearch({ value, onChange, onClear }) {
  const { t } = useTranslation();
  return (
    <div className="relative mb-[var(--space-3)]">
      <Search
        size={13}
        aria-hidden="true"
        className="pointer-events-none absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 text-[var(--chrome-fg-dim)]"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('settings.search_placeholder', { defaultValue: 'Search settings…' })}
        aria-label={t('settings.search_placeholder', { defaultValue: 'Search settings…' })}
        data-testid="settings-search"
        className="w-full min-w-0 box-border rounded-[var(--chrome-radius-pill)] border border-transparent bg-[color-mix(in_srgb,var(--chrome-bg)_94%,white)] py-[var(--space-2)] pl-[calc(var(--space-3)*2+13px)] pr-[calc(var(--space-3)*2+13px)] text-[color:var(--chrome-fg)] [font-family:var(--font-sans)] text-[length:var(--text-sm)] focus:border-[var(--chrome-accent)] focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => (onClear ? onClear() : onChange(''))}
          aria-label={t('common.clear', { defaultValue: 'Clear' })}
          className="absolute right-[var(--space-2)] top-1/2 inline-flex -translate-y-1/2 cursor-pointer items-center justify-center rounded-[var(--chrome-radius-pill)] border-0 bg-transparent p-[3px] text-[var(--chrome-fg-dim)] hover:text-[var(--chrome-fg)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
