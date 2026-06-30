import React, { forwardRef } from 'react';
import { Loader } from 'lucide-react';
// Button.css is retained ONLY for external raw-class consumers (AudiobookTab.jsx
// uses `.ui-btn--{subtle,primary,icon}` directly). The Button COMPONENT below is
// fully Tailwind-utility-driven and no longer emits the `.ui-btn*` classes, so
// the stylesheet does not double-apply to component instances. Keep the import
// so those legacy classes still load app-wide.
import './Button.css';

/* ── Token-faithful Tailwind utility blocks ──────────────────────────────
 * The app ships Tailwind v4 WITHOUT Preflight and themes override the
 * `--chrome-*` design tokens, so colors/shadows/borders/transitions are
 * expressed as arbitrary *properties* (`[prop:value]`) referencing the exact
 * original CSS variables. This keeps every variant pixel-identical to the old
 * Button.css across all themes and avoids `--tw-*` composition (which needs
 * Preflight). Strings are full literals so Tailwind's scanner detects them. */

const BASE =
  'relative inline-flex items-center gap-[var(--space-3)] rounded-[var(--chrome-radius-pill)] ' +
  'font-sans tracking-[0.02em] cursor-pointer whitespace-nowrap select-none overflow-hidden ' +
  'focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)] ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

// transition: background/border-color/color (subtle/ghost/danger/chip/preset/icon)
const TR =
  '[transition:background_var(--dur-fast)_var(--ease-out),border-color_var(--dur-fast)_var(--ease-out),color_var(--dur-fast)_var(--ease-out)]';
// transition: background/box-shadow/transform (primary)
const TR_PRIMARY =
  '[transition:background_var(--dur-fast)_var(--ease-out),box-shadow_var(--dur-fast)_var(--ease-out),transform_var(--dur-fast)_var(--ease-out)]';

const SIZE = {
  sm: 'px-[10px] py-[3px] [font-size:var(--text-xs)]',
  md: 'px-[12px] py-[6px] [font-size:var(--text-md)]',
};

const ICON_SIZE = {
  sm: 'w-[20px] h-[20px] p-0',
  md: 'w-[22px] h-[22px] p-0',
};

const VARIANTS = {
  primary:
    'justify-center font-semibold [color:#1d2021] [border:1px_solid_transparent] ' +
    '[background-image:linear-gradient(135deg,var(--chrome-accent,#d3869b),color-mix(in_srgb,var(--chrome-accent,#d3869b)_70%,#c07090))] ' +
    '[box-shadow:0_0_0_1px_color-mix(in_srgb,var(--chrome-accent,#d3869b)_30%,transparent),0_1px_4px_color-mix(in_srgb,var(--chrome-accent,#d3869b)_15%,transparent)] ' +
    TR_PRIMARY +
    ' enabled:hover:[filter:brightness(1.1)] enabled:hover:[transform:translateY(-1px)] ' +
    'enabled:hover:[box-shadow:0_0_0_1px_color-mix(in_srgb,var(--chrome-accent,#d3869b)_45%,transparent),0_4px_12px_color-mix(in_srgb,var(--chrome-accent,#d3869b)_25%,transparent)] ' +
    'enabled:active:[transform:scale(0.98)] enabled:active:[filter:brightness(0.95)] ' +
    'enabled:active:[box-shadow:0_0_0_1px_color-mix(in_srgb,var(--chrome-accent,#d3869b)_30%,transparent)]',

  subtle:
    'justify-center font-medium [color:var(--chrome-fg-muted)] bg-transparent ' +
    '[border:1px_solid_var(--chrome-border)] ' +
    TR +
    ' enabled:hover:[background-color:var(--chrome-hover-bg)] enabled:hover:[color:var(--chrome-fg)] ' +
    'enabled:hover:[border-color:var(--chrome-border-strong)]',

  ghost:
    'justify-center font-medium [color:var(--chrome-fg-muted)] bg-transparent ' +
    '[border:1px_solid_transparent] ' +
    TR +
    ' enabled:hover:[background-color:var(--chrome-hover-bg)] enabled:hover:[color:var(--chrome-fg)]',

  danger:
    'justify-center font-medium [color:var(--chrome-severity-err)] ' +
    '[background-color:color-mix(in_srgb,var(--chrome-severity-err)_10%,transparent)] ' +
    '[border:1px_solid_color-mix(in_srgb,var(--chrome-severity-err)_45%,transparent)] ' +
    TR +
    ' enabled:hover:[background-color:color-mix(in_srgb,var(--chrome-severity-err)_18%,transparent)] ' +
    'enabled:hover:[border-color:var(--chrome-severity-err)]',
};

