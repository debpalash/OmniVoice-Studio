import React from 'react';

/**
 * SettingsSection — the standard header + body wrapper for every Settings card.
 *
 * FAST-mode shadcn migration: the surface, header, icon tile, titles and actions
 * are now Tailwind utilities layered on the OmniVoice `--chrome-*` / `--space-*`
 * token bridge (palette preserved exactly — no hardcoded colors). The old
 * `.st-section*` rules in primitives.css are gone.
 *
 * Renders an icon-tile + title header, an optional one-line description,
 * optional right-aligned actions, then the children body.
 *
 * @param {LucideIcon} icon        lucide icon component (rendered at size 14)
 * @param {string}     title       section title (already translated)
 * @param {string=}    description optional ≤1-line subtitle (muted/dim)
 * @param {string=}    accent      optional CSS color for the icon tile (defaults to muted fg)
 * @param {ReactNode=} actions     optional right-aligned header actions (buttons, badges…)
 * @param {ReactNode}  children    section body
 * @param {string=}    className   extra class on the root <section>
 */

// Shared so the raw card surfaces in EnginesTab / ModelStoreTab (which carry a
// custom toolbar + table instead of the icon/title header) stay byte-identical
// to the primitive without re-deriving the token string. `data-slot` is the
// stable hook Settings.css / panel CSS reach into.
export const SETTINGS_SECTION_SURFACE =
  'bg-[var(--chrome-bg)] border border-transparent rounded-[var(--chrome-radius-pill)] px-[var(--space-6)] py-[var(--space-5)] mb-[var(--space-5)] last:mb-0';

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
    <section
      data-slot="settings-section"
      className={`${SETTINGS_SECTION_SURFACE} ${className}`.trim()}
    >
      <header className="flex items-center gap-[var(--space-3)] mb-[var(--space-3)] pb-[var(--space-3)] border-b border-transparent">
        {Icon && (
          <span
            className="shrink-0 inline-flex items-center justify-center w-[20px] h-[20px] rounded-[var(--chrome-radius-pill)] text-[color:var(--chrome-fg-muted)] bg-[color-mix(in_srgb,currentColor_12%,var(--chrome-bg))] border border-transparent"
            style={accent ? { color: accent } : undefined}
            aria-hidden="true"
          >
            <Icon size={14} />
          </span>
        )}
        <div className="flex-auto min-w-0 flex flex-col gap-[1px]">
          <h2 className="m-0 [font-family:var(--font-sans)] text-[length:var(--text-md)] font-semibold text-[color:var(--chrome-fg)] leading-[1.3]">
            {title}
          </h2>
          {description && (
            <p className="m-0 [font-family:var(--font-sans)] text-[length:var(--text-xs)] text-[color:var(--chrome-fg-dim)] leading-[1.5] overflow-hidden text-ellipsis whitespace-nowrap">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="shrink-0 inline-flex items-center gap-[var(--space-3)] ml-[var(--space-4)]">
            {actions}
          </div>
        )}
      </header>
      <div>{children}</div>
    </section>
  );
}
