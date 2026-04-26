import React, { useCallback, isValidElement } from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { ChevronRight } from 'lucide-react';
import './Menu.css';

/**
 * Menu — floating action menu triggered by a child element.
 * Backed by @radix-ui/react-dropdown-menu for keyboard navigation,
 * collision-aware positioning, and proper ARIA attributes.
 *
 * @param children   exactly one child — the trigger element
 * @param items      array of items or 'separator' strings
 * @param placement  'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
 * @param open       controlled open state (optional)
 * @param onOpenChange callback on open/close
 * @param width      optional fixed width (px)
 * @param disabled   disable the trigger
 */
export default function Menu({
  children,
  items = [],
  placement = 'bottom-start',
  open: controlledOpen,
  onOpenChange,
  width,
  disabled = false,
}) {
  // Map our placement string to Radix side + align
  const sideMap = {
    'bottom-start': { side: 'bottom', align: 'start' },
    'bottom-end':   { side: 'bottom', align: 'end' },
    'top-start':    { side: 'top',    align: 'start' },
    'top-end':      { side: 'top',    align: 'end' },
  };
  const { side, align } = sideMap[placement] || sideMap['bottom-start'];

  if (!isValidElement(children)) {
    return children ?? null;
  }

  const rootProps = {};
  if (controlledOpen != null) {
    rootProps.open = controlledOpen;
    rootProps.onOpenChange = onOpenChange;
  } else if (onOpenChange) {
    rootProps.onOpenChange = onOpenChange;
  }

  return (
    <RadixMenu.Root {...rootProps}>
      <RadixMenu.Trigger asChild disabled={disabled}>
        {children}
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          side={side}
          align={align}
          sideOffset={4}
          className={`ui-menu ui-menu--below ui-menu--${align}`}
          style={width ? { width } : undefined}
        >
          {items.map((item, i) => {
            if (item === 'separator' || item?.type === 'separator') {
              return <RadixMenu.Separator key={`sep-${i}`} className="ui-menu__separator" />;
            }
            const Icon = item.icon;
            return (
              <RadixMenu.Item
                key={item.id ?? i}
                className={`ui-menu__item ${item.destructive ? 'is-destructive' : ''} ${item.disabled ? 'is-disabled' : ''}`}
                disabled={item.disabled}
                onSelect={() => item.onSelect?.()}
              >
                {Icon && <Icon size={12} className="ui-menu__icon" />}
                <span className="ui-menu__label">{item.label}</span>
                {item.shortcut && <span className="ui-menu__shortcut">{item.shortcut}</span>}
                {item.trailing}
              </RadixMenu.Item>
            );
          })}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}
