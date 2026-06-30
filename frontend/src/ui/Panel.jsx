import React, { forwardRef } from 'react';
import './Panel.css';

/**
 * Panel — a content surface. Replaces the ad-hoc card divs + `.glass-panel`.
 *
 * @param variant 'glass' | 'solid' | 'flat'
 * @param padding 'none' | 'sm' | 'md' | 'lg'
 * @param title   optional string or node rendered in the panel header
 * @param actions optional node rendered on the right of the header
 * @param as      element tag ('div' | 'section' | 'article' …)
 */
const Panel = forwardRef(function Panel(
  {
    variant = 'glass',
    padding = 'md',
    title = null,
    actions = null,
    as: Tag = 'section',
    className = '',
    children,
    ...rest
  },
  ref,
) {
  const classes = ['ui-panel', `ui-panel--${variant}`, `ui-panel--pad-${padding}`, className]
    .filter(Boolean)
    .join(' ');

  const hasHeader = title != null || actions != null;

  return (
    <Tag ref={ref} className={classes} {...rest}>
      {hasHeader && (
        <header className="ui-panel__header">
          {title != null && <div className="ui-panel__title">{title}</div>}
          {actions != null && <div className="ui-panel__actions">{actions}</div>}
        </header>
      )}
      <div className="ui-panel__body">{children}</div>
    </Tag>
  );
});

export default Panel;
