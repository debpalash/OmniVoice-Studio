import React, { forwardRef } from 'react';
import { Loader } from 'lucide-react';
import { Button as ShadcnButton } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils';
// Button.css is retained ONLY for external raw-class consumers (AudiobookTab.jsx
// uses `.ui-btn--{subtle,primary,icon}` directly). The Button COMPONENT below is
// now a thin wrapper over the shadcn/ui Button (src/components/ui/button.tsx) and
// no longer emits the `.ui-btn*` classes, so the stylesheet does not double-apply
// to component instances. Keep the import so those legacy classes still load
// app-wide.
import './Button.css';

/* ── Prop API → shadcn CVA mapping ───────────────────────────────────────
 * This wrapper preserves the exact legacy prop surface (variant / size /
 * iconSize / active / loading / leading / trailing / block / className / ref)
 * and maps it onto the OmniVoice variants/sizes that live in the shadcn
 * Button's CVA (button.tsx). The shadcn variants are styled with palette token
 * utilities (bg-primary, border-border, text-success, …) so every variant stays
 * on-palette and recolors with each [data-theme]. */

// variant → { shadcn variant, optional active-state variant }
const VARIANT_MAP = {
  primary: { base: 'primary' },
  subtle: { base: 'subtle' },
  ghost: { base: 'softGhost' },
  danger: { base: 'danger' },
  chip: { base: 'chip', active: 'chipActive' },
  preset: { base: 'preset', active: 'presetActive' },
  icon: { base: 'iconBtn', active: 'iconBtnActive' },
};

const SIZE_MAP = { sm: 'omniSm', md: 'omniMd' };
const ICON_SIZE_MAP = { sm: 'iconSm', md: 'iconMd' };

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
  const map = VARIANT_MAP[variant] || VARIANT_MAP.subtle;
  const cvaVariant = active && map.active ? map.active : map.base;

  let cvaSize;
  if (variant === 'icon') {
    cvaSize = ICON_SIZE_MAP[iconSize] || ICON_SIZE_MAP.md;
  } else if (variant === 'chip') {
    cvaSize = 'chip';
  } else if (variant === 'preset') {
    cvaSize = 'preset';
  } else {
    cvaSize = SIZE_MAP[size] || SIZE_MAP.md;
  }

  return (
    <ShadcnButton
      ref={ref}
      type={type}
      variant={cvaVariant}
      size={cvaSize}
      className={cn(block && 'w-full', loading && 'cursor-wait', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={variant === 'chip' || variant === 'preset' ? active : undefined}
      {...rest}
    >
      {loading ? <Loader size={variant === 'icon' ? 10 : 12} className="animate-spin" /> : leading}
      {variant !== 'icon' && children != null && <span className="leading-none">{children}</span>}
      {variant === 'icon' && children}
      {trailing}
    </ShadcnButton>
  );
});

export default Button;
