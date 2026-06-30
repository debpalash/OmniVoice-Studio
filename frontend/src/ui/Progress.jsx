import React from 'react';
import * as RadixProgress from '@radix-ui/react-progress';
import './Progress.css';

const ROOT = 'ui-progress w-full bg-[rgba(0,0,0,0.3)] rounded-sm overflow-hidden relative';

const SIZES = { xs: 'h-[2px]', sm: 'h-[4px]', md: 'h-[6px]' };

const FILL =
  'ui-progress__fill relative h-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]';

const TONES = {
  brand: 'bg-[linear-gradient(90deg,var(--color-brand),var(--color-accent))]',
  success: 'bg-[linear-gradient(90deg,var(--color-success),var(--color-accent))]',
  warn: 'bg-[linear-gradient(90deg,var(--color-accent),var(--color-warn))]',
  danger: 'bg-[linear-gradient(90deg,var(--color-danger),var(--color-warn))]',
};

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
  const isInvalid = value != null && (!Number.isFinite(value) || Number.isNaN(value));
  const safeValue = isInvalid ? null : value;
  const indeterminate = safeValue == null;
  const showShimmer = shimmer ?? !indeterminate;
  const clamped = indeterminate ? null : Math.max(0, Math.min(100, safeValue));

  return (
    <RadixProgress.Root
      value={clamped}
      max={100}
      // `ui-progress` + `is-indeterminate` are retained class hooks for the
      // shimmer / indeterminate CSS rules in Progress.css (keyframes + ::after).
      className={`${ROOT} ${SIZES[size] ?? SIZES.sm} ${indeterminate ? 'is-indeterminate' : ''} ${className}`}
      {...rest}
    >
      <RadixProgress.Indicator
        className={`${FILL} ${TONES[tone] ?? TONES.brand} ${showShimmer ? 'has-shimmer' : ''}`}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </RadixProgress.Root>
  );
}
