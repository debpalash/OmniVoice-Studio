import React from 'react';
import * as RadixProgress from '@radix-ui/react-progress';
import './Progress.css';

/**
 * Progress — determinate or indeterminate progress bar.
 * Backed by @radix-ui/react-progress for proper ARIA value attributes.
 *
 * @param value       0–100 when determinate. Omit for indeterminate.
 * @param tone        'brand' (default) | 'success' | 'warn' | 'danger'
 * @param size        'xs' | 'sm' | 'md'
 * @param shimmer     add moving highlight overlay (default true when determinate)
 */
export default function Progress({
  value,
  tone = 'brand',
  size = 'sm',
  shimmer,
  className = '',
  ...rest
}) {
  const indeterminate = value == null;
  const showShimmer = shimmer ?? !indeterminate;
  const clamped = indeterminate ? null : Math.max(0, Math.min(100, value));

  return (
    <RadixProgress.Root
      value={clamped}
      max={100}
      className={`ui-progress ui-progress--${tone} ui-progress--size-${size} ${indeterminate ? 'is-indeterminate' : ''} ${className}`}
      {...rest}
    >
      <RadixProgress.Indicator
        className={`ui-progress__fill ${showShimmer ? 'has-shimmer' : ''}`}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </RadixProgress.Root>
  );
}
