import React from 'react';

/**
 * SettingsSection — the standard header + body wrapper for every Settings card.
 *
 * Replaces the old `<section className="settings-section"><h2>…</h2>…</section>`
 * pattern. Renders an icon-tile + title header, an optional one-line description,
 * optional right-aligned actions, then the children body.
 *
 * @param {LucideIcon} icon        lucide icon component (rendered at size 15)
 * @param {string}     title       section title (already translated)
 * @param {string=}    description optional ≤1-line subtitle (muted/dim)
 * @param {string=}    accent      optional CSS color for the icon tile (defaults to muted fg)
 * @param {ReactNode=} actions     optional right-aligned header actions (buttons, badges…)
 * @param {ReactNode}  children    section body
 * @param {string=}    className   extra class on the root <section>
 */
export default function SettingsSection({
  icon: Icon,
  title,
  description,
  accent,
  actions,
  children,
  className = '',
}) {
  return (
    <section className={`st-section ${className}`.trim()}>
      <header className="st-section__head">
        {Icon && (
          <span
            className="st-section__icon"
            style={accent ? { color: accent } : undefined}
            aria-hidden="true"
          >
            <Icon size={14} />
          </span>
        )}
        <div className="st-section__titles">
          <h2 className="st-section__title">{title}</h2>
          {description && <p className="st-section__desc">{description}</p>}
        </div>
        {actions && <div className="st-section__actions">{actions}</div>}
      </header>
      <div className="st-section__body">{children}</div>
    </section>
  );
}
