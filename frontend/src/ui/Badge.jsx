import React from 'react';
import './Badge.css';

// Base chrome chip — mono uppercase pill. Background + border are set per-tone
// (every tone specifies both), so they are NOT in the base to avoid utility
// ordering ambiguity with the tone overrides.
const BASE =
  'inline-flex items-center gap-[2px] rounded-[var(--chrome-radius-pill)] font-mono font-semibold tracking-[var(--chrome-label-track)] uppercase whitespace-nowrap select-none leading-[1.2]';

// tones — `color` drives the dot fill (currentColor); border + fill are explicit
// so the badge reads as a chrome chip, not a filled pill.
const TONES = {
  neutral:
    'text-[var(--chrome-fg-muted)] [border:1px_solid_var(--chrome-border-strong)] bg-transparent',
  brand:
    'text-[var(--chrome-accent)] [border:1px_solid_var(--chrome-accent-border)] bg-[var(--chrome-accent-bg)]',
  success:
    'text-[var(--chrome-severity-ok)] [border:1px_solid_color-mix(in_srgb,var(--chrome-severity-ok)_45%,transparent)] bg-[color-mix(in_srgb,var(--chrome-severity-ok)_10%,transparent)]',
  warn: 'text-[var(--chrome-severity-warn)] [border:1px_solid_color-mix(in_srgb,var(--chrome-severity-warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--chrome-severity-warn)_10%,transparent)]',
  danger:
    'text-[var(--chrome-severity-err)] [border:1px_solid_color-mix(in_srgb,var(--chrome-severity-err)_45%,transparent)] bg-[color-mix(in_srgb,var(--chrome-severity-err)_10%,transparent)]',
  info: 'text-[#83a598] [border:1px_solid_color-mix(in_srgb,#83a598_45%,transparent)] bg-[color-mix(in_srgb,#83a598_10%,transparent)]',
  violet:
    'text-[var(--chrome-fg-muted)] [border:1px_solid_var(--chrome-border-strong)] bg-transparent',
};

const SIZES = {
  xs: 'px-[6px] py-0 text-[11px]',
  sm: 'px-[7px] py-[1px] text-[11px]',
};

/**
 * Badge — small status pill. Replaces the various inline-styled pills
 * scattered through Header, Sidebar, and history views.
 *
 * @param tone 'neutral' | 'brand' | 'success' | 'warn' | 'danger' | 'info' | 'violet'
 * @param size 'xs' | 'sm'
 */
export default function Badge({
  tone = 'neutral',
  size = 'sm',
  dot = false,
  className = '',
  children,
  ...rest
}) {
  return (
    <span
      className={`ui-badge ${BASE} ${TONES[tone] ?? TONES.neutral} ${SIZES[size] ?? SIZES.sm} ${className}`}
      {...rest}
    >
      {/* `ui-badge__dot` retained so the externally-applied `.ui-badge--pulse`
          modifier (Header status badge) can still animate the dot via CSS. */}
      {dot && (
        <span
          className="ui-badge__dot h-[5px] w-[5px] rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
