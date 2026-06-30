import React from 'react';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import './Segmented.css';

const ROOT =
  'ui-seg inline-flex gap-[2px] bg-[rgba(0,0,0,0.28)] p-[3px] rounded-[var(--radius-pill)] [border:1px_solid_var(--color-border)] shrink';

// Option base + interaction states. Active/hover keyed off Radix's `data-state`
// (on/off) rather than a class, so the variants live on the element itself.
// `:focus-visible` stays in Segmented.css — see the note there.
const OPT =
  'ui-seg__opt font-sans font-extrabold border-0 rounded-[var(--radius-pill)] cursor-pointer bg-transparent text-fg-subtle whitespace-nowrap transition-[background,color] duration-[var(--dur-fast)] ease-[var(--ease-out)] data-[state=off]:hover:text-fg data-[state=off]:hover:bg-[rgba(255,255,255,0.04)] data-[state=on]:bg-[rgba(243,165,182,0.25)] data-[state=on]:text-[#fff9ef]';

const SIZES = {
  xs: 'px-[9px] py-[2px] text-[0.58rem]',
  sm: 'px-[10px] py-[3px] text-[0.62rem]',
};

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
      className={`${ROOT} ${className}`}
      {...rest}
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          className={`${OPT} ${SIZES[size] ?? SIZES.sm}`}
          title={item.title || undefined}
        >
          {item.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
