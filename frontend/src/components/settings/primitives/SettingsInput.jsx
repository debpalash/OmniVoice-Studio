import React from 'react';
import { cn } from '@/lib/utils';

/**
 * SettingsInput — the token-styled text field for Settings.
 *
 * FAST-mode shadcn migration: styling is now Tailwind utilities on the OmniVoice
 * `--chrome-*` / `--space-*` token bridge (palette preserved exactly); the old
 * `.st-input*` rules in primitives.css are gone. Drop it inside a SettingRow's
 * `control`, or use it standalone. In a stacked SettingRow it stretches to fill
 * (the row's control slot targets `[data-slot=settings-input]`).
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
      data-slot="settings-input"
      type={type}
      className={cn(
        'w-full min-w-0 max-w-[min(360px,100%)] box-border rounded-[var(--chrome-radius-pill)] border border-transparent bg-[color-mix(in_srgb,var(--chrome-bg)_94%,white)] px-[var(--space-4)] py-[var(--space-3)] text-[color:var(--chrome-fg)] [font-family:var(--font-sans)] text-[length:var(--text-sm)] focus:outline-none focus:border-[var(--chrome-accent)] disabled:opacity-50 disabled:cursor-not-allowed',
        mono && '[font-family:var(--chrome-font-mono)]',
        className,
      )}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      {...rest}
    />
  );
}
