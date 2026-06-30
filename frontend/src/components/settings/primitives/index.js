// ─────────────────────────────────────────────────────────────────
//  Settings design-system primitives
//
//  Shared building blocks for the Settings redesign. Compose these
//  inside every Settings panel/tab instead of re-implementing headers,
//  rows, toggles, hints, and disclosures.
//
//    import { SettingsSection, SettingRow, InfoHint,
//             SettingsToggle, Collapsible } from './primitives';
//
//  All styling lives in primitives.css (chrome tokens + space scale only),
//  imported once here so any consumer pulls it in.
// ─────────────────────────────────────────────────────────────────

import './primitives.css';

export { default as SettingsSection } from './SettingsSection.jsx';
export { default as SettingRow } from './SettingRow.jsx';
export { default as SettingsInput } from './SettingsInput.jsx';
export { default as InfoHint } from './InfoHint.jsx';
export { default as SettingsToggle } from './SettingsToggle.jsx';
export { default as Collapsible } from './Collapsible.jsx';
