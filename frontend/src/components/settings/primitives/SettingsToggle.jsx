import React from 'react';

/**
 * SettingsToggle — a token-styled accessible switch.
 *
 * Renders a real `<input type="checkbox" role="switch">` (visually hidden) so
 * label/role-based queries and keyboard focus work; the visible track + knob is
 * a sibling styled element. Visual reference: VoicePanel's `voicepanel__switch`.
 *
 * @param {boolean}   checked     on/off state
 * @param {function}  onChange    called with the next boolean value
 * @param {boolean=}  disabled    disable interaction
 * @param {string=}   id          id forwarded to the input (for an external <label htmlFor>)
 * @param {string=}   aria-label  accessible label when there's no visible <label>
 */
export default function SettingsToggle({
  checked,
  onChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  ...rest
}) {
  return (
    <label
      className={`st-toggle ${checked ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`.trim()}
    >
      <input
        type="checkbox"
        role="switch"
        id={id}
        className="st-toggle__input"
        checked={!!checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange?.(e.target.checked)}
        {...rest}
      />
      <span className="st-toggle__track" aria-hidden="true">
        <span className="st-toggle__knob" />
      </span>
    </label>
  );
}
