import React, { forwardRef } from 'react';
import { Loader } from 'lucide-react';
import './Button.css';

/**
 * Button — the one button. Variants cover every button pattern in the app.
 *
 * @param variant  'primary' | 'subtle' | 'ghost' | 'danger' | 'chip' | 'preset' | 'icon'
 * @param size     'sm' | 'md'                                (ignored for 'icon')
 * @param iconSize 'sm' | 'md'                                ('icon' variant only: 20 / 22 px)
 * @param active   visual pressed/active state (for chips + toggles)
 * @param loading  show spinner, disable button
 * @param leading  icon element rendered before children
 * @param trailing icon element rendered after children
 * @param block    stretch to container width
 */
const Button = forwardRef(function Button(
  {
    variant = 'subtle',
    size = 'md',
    iconSize = 'md',
    active = false,
    loading = false,
    disabled = false,
    leading = null,
    trailing = null,
    block = false,
    className = '',
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const classes = [
    'ui-btn',
    `ui-btn--${variant}`,
    variant === 'icon' ? `ui-btn--icon-${iconSize}` : `ui-btn--size-${size}`,
    active && 'is-active',
    loading && 'is-loading',
    block && 'ui-btn--block',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={variant === 'chip' || variant === 'preset' ? active : undefined}
      {...rest}
    >
      {loading ? (
        <Loader size={variant === 'icon' ? 10 : 12} className="ui-btn__spinner" />
      ) : (
        leading
      )}
      {variant !== 'icon' && children != null && <span className="ui-btn__label">{children}</span>}
      {variant === 'icon' && children}
      {trailing}
    </button>
  );
});

export default Button;
