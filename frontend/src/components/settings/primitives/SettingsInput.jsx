import React from 'react';

/**
 * SettingsInput — the token-styled text field for Settings.
 *
 * Replaces the ad-hoc `.settings-credential__input` / `.models-search` inputs
 * with one shared primitive that themes across all 6 chrome themes (it derives
 * from --chrome-* / --space-* / --text-* only). Drop it inside a SettingRow's
 * `control`, or use it standalone.
 *
 * @param {string}    value
 * @param {function}  onChange
 * @param {function=} onKeyDown
 * @param {string=}   placeholder
 * @param {string=}   type        input type (default 'text')
 * @param {boolean=}  mono        render the value monospace (tokens, paths)
 * @param {boolean=}  disabled
 * @param {string=}   className   extra class
 * @param {string=}   'aria-label'
 */
export default function SettingsInput({
  value,
  onChange,
  onKeyDown,
  placeholder,
  type = 'text',
  mono = false,
  disabled = false,
  className = '',
  ...rest
}) {
  return (
    <input
      type={type}
      className={`st-input ${mono ? 'st-input--mono' : ''} ${className}`.trim()}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      {...rest}
    />
  );
}
