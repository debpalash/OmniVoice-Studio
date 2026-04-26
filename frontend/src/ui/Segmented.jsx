import React from 'react';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import './Segmented.css';

/**
 * Segmented — compact segmented control for small option sets.
 * Backed by @radix-ui/react-toggle-group for keyboard navigation
 * and proper aria-pressed state management.
 *
 * @param items    array of { value, label, title? }
 * @param value    currently selected `value`
 * @param onChange (value) => void
 * @param size     'xs' | 'sm'
 */
export default function Segmented({
  items = [],
  value,
  onChange,
  size = 'sm',
  className = '',
  ...rest
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(val) => {
        // Radix fires '' when you re-click the active item; ignore that
        if (val) onChange?.(val);
      }}
      className={`ui-seg ui-seg--size-${size} ${className}`}
      {...rest}
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          className={`ui-seg__opt ${value === item.value ? 'is-active' : ''}`}
          title={item.title || undefined}
        >
          {item.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
