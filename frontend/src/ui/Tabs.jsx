import React from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import './Tabs.css';

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
  return (
    <RadixTabs.Root
      value={value}
      onValueChange={onChange}
      activationMode="manual"
    >
      <RadixTabs.List
        className={`ui-tabs ui-tabs--${variant} ui-tabs--size-${size} ${className}`}
        {...rest}
      >
        {items.map((item) => {
          const active = value === item.id;
          const Icon = item.icon;
          return (
            <RadixTabs.Trigger
              key={item.id}
              value={item.id}
              className={`ui-tabs__tab ${active ? 'is-active' : ''}`}
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
