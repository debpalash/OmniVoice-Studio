import React from 'react';
import InfoHint from './InfoHint';

/**
 * SettingRow — one labelled row in a SettingsSection.
 *
 * Layout (CSS grid): [icon?] [ title + one-line subtitle ] [spacer] [control].
 * The control is right-aligned; for a read-only data value pass it as `control`
 * with `mono` to render it monospace (covers About / Privacy value rows).
 *
 * @param {LucideIcon=} icon     optional leading icon — rendered inline (size 14, dim) inside the title
 * @param {ReactNode}   title    the row label (already translated)
 * @param {ReactNode=}  subtitle optional muted description line under the title (wraps cleanly)
 * @param {ReactNode=}  note     alias for `subtitle` — used as a fallback when `subtitle`
 *                               is absent. A row renders AT MOST ONE muted description line:
 *                               if both are given, `subtitle` wins (no stacked double-line).
 * @param {ReactNode=}  hint     optional long help prose / Learn-more link — rendered as an InfoHint
 * @param {ReactNode}   control  the right-aligned control or value
 * @param {boolean=}    mono     render the control monospace (read-only data value)
 * @param {'center'|'start'=} align vertical alignment of the control (default 'center')
 * @param {string=}     className extra class on the row
 */
export default function SettingRow({
  icon: Icon,
  title,
  subtitle,
  note,
  hint,
  control,
  mono = false,
  align = 'center',
  className = '',
}) {
  return (
    <div
      className={`st-row st-row--align-${align} ${className}`.trim()}
      data-mono={mono ? '' : undefined}
    >
      <div className="st-row__label">
        <span className="st-row__title">
          {Icon && <Icon size={14} aria-hidden="true" />}
          {title}
          {hint && <InfoHint>{hint}</InfoHint>}
        </span>
        {/* One muted description line, max. `subtitle` wins; `note` is a
            fallback. This makes the double-description bug structurally
            impossible regardless of what a panel passes. */}
        {(subtitle || note) && <span className="st-row__subtitle">{subtitle || note}</span>}
      </div>
      {control != null && (
        <div className={`st-row__control ${mono ? 'st-row__control--mono' : ''}`.trim()}>
          {control}
        </div>
      )}
    </div>
  );
}
