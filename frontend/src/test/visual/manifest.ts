// Single source of truth for what the visual-regression suite captures.
//
// COMPONENTS must stay in sync with the keys in specs.jsx (the harness
// renders an error state for any name not found there, which would itself
// fail the snapshot — so drift is caught, not silent).
//
// THEMES: 'default' is the bare-:root Gruvbox Dark; every other name maps to
// a [data-theme="…"] block in ui/themes.css.
export const COMPONENTS = ['Badge', 'Button', 'Panel', 'SettingRow', 'SettingsToggle'] as const;

export const THEMES = ['default', 'midnight', 'catppuccin'] as const;
