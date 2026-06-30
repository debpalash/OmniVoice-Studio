import React from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';

/**
 * Tabs — pill-style segmented tab group, backed by @radix-ui/react-tabs.
 *
 * Provides roving tabindex, arrow-key navigation, and proper
 * aria-selected / role="tab" / role="tablist" attributes.
 *
 * @param items     array of { id, label, icon?, accent? }
 * @param value     currently selected id
 * @param onChange  (id) => void
 * @param size      'sm' | 'md'
 * @param variant   'pill' (default) | 'underline'
 */
export default function Tabs({
  items = [],
  value,
  onChange,
  size = 'md',
  variant = 'pill',
  className = '',
  ...rest
}) {
  const isPill = variant === 'pill';
  const isSm = size === 'sm';

  // The `ui-tabs*` / `is-active` semantic classes carry no styling here (the
  // Tabs.css that defined them was converted to the utilities below). They are
  // retained as stable hooks for page-level overrides — Settings.css restyles
  // the tab rail via `.ui-tabs.settings-tabs-ui .ui-tabs__tab.is-active …`,
  // which is unlayered and so still wins over these layered utilities.
  const listClass = isPill
    ? 'inline-flex shrink-0 gap-[3px] rounded-[var(--chrome-radius-pill)] border border-[var(--chrome-border)] bg-[var(--chrome-bg)] p-[3px]'
    : 'inline-flex shrink-0 gap-[var(--space-5)] border-b border-[var(--chrome-border)]';

  return (
    <RadixTabs.Root value={value} onValueChange={onChange} activationMode="manual">
      <RadixTabs.List className={`ui-tabs ${listClass} ${className}`} {...rest}>
        {items.map((item) => {
          const active = value === item.id;
          const Icon = item.icon;
          const tabClass = isPill
            ? [
                'relative flex flex-[0_0_auto] cursor-pointer items-center justify-center gap-[var(--space-3)] rounded-[var(--chrome-radius-pill)] border font-sans tracking-[0.01em]',
                '[transition:background_var(--dur-fast)_var(--ease-out),color_var(--dur-fast)_var(--ease-out),border-color_var(--dur-fast)_var(--ease-out)]',
                'focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none',
                isSm
                  ? 'px-[10px] py-[3px] text-[length:var(--text-xs)]'
                  : 'px-[14px] py-[5px] text-[length:var(--text-base)]',
                active
                  ? 'border-[var(--chrome-accent-border)] bg-[var(--chrome-accent-bg)] font-semibold text-[color:var(--chrome-accent)]'
                  : 'border-transparent bg-transparent font-medium text-[color:var(--chrome-fg-muted)] hover:bg-[var(--chrome-hover-bg)] hover:text-[color:var(--chrome-fg)]',
              ].join(' ')
            : [
                'mb-[-1px] flex cursor-pointer items-center gap-[var(--space-2)] border-b-2 bg-transparent px-[2px] py-[6px] font-sans font-medium text-[length:var(--text-base)]',
                '[transition:color_var(--dur-fast),border-color_var(--dur-fast)]',
                'focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none',
                active
                  ? 'border-b-[var(--chrome-accent)] text-[color:var(--chrome-accent)]'
                  : 'border-b-transparent text-[color:var(--chrome-fg-muted)] hover:text-[color:var(--chrome-fg)]',
              ].join(' ');
          return (
            <RadixTabs.Trigger
              key={item.id}
              value={item.id}
              className={`ui-tabs__tab ${active ? 'is-active' : ''} ${tabClass}`}
              style={active && item.accent ? { '--ui-tab-accent': item.accent } : undefined}
            >
              {Icon && <Icon size={12} className="ui-tabs__icon" />}
              <span>{item.label}</span>
            </RadixTabs.Trigger>
          );
        })}
      </RadixTabs.List>
    </RadixTabs.Root>
  );
}
