import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Collapsible — a chevron-header disclosure for hiding power-user / advanced
 * rows. Closed by default.
 *
 * FAST-mode shadcn migration: styling is now Tailwind utilities on the OmniVoice
 * `--chrome-*` / `--space-*` token bridge (palette preserved exactly); the old
 * `.st-collapsible*` rules in primitives.css are gone. The chevron rotates on
 * the `is-open` class; the body's last SettingRow drops its bottom padding.
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
    <div
      className={cn(
        'border border-transparent rounded-[var(--chrome-radius-pill)] mt-[var(--space-4)] overflow-hidden',
        open && 'is-open',
      )}
    >
      <button
        type="button"
        className="flex items-center gap-[var(--space-3)] w-full px-[var(--space-4)] py-[var(--space-3)] border-0 bg-transparent text-[color:var(--chrome-fg-muted)] [font-family:var(--font-sans)] text-[length:var(--text-sm)] font-semibold cursor-pointer transition-[background,color] duration-[120ms] hover:bg-[var(--chrome-hover-bg)] hover:text-[color:var(--chrome-fg)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown
          size={14}
          className="shrink-0 text-[var(--chrome-fg-dim)] transition-transform duration-[160ms] [.is-open_&]:rotate-180"
          aria-hidden="true"
        />
        {Icon && (
          <span className="inline-flex text-[color:var(--chrome-fg-dim)]" aria-hidden="true">
            <Icon size={14} />
          </span>
        )}
        <span className="flex-auto text-left">{title}</span>
        {badge != null && (
          <span className="shrink-0 [font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] text-[color:var(--chrome-fg-dim)]">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="px-[var(--space-5)] pt-[var(--space-2)] pb-[var(--space-4)] border-t border-transparent [&>[data-slot=setting-row]:last-child]:pb-0">
          {children}
        </div>
      )}
    </div>
  );
}
