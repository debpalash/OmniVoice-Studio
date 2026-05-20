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
import { Segmented } from '../../ui';
import { useAppStore } from '../../store';
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
  const uiScale    = useAppStore(s => s.uiScale);
  const setUiScale = useAppStore(s => s.setUiScale);
  const theme      = useAppStore(s => s.theme);
  const setTheme   = useAppStore(s => s.setTheme);

  return (
    <section className="appearance-panel" aria-labelledby="appearance-panel-heading">
      <h3 id="appearance-panel-heading" className="appearance-panel__title">
        <Palette size={14} /> Appearance
      </h3>

      <div className="appearance-panel__row">
        <span className="appearance-panel__label">UI scale</span>
        <Segmented
          size="xs"
          value={uiScale}
          onChange={setUiScale}
          items={[
            { value: 1,   label: 'S', title: 'Small UI scale'  },
            { value: 1.3, label: 'M', title: 'Medium UI scale' },
            { value: 1.5, label: 'L', title: 'Large UI scale'  },
          ]}
        />
      </div>

      <div className="appearance-panel__row">
        <span className="appearance-panel__label">Color theme</span>
        <div className="appearance-panel__themes" role="radiogroup" aria-label="Color theme">
          {THEMES.map(t => (
            <button
              key={t.id}
              type="button"
              className={`appearance-panel__theme-dot ${theme === t.id ? 'is-active' : ''}`}
              style={{ '--dot-color': t.dot }}
              onClick={() => setTheme(t.id)}
              title={t.label}
              aria-label={`${t.label} theme`}
              aria-checked={theme === t.id}
              role="radio"
            />
          ))}
        </div>
      </div>

      <p className="appearance-panel__help">
        These controls used to live in the bottom logs bar — moved here so
        the footer can stay focused on logs. Changes apply instantly and
        persist across launches.
      </p>
    </section>
  );
}
