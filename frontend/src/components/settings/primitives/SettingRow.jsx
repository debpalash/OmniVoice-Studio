import React from 'react';
import InfoHint from './InfoHint';

/**
 * SettingRow — one labelled row in a SettingsSection.
 *
 * Layout (CSS grid): [icon?] [ title + one-line subtitle ] [spacer] [control].
 * The control is right-aligned; for a read-only data value pass it as `control`
 * with `mono` to render it monospace (covers About / Privacy value rows).
 *
 * @param {LucideIcon=} icon     optional leading icon (size 15, dim)
 * @param {ReactNode}   title    the row label (already translated)
 * @param {ReactNode=}  subtitle optional one-line muted sub-label under the title
 * @param {ReactNode=}  hint     optional help prose — rendered as an InfoHint next to the title
 * @param {ReactNode}   control  the right-aligned control or value
 * @param {boolean=}    mono     render the control monospace (read-only data value)
 * @param {'center'|'start'=} align vertical alignment of the control (default 'center')
 * @param {string=}     className extra class on the row
 */
export default function SettingRow({
  icon: Icon,
  title,
  subtitle,
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
      {Icon && (
        <span className="st-row__icon" aria-hidden="true">
          <Icon size={15} />
        </span>
      )}
      <div className="st-row__label">
        <span className="st-row__title">
          {title}
          {hint && <InfoHint>{hint}</InfoHint>}
        </span>
        {subtitle && <span className="st-row__subtitle">{subtitle}</span>}
      </div>
      {control != null && (
        <div className={`st-row__control ${mono ? 'st-row__control--mono' : ''}`.trim()}>
          {control}
        </div>
      )}
    </div>
  );
}
