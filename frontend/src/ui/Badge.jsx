import React from 'react';
import './Badge.css';

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
    <span className={`ui-badge ui-badge--${tone} ui-badge--size-${size} ${className}`} {...rest}>
      {dot && <span className="ui-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
