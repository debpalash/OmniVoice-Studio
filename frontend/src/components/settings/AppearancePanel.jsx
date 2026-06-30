/**
 * Settings → Appearance panel.
 *
 * Houses the UI scale (S/M/L) and color-theme picker that used to live in
 * the always-visible LogsFooter chrome. Moved here because they're
 * rarely-used preferences that don't need to compete with logs / error
 * counts on every screen — Settings is where appearance config belongs.
 */
import React from 'react';
import { Palette } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore, FONT_OPTIONS, FONT_STACKS } from '../../store';
import { SettingsSection, SettingRow, InfoHint, SettingsToggle } from './primitives';
import './AppearancePanel.css';

const THEMES = [
  { id: 'gruvbox', label: 'Gruvbox', dot: '#d3869b' },
  { id: 'midnight', label: 'Midnight', dot: '#8b5cf6' },
  { id: 'nord', label: 'Nord', dot: '#88c0d0' },
  { id: 'solarized', label: 'Solarized', dot: '#268bd2' },
  { id: 'rose-pine', label: 'Rosé Pine', dot: '#ebbcba' },
  { id: 'catppuccin', label: 'Catppuccin', dot: '#cba6f7' },
];

export default function AppearancePanel() {
  const { t } = useTranslation();
  const uiScale = useAppStore((s) => s.uiScale);
  const setUiScale = useAppStore((s) => s.setUiScale);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const font = useAppStore((s) => s.font);
  const setFont = useAppStore((s) => s.setFont);
  const autoPlayPreview = useAppStore((s) => s.autoPlayPreview);
  const setAutoPlayPreview = useAppStore((s) => s.setAutoPlayPreview);

  const scaleLabel = t('settings.ui_scale', { defaultValue: 'UI scale' });
  const themeLabel = t('settings.color_theme', { defaultValue: 'Color theme' });
  const fontLabel = t('settings.font', { defaultValue: 'Font' });

  return (
    <SettingsSection
      className="appearance-panel"
      icon={Palette}
      title={t('settings.appearance', { defaultValue: 'Appearance' })}
      actions={
        <InfoHint label={t('settings.appearance', { defaultValue: 'Appearance' })}>
          {t('settings.appearance_help', {
            defaultValue:
              'These controls used to live in the bottom logs bar — moved here so the footer can stay focused on logs. Changes apply instantly and persist across launches.',
          })}
        </InfoHint>
      }
    >
      <SettingRow
        title={scaleLabel}
        control={
          <div className="inline-flex w-[clamp(160px,100%,260px)] min-w-0 items-center gap-[var(--space-4)]">
            <input
              type="range"
              min="0.6"
              max="1.75"
              step="0.05"
              value={uiScale}
              onChange={(e) => setUiScale(Number(e.target.value))}
              aria-label={scaleLabel}
              aria-valuetext={`${Math.round(uiScale * 100)}%`}
              className="min-w-0 flex-1 cursor-pointer accent-[var(--chrome-accent)]"
            />
            <span className="min-w-[40px] text-right text-[length:var(--text-sm)] tabular-nums text-[var(--chrome-fg)]">
              {Math.round(uiScale * 100)}%
            </span>
          </div>
        }
      />

      <SettingRow
        title={themeLabel}
        control={
          <div
            className="inline-flex items-center gap-[var(--space-4)]"
            role="radiogroup"
            aria-label={themeLabel}
          >
            {THEMES.map((th) => (
              <button
                key={th.id}
                type="button"
                className={`appearance-panel__theme-dot ${theme === th.id ? 'is-active' : ''}`}
                style={{ '--dot-color': th.dot }}
                onClick={() => setTheme(th.id)}
                title={th.label}
                aria-label={th.label}
                aria-checked={theme === th.id}
                role="radio"
              />
            ))}
          </div>
        }
      />

      <SettingRow
        className="appearance-panel__row--fonts st-row--stack"
        align="start"
        title={fontLabel}
        control={
          <div
            className="grid w-full min-w-0 grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-[var(--space-3)]"
            role="radiogroup"
            aria-label={fontLabel}
          >
            {FONT_OPTIONS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={font === f.id}
                aria-label={f.label}
                data-testid={`appearance-font-${f.id}`}
                className={`appearance-panel__font-tile ${font === f.id ? 'is-active' : ''}`}
                style={{ fontFamily: FONT_STACKS[f.id] || 'var(--font-sans)' }}
                onClick={() => setFont(f.id)}
              >
                <span className="appearance-panel__font-sample">Ag</span>
                <span className="appearance-panel__font-name">{f.label}</span>
              </button>
            ))}
          </div>
        }
      />

      <SettingRow
        title={t('settings.autoplay_preview', { defaultValue: 'Auto-play preview' })}
        subtitle={t('settings.autoplay_preview_label', {
          defaultValue: 'Play the output as soon as a render finishes',
        })}
        control={
          <SettingsToggle
            checked={autoPlayPreview}
            onChange={setAutoPlayPreview}
            id="autoplay-preview"
            aria-label={t('settings.autoplay_preview', { defaultValue: 'Auto-play preview' })}
          />
        }
      />
    </SettingsSection>
  );
}
