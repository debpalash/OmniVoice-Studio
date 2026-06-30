import React, { forwardRef, useId } from 'react';
import './Input.css';

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
    return React.cloneElement(child, {
      id: child.props.id || id,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy,
    });
  });

  return (
    <div className={`ui-field ${error ? 'is-error' : ''}`}>
      {label && (
        <label htmlFor={id} className="ui-field__label">
          {label}
        </label>
      )}
      <div className="ui-field__control">
        {icon && (
          <span className="ui-field__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        {enriched}
      </div>
      {error && (
        <div id={`${id}-err`} className="ui-field__error">
          {error}
        </div>
      )}
      {!error && hint && (
        <div id={`${id}-hint`} className="ui-field__hint">
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
  return <input ref={ref} className={`ui-input ui-input--size-${size} ${className}`} {...rest} />;
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
      className={`ui-input ui-textarea ui-input--size-${size} ${className}`}
      {...rest}
    />
  );
});

/**
 * Select — styled native select (keeps keyboard + accessibility for free).
 */
export const Select = forwardRef(function Select(
  { size = 'md', className = '', children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={`ui-input ui-select ui-input--size-${size} ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
});
