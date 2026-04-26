import React from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import './Tooltip.css';

/**
 * Tooltip — keyboard-accessible replacement for `title=`.
 * Backed by @radix-ui/react-tooltip for collision-aware positioning.
 *
 * @param content    tooltip body (string or node)
 * @param placement  'top' | 'bottom' | 'left' | 'right'
 * @param delay      ms before showing (default 300)
 */
export default function Tooltip({
  content,
  placement = 'top',
  delay = 300,
  children,
}) {
  if (!content) return children;

  // Map our placement names to Radix side names
  const sideMap = { top: 'top', bottom: 'bottom', left: 'left', right: 'right' };
  const side = sideMap[placement] || 'top';

  return (
    <RadixTooltip.Provider delayDuration={delay}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>
          {children}
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={5}
            className={`ui-tooltip ui-tooltip--${placement}`}
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
