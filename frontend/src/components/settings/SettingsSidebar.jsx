import React from 'react';
import { RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { GROUPS } from './settingsCategories';

/**
 * SettingsSidebar — the grouped category navigation for the Settings hub.
 *
 * Wide (≥760px): a vertical rail of group headers + category items (icon +
 * label; active item = brand accent with an inset accent bar). Restart-bearing
 * categories show a small ↻ glyph.
 *
 * Narrow (<760px): collapses to a single native <select> drop-down (with
 * <optgroup> per group) so the whole IA stays reachable on a phone-width window.
 *
 * `visibleIds` (a Set) filters which categories render — the search box in the
 * parent drives it. Groups with no visible items are hidden entirely.
 *
 * @param {Set<string>} visibleIds  category ids to show (search-filtered)
 * @param {string}      active      active category id
 * @param {function}    onSelect    (id) => void
 */
export default function SettingsSidebar({ visibleIds, active, onSelect }) {
  const { t } = useTranslation();
  const isVisible = (id) => !visibleIds || visibleIds.has(id);
  const label = (it) => t(it.labelKey, { defaultValue: it.defaultLabel });

  return (
    <nav aria-label={t('settings.title', { defaultValue: 'Settings' })}>
      {/* Narrow: dropdown navigator */}
      <div className="min-[760px]:hidden">
        <select
          value={active}
          onChange={(e) => onSelect(e.target.value)}
          aria-label={t('settings.title', { defaultValue: 'Settings' })}
          data-testid="settings-nav-select"
          className="w-full min-w-0 box-border rounded-[var(--chrome-radius-pill)] border border-transparent bg-[color-mix(in_srgb,var(--chrome-bg)_94%,white)] px-[var(--space-4)] py-[var(--space-3)] text-[color:var(--chrome-fg)] [font-family:var(--font-sans)] text-[length:var(--text-sm)] focus:border-[var(--chrome-accent)] focus:outline-none"
        >
          {GROUPS.map((g) => {
            const items = g.items.filter((it) => isVisible(it.id));
            if (items.length === 0) return null;
            return (
              <optgroup key={g.id} label={t(g.labelKey, { defaultValue: g.defaultLabel })}>
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {label(it)}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </div>

      {/* Wide: vertical grouped rail */}
      <div className="hidden flex-col gap-[var(--space-4)] min-[760px]:flex">
        {GROUPS.map((g) => {
          const items = g.items.filter((it) => isVisible(it.id));
          if (items.length === 0) return null;
          return (
            <div key={g.id} className="flex flex-col gap-[2px]">
              <div className="px-[var(--space-3)] pb-[2px] [font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size,0.62rem)] font-semibold uppercase tracking-[var(--chrome-label-track,0.06em)] text-[color:var(--chrome-fg-dim)]">
                {t(g.labelKey, { defaultValue: g.defaultLabel })}
              </div>
              {items.map((it) => {
                const isActive = it.id === active;
                const Icon = it.icon;
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => onSelect(it.id)}
                    aria-current={isActive ? 'page' : undefined}
                    data-testid={`settings-nav-${it.id}`}
                    className={cn(
                      'group relative flex w-full appearance-none items-center gap-[var(--space-3)] rounded-[var(--chrome-radius-pill)] border border-transparent bg-transparent px-[var(--space-3)] py-[var(--space-2)] text-left [font-family:var(--font-sans)] text-[length:var(--text-sm)] transition-[background,color] duration-[120ms] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none',
                      isActive
                        ? 'bg-[var(--chrome-hover-bg)] font-semibold text-[color:var(--chrome-fg)] shadow-[inset_2px_0_0_var(--chrome-accent)]'
                        : 'font-medium text-[color:var(--chrome-fg-muted)] hover:bg-[var(--chrome-hover-bg)] hover:text-[color:var(--chrome-fg)]',
                    )}
                  >
                    {Icon && (
                      <Icon
                        size={14}
                        aria-hidden="true"
                        className={cn(
                          'shrink-0',
                          isActive
                            ? 'text-[var(--chrome-accent)]'
                            : 'text-[var(--chrome-fg-dim)] group-hover:text-[var(--chrome-fg-muted)]',
                        )}
                      />
                    )}
                    <span className="flex-auto truncate">{label(it)}</span>
                    {it.restart && (
                      <RotateCw
                        size={11}
                        aria-hidden="true"
                        className="shrink-0 text-[var(--chrome-fg-dim)] opacity-70"
                        title={t('settings.restart_required', { defaultValue: 'Restart required' })}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
