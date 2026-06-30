import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Collapsible — a chevron-header disclosure for hiding power-user / advanced
 * rows. Closed by default. Composes nothing exotic so it can wrap any children
 * (SettingRows, raw blocks, etc.).
 *
 * @param {ReactNode}   title       header label (already translated)
 * @param {LucideIcon=} icon        optional leading icon (size 14, dim)
 * @param {boolean=}    defaultOpen start expanded (default false)
 * @param {ReactNode=}  badge       optional small node shown after the title (count/state)
 * @param {ReactNode}   children    the collapsible body
 */
export default function Collapsible({ title, icon: Icon, defaultOpen = false, badge, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`st-collapsible ${open ? 'is-open' : ''}`.trim()}>
      <button
        type="button"
        className="st-collapsible__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={14} className="st-collapsible__chevron" aria-hidden="true" />
        {Icon && (
          <span className="st-collapsible__icon" aria-hidden="true">
            <Icon size={14} />
          </span>
        )}
        <span className="st-collapsible__title">{title}</span>
        {badge != null && <span className="st-collapsible__badge">{badge}</span>}
      </button>
      {open && <div className="st-collapsible__body">{children}</div>}
    </div>
  );
}
