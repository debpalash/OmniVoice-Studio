import React, { forwardRef, useId } from 'react';
// Input.css now holds ONLY the native <select> caret (appearance reset +
// data-URI arrow background + its hover border) — an SVG data-URI background
// that's impractical to express as a utility. Everything else is utilities
// below.
import './Input.css';

/* Token-faithful utilities. App ships Tailwind v4 without Preflight and themes
 * override the design tokens, so colors/borders/shadows/transitions use
 * arbitrary properties referencing the exact original variables; @theme-mapped
 * tokens use named utilities (text-fg, bg-bg-elev-2, rounded-md, text-danger…)
 * which resolve to the same `var(--…)` and track themes. */

// Shared shell for <input> / <textarea> / <select>.
const SHELL =
  'w-full box-border bg-bg-elev-2 rounded-md text-fg font-sans [border:1px_solid_var(--color-border)] ' +
  '[transition:background_var(--dur-base)_var(--ease-out),border-color_var(--dur-base)_var(--ease-out),box-shadow_var(--dur-base)_var(--ease-out)] ' +
  'placeholder:[color:rgba(168,153,132,0.5)] ' +
  'focus:outline-none focus:[border-color:rgba(211,134,155,0.5)] focus:[background-color:rgba(0,0,0,0.35)] ' +
  'focus:[box-shadow:0_0_0_2px_rgba(211,134,155,0.12),var(--shadow-inset)] ' +
  'disabled:opacity-40 disabled:cursor-not-allowed ' +
  'aria-[invalid=true]:[border-color:rgba(251,73,52,0.45)] ' +
  'aria-[invalid=true]:focus:[box-shadow:0_0_0_2px_rgba(251,73,52,0.15),var(--shadow-inset)]';

const SIZE = {
  sm: 'px-[6px] py-[3px] [font-size:var(--text-sm)]',
  md: 'px-[8px] py-[4px] [font-size:var(--text-base)]',
  lg: 'px-[10px] py-[6px] [font-size:var(--text-md)]',
};

const cx = (...parts) => parts.filter(Boolean).join(' ');

/**
 * Field — optional wrapper for label + input + hint/error.
 *
 * @param label   string rendered above the control
 * @param hint    small muted helper text below
 * @param error   string error message (overrides hint, adds error state)
 * @param icon    optional leading icon node (for Input variant)
 */
export function Field({ label, hint, error, icon, children }) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;

  const enriched = React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return child;
    const props = {
      id: child.props.id || id,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy,
    };
    // Replaces the `:has(.ui-field__icon) .ui-input { padding-left }` selector:
    // when an icon is present, push the control's text past it.
    if (icon) props.className = cx(child.props.className, 'pl-[22px]');
    return React.cloneElement(child, props);
  });

  return (
    <div className="ui-field flex flex-col gap-[var(--space-1)] min-w-0">
      {label && (
        <label
          htmlFor={id}
          className="ui-field__label [font-size:var(--text-xs)] font-semibold text-fg-muted tracking-[0.02em]"
        >
          {label}
        </label>
      )}
      <div className="ui-field__control relative flex items-center">
        {icon && (
          <span
            className="ui-field__icon absolute left-[7px] inline-flex text-fg-subtle pointer-events-none"
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        {enriched}
      </div>
      {error && (
        <div
          id={`${id}-err`}
          className="ui-field__error [font-size:var(--text-2xs)] text-danger mt-[var(--space-1)] font-medium"
        >
          {error}
        </div>
      )}
      {!error && hint && (
        <div
          id={`${id}-hint`}
          className="ui-field__hint [font-size:var(--text-2xs)] text-fg-subtle mt-[var(--space-1)]"
        >
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * Input — text / number / email / url input.
 * Replaces bare <input className="input-base" />.
 */
export const Input = forwardRef(function Input({ size = 'md', className = '', ...rest }, ref) {
  return <input ref={ref} className={cx(SHELL, SIZE[size] || SIZE.md, className)} {...rest} />;
});

/**
 * Textarea — multi-line input with optional auto-sizing.
 */
export const Textarea = forwardRef(function Textarea(
  { size = 'md', rows = 3, className = '', ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cx(SHELL, SIZE[size] || SIZE.md, 'min-h-[60px] resize-y leading-[1.5]', className)}
      {...rest}
    />
  );
});

/**
 * Select — styled native select (keeps keyboard + accessibility for free).
 * The `ui-select` class carries the caret (data-URI arrow) from Input.css.
 */
export const Select = forwardRef(function Select(
  { size = 'md', className = '', children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cx(SHELL, SIZE[size] || SIZE.md, 'ui-select', className)}
      {...rest}
    >
      {children}
    </select>
  );
});
