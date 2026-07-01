import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ExternalLink, MessageCircle, Mail, Bug, Globe } from 'lucide-react';
import { Button } from '../ui';
import { openExternal } from '../api/external';

// All outward contact channels in one place (#contact). Values are the same
// ones used across the app (donate/license footers) so there's a single source.
const DISCORD_URL = 'https://discord.gg/bzQavDfVV9';
const EMAIL = 'OmniVoice@palash.dev';
const ISSUES_URL = 'https://github.com/debpalash/OmniVoice-Studio/issues';
const WEBSITE_URL = 'https://palash.dev';

const CHANNELS = [
  {
    id: 'discord',
    icon: MessageCircle,
    hue: '#5865F2',
    labelKey: 'contact.discord',
    labelDefault: 'Discord',
    descKey: 'contact.discord_desc',
    descDefault: 'Chat with the community and get help fast.',
    value: 'discord.gg/bzQavDfVV9',
    url: DISCORD_URL,
  },
  {
    id: 'email',
    icon: Mail,
    hue: '#d3869b',
    labelKey: 'contact.email',
    labelDefault: 'Email',
    descKey: 'contact.email_desc',
    descDefault: 'Licensing, partnerships, or anything private.',
    value: EMAIL,
    url: `mailto:${EMAIL}`,
  },
  {
    id: 'issues',
    icon: Bug,
    hue: '#8ec07c',
    labelKey: 'contact.issues',
    labelDefault: 'GitHub Issues',
    descKey: 'contact.issues_desc',
    descDefault: 'Report a bug or request a feature.',
    value: 'github.com/debpalash/OmniVoice-Studio',
    url: ISSUES_URL,
  },
  {
    id: 'website',
    icon: Globe,
    hue: '#83a598',
    labelKey: 'contact.website',
    labelDefault: 'Website',
    descKey: 'contact.website_desc',
    descDefault: 'More about the project and the maker.',
    value: 'palash.dev',
    url: WEBSITE_URL,
  },
];

/**
 * ContactPage — a standalone "reach me" page: Discord, email, GitHub issues,
 * and website as clean, single-tap rows. Reached via `mode === 'contact'`.
 */
export default function ContactPage({ onBack }) {
  const { t } = useTranslation();

  return (
    <div className="relative isolate flex flex-1 flex-col overflow-y-auto bg-[var(--chrome-bg)]">
      <div className="lp-aurora" aria-hidden="true">
        <span className="lp-aurora__blob lp-aurora__blob--pink" />
        <span className="lp-aurora__blob lp-aurora__blob--green" />
        <span className="lp-aurora__blob lp-aurora__blob--amber" />
      </div>

      <div className="relative z-[2] flex items-center justify-between gap-3 px-11 pt-4">
        <Button variant="subtle" size="sm" onClick={onBack} leading={<ArrowLeft size={14} />}>
          {t('donate.back')}
        </Button>
        <span className="w-24 shrink-0" aria-hidden="true" />
      </div>

      <div className="relative z-[1] mx-auto flex w-full max-w-[640px] flex-1 flex-col justify-center gap-6 px-8 pb-10">
        <div className="flex flex-col gap-6">
          <div className="text-center">
            <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-md border border-[color-mix(in_srgb,#d3869b_30%,transparent)] bg-[color-mix(in_srgb,#d3869b_12%,transparent)]">
              <MessageCircle
                size={24}
                className="text-[#f3a5b6] drop-shadow-[0_0_12px_rgba(243,165,182,0.5)]"
              />
            </span>
            <h2 className="relative inline-block font-serif text-[2rem] font-normal leading-tight tracking-[-0.02em] text-[var(--chrome-fg)]">
              {t('contact.hero_title', { defaultValue: 'Get in touch' })}
              <span className="lp-hero__sweep" aria-hidden="true" />
            </h2>
            <p className="mx-auto mt-2.5 max-w-[480px] font-sans text-[0.8rem] leading-[1.65] text-[var(--chrome-fg-muted)]">
              {t('contact.hero_desc', {
                defaultValue:
                  'Questions, bugs, licensing, or just to say hi — here’s how to reach me.',
              })}
            </p>
          </div>

          <section className="grid grid-cols-1 gap-2.5">
            {CHANNELS.map((c) => {
              const Icon = c.icon;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => openExternal(c.url)}
                  style={{ '--card-hue': c.hue }}
                  className="flex w-full items-center gap-3 overflow-hidden rounded-md border border-border bg-transparent px-3.5 py-2.5 text-left transition-colors hover:border-[color-mix(in_srgb,var(--card-hue)_40%,transparent)] hover:bg-[color-mix(in_srgb,var(--card-hue)_6%,transparent)]"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--card-hue)_22%,transparent)] bg-[color-mix(in_srgb,var(--card-hue)_10%,transparent)]">
                    <Icon size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-xs font-semibold uppercase tracking-[var(--chrome-label-track)] text-[var(--chrome-fg)]">
                      {t(c.labelKey, { defaultValue: c.labelDefault })}
                    </span>
                    <span className="block font-sans text-[0.68rem] leading-snug text-[var(--chrome-fg-muted)]">
                      {t(c.descKey, { defaultValue: c.descDefault })}
                    </span>
                    <span className="mt-1 block break-all font-mono text-[11px] text-[var(--chrome-fg-muted)] opacity-85">
                      {c.value}
                    </span>
                  </span>
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-[var(--chrome-fg-muted)]">
                    <ExternalLink size={14} />
                  </span>
                </button>
              );
            })}
          </section>
        </div>
      </div>
    </div>
  );
}
