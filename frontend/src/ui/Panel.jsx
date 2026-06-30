import React, { forwardRef } from 'react';
// Panel.css now holds ONLY the glass variant's backdrop-filter + gradient
// surface + ::before highlight (effects Tailwind utilities can't express).
// Everything else is utilities below. The `.ui-panel*` class names are kept so
// the retained glass rule and external contextual overrides
// (`.glossary-panel .ui-panel__body`, `.voice-profile__hero .ui-panel__body`)
// still match.

/* Token-faithful utilities. App ships Tailwind v4 without Preflight and themes
 * override `--color-*`, so colors/borders/shadows use arbitrary properties
 * referencing the exact original variables (radius/color use the @theme-mapped
 * named utilities, which resolve to the same `var(--…)` and track themes). */

const VARIANT = {
  // glass: surface (gradients + backdrop-filter) + ::before stay in Panel.css.
  glass: '[border:1px_solid_var(--color-border-warm)]',
  solid:
    '[border:1px_solid_var(--color-border-warm)] ' +
    '[background-image:linear-gradient(160deg,#2a2624_0%,#201c1b_100%)] [box-shadow:var(--shadow-md)]',
  flat: '[border:1px_solid_var(--color-border)] [background-color:rgba(0,0,0,0.08)]',
};

const PAD = {
  none: 'p-0',
  sm: 'p-[var(--space-4)]',
  md: 'p-[var(--space-5)]',
  lg: 'p-[var(--space-6)]',
};

/**
 * Panel — a content surface. Replaces the ad-hoc card divs + `.glass-panel`.
 *
 * @param variant 'glass' | 'solid' | 'flat'
 * @param padding 'none' | 'sm' | 'md' | 'lg'
 * @param title   optional string or node rendered in the panel header
 * @param actions optional node rendered on the right of the header
 * @param as      element tag ('div' | 'section' | 'article' …)
 */
const Panel = forwardRef(function Panel(
  {
    variant = 'glass',
    padding = 'md',
    title = null,
    actions = null,
    as: Tag = 'section',
    className = '',
    children,
    ...rest
  },
  ref,
) {
  const classes = [
    'ui-panel',
    `ui-panel--${variant}`,
    'relative overflow-hidden rounded-lg text-fg',
    VARIANT[variant] || VARIANT.glass,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const hasHeader = title != null || actions != null;
  const bodyClasses = ['ui-panel__body', PAD[padding] || PAD.md, hasHeader && 'pt-[var(--space-4)]']
    .filter(Boolean)
    .join(' ');

  return (
    <Tag ref={ref} className={classes} {...rest}>
      {hasHeader && (
        <header className="ui-panel__header flex items-center justify-between py-[var(--space-4)] px-[var(--space-5)] gap-[var(--space-4)] [border-bottom:1px_solid_var(--color-border)]">
          {title != null && (
            <div className="ui-panel__title flex items-center gap-[var(--space-3)] min-w-0 [font-size:var(--text-md)] font-bold text-fg tracking-[-0.01em]">
              {title}
            </div>
          )}
          {actions != null && (
            <div className="ui-panel__actions flex items-center gap-[var(--space-3)] shrink-0">
              {actions}
            </div>
          )}
        </header>
      )}
      <div className={bodyClasses}>{children}</div>
    </Tag>
  );
});

export default Panel;