// chip / preset / icon carry their own padding + active (selected) state, so they
// don't use the SIZE map and swap their whole color block when `active`.
const CHIP = {
  base:
    'justify-center px-[8px] py-[2px] [font-size:var(--text-xs)] font-medium [color:var(--chrome-fg-muted)] ' +
    'bg-transparent [border:1px_solid_var(--chrome-border)] ' +
    TR +
    ' enabled:hover:[background-color:var(--chrome-hover-bg)] enabled:hover:[color:var(--chrome-fg)] ' +
    'enabled:hover:[border-color:var(--chrome-border-strong)]',
  active:
    'justify-center px-[8px] py-[2px] [font-size:var(--text-xs)] font-medium [color:var(--chrome-severity-ok)] ' +
    '[background-color:color-mix(in_srgb,var(--chrome-severity-ok)_12%,transparent)] ' +
    '[border:1px_solid_color-mix(in_srgb,var(--chrome-severity-ok)_45%,transparent)] ' +
    TR,
};

const PRESET = {
  base:
    'justify-start text-left px-[8px] py-[3px] [font-size:var(--text-xs)] font-medium [color:var(--chrome-fg-muted)] ' +
    'bg-transparent [border:1px_solid_var(--chrome-border)] ' +
    TR +
    ' enabled:hover:[background-color:var(--chrome-hover-bg)] enabled:hover:[color:var(--chrome-fg)] ' +
    'enabled:hover:[border-color:var(--chrome-border-strong)]',
  active:
    'justify-start text-left px-[8px] py-[3px] [font-size:var(--text-xs)] font-medium [color:var(--chrome-accent)] ' +
    '[background-color:var(--chrome-accent-bg)] [border:1px_solid_var(--chrome-accent-border)] ' +
    TR,
};

const ICON = {
  base:
    'justify-center font-medium [color:var(--chrome-fg-muted)] bg-transparent ' +
    '[border:1px_solid_var(--chrome-border)] ' +
    TR +
    ' enabled:hover:[background-color:var(--chrome-hover-bg)] enabled:hover:[color:var(--chrome-fg)] ' +
    'enabled:hover:[border-color:var(--chrome-border-strong)]',
  active:
    'justify-center font-medium [color:var(--chrome-accent)] [background-color:var(--chrome-accent-bg)] ' +
    '[border:1px_solid_var(--chrome-accent-border)] ' +
    TR,
};

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
  let variantClasses;
  let sizeClasses = '';
  if (variant === 'icon') {
    variantClasses = active ? ICON.active : ICON.base;
    sizeClasses = ICON_SIZE[iconSize] || ICON_SIZE.md;
  } else if (variant === 'chip') {
    variantClasses = active ? CHIP.active : CHIP.base;
  } else if (variant === 'preset') {
    variantClasses = active ? PRESET.active : PRESET.base;
  } else {
    variantClasses = VARIANTS[variant] || VARIANTS.subtle;
    sizeClasses = SIZE[size] || SIZE.md;
  }

  const classes = [
    BASE,
    variantClasses,
    sizeClasses,
    block && 'w-full',
    loading && 'cursor-wait',
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
      {loading ? <Loader size={variant === 'icon' ? 10 : 12} className="animate-spin" /> : leading}
      {variant !== 'icon' && children != null && <span className="leading-none">{children}</span>}
      {variant === 'icon' && children}
      {trailing}
    </button>
  );
});

export default Button;
