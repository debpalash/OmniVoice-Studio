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
import './AppearancePanel.css';

const THEMES = [
  { id: 'gruvbox',    label: 'Gruvbox',    dot: '#d3869b' },
  { id: 'midnight',   label: 'Midnight',   dot: '#8b5cf6' },
  { id: 'nord',       label: 'Nord',       dot: '#88c0d0' },
  { id: 'solarized',  label: 'Solarized',  dot: '#268bd2' },
  { id: 'rose-pine',  label: 'Rosé Pine',  dot: '#ebbcba' },
  { id: 'catppuccin', label: 'Catppuccin', dot: '#cba6f7' },
];

export default function AppearancePanel() {
  const { t } = useTranslation();
  const uiScale    = useAppStore(s => s.uiScale);
  const setUiScale = useAppStore(s => s.setUiScale);
  const theme      = useAppStore(s => s.theme);
  const setTheme   = useAppStore(s => s.setTheme);
  const font       = useAppStore(s => s.font);
  const setFont    = useAppStore(s => s.setFont);
  const autoPlayPreview    = useAppStore(s => s.autoPlayPreview);
  const setAutoPlayPreview = useAppStore(s => s.setAutoPlayPreview);

  const scaleLabel = t('settings.ui_scale', { defaultValue: 'UI scale' });
  const themeLabel = t('settings.color_theme', { defaultValue: 'Color theme' });
  const fontLabel  = t('settings.font', { defaultValue: 'Font' });

  return (
    <section className="appearance-panel" aria-labelledby="appearance-panel-heading">
      <h3 id="appearance-panel-heading" className="appearance-panel__title">
        <Palette size={14} /> {t('settings.appearance', { defaultValue: 'Appearance' })}
      </h3>

      <div className="appearance-panel__row">
        <span className="appearance-panel__label">{scaleLabel}</span>
        <div className="appearance-panel__scale">
          <input
            type="range"
            min="0.6"
            max="1.75"
            step="0.05"
            value={uiScale}
            onChange={(e) => setUiScale(Number(e.target.value))}
            aria-label={scaleLabel}
            aria-valuetext={`${Math.round(uiScale * 100)}%`}
          />
          <span className="appearance-panel__scale-val">{Math.round(uiScale * 100)}%</span>
        </div>
      </div>

      <div className="appearance-panel__row">
        <span className="appearance-panel__label">{themeLabel}</span>
        <div className="appearance-panel__themes" role="radiogroup" aria-label={themeLabel}>
          {THEMES.map(th => (
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
      </div>

      <div className="appearance-panel__row appearance-panel__row--stack">
        <span className="appearance-panel__label">{fontLabel}</span>
        <div className="appearance-panel__fonts" role="radiogroup" aria-label={fontLabel}>
          {FONT_OPTIONS.map(f => (
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
      </div>

      <div className="appearance-panel__row">
        <span className="appearance-panel__label">
          {t('settings.autoplay_preview', { defaultValue: 'Auto-play preview' })}
        </span>
        <label
          className="appearance-panel__toggle"
          title={t('settings.autoplay_preview_hint', {
            defaultValue: 'When off, a finished render no longer starts playing on its own — useful when batch-generating segments (#666).',
          })}
        >
          <input
            type="checkbox"
            checked={autoPlayPreview}
            onChange={(e) => setAutoPlayPreview(e.target.checked)}
            data-testid="autoplay-preview"
          />
          <span>
            {t('settings.autoplay_preview_label', {
              defaultValue: 'Play the output as soon as a render finishes',
            })}
          </span>
        </label>
      </div>

      <p className="appearance-panel__help">
        {t('settings.appearance_help', {
          defaultValue:
            'These controls used to live in the bottom logs bar — moved here so the footer can stay focused on logs. Changes apply instantly and persist across launches.',
        })}
      </p>
    </section>
  );
}
