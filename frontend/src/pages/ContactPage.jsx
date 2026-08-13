import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  ExternalLink,
  MessageCircle,
  Bug,
  Lightbulb,
  Heart,
  ShieldAlert,
  Mail,
  Globe,
  Megaphone,
} from 'lucide-react';
import { Button } from '../ui';
import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils';
import { openExternal } from '../api/external';
import ReportBugButton from '../components/ReportBugButton';

// One home for every outward channel. The repo/Discord/security URLs match the
// values the rest of the app uses (bug reporter, footer, SECURITY.md) so a link
// change here can never leave one surface pointing somewhere stale (#contact).
const REPO_URL = 'https://github.com/debpalash/VoiceStudio';
const ISSUES_URL = `${REPO_URL}/issues`;
const DISCORD_URL = 'https://discord.gg/bzQavDfVV9';
// GitHub Security Advisories = the private "report a vulnerability" flow that
// SECURITY.md points at (never a public issue for security bugs).
const SECURITY_URL = `${REPO_URL}/security/advisories/new`;
const EMAIL = 'VoiceStudio@palash.dev';
const WEBSITE_URL = 'https://palash.dev';
const X_URL = 'https://x.com/idebpalash';

// Guidance sections — each is a card with an icon, a heading, and a
// "use this when…" sentence so a user lands on the RIGHT channel instead of a
// bare link list. `kind` picks how the CTA behaves:
//   bug      → reuse ReportBugButton (prefilled GitHub issue + scrubbed diag)
//   external → open a URL in the browser (via openExternal / real <a rel>)
//   internal → route to another in-app page (Support), no duplication here
const SECTIONS = [
  {
    id: 'bug',
    icon: Bug,
    hue: '#fb4934',
    kind: 'bug',
    titleKey: 'contact.bug_title',
    titleDefault: 'Report a bug',
    descKey: 'contact.bug_desc',
    descDefault:
      'Hit a crash or something that behaved unexpectedly? The in-app reporter opens a prefilled GitHub issue with scrubbed diagnostics — your OS, GPU and active engine — while home folders and secrets are stripped out. Nothing is sent until you review it and click Submit.',
    ctaKey: 'contact.bug_cta',
    ctaDefault: 'Open bug reporter',
  },
  {
    id: 'feature',
    icon: Lightbulb,
    hue: '#8ec07c',
    kind: 'external',
    url: ISSUES_URL,
    titleKey: 'contact.feature_title',
    titleDefault: 'Request a feature or ask',
    descKey: 'contact.feature_desc',
    descDefault:
      'Have an idea, a question, or a workflow that feels clunky? Open a GitHub issue so it is tracked in the open and others can weigh in — a quick search first often finds it already discussed.',
    ctaKey: 'contact.feature_cta',
    ctaDefault: 'Open GitHub Issues',
  },
  {
    id: 'community',
    icon: MessageCircle,
    hue: '#5865F2',
    kind: 'external',
    url: DISCORD_URL,
    titleKey: 'contact.community_title',
    titleDefault: 'Get help & community',
    descKey: 'contact.community_desc',
    descDefault:
      'The fastest place for setup help and troubleshooting, and a friendly spot to share the dubs and voices you make. Come say hi and see what everyone is building.',
    ctaKey: 'contact.community_cta',
    ctaDefault: 'Join the Discord',
  },
  {
    id: 'follow',
    icon: Megaphone,
    hue: '#1d9bf0',
    kind: 'external',
    url: X_URL,
    titleKey: 'contact.follow_title',
    titleDefault: 'Follow along on X',
    descKey: 'contact.follow_desc',
    descDefault:
      'Release notes, new engines, and the occasional look at what is being built next. Handy if you would rather not sit in a chat server.',
    ctaKey: 'contact.follow_cta',
    ctaDefault: 'Follow on X',
  },
  {
    id: 'support',
    icon: Heart,
    hue: 'var(--color-brand)',
    kind: 'internal',
    titleKey: 'contact.support_title',
    titleDefault: 'Support the project',
    descKey: 'contact.support_desc',
    descDefault:
      'VoiceStudio is free and runs entirely on your machine. If it saves you time, a one-off tip keeps development going — every bit genuinely helps.',
    ctaKey: 'contact.support_cta',
    ctaDefault: 'See ways to support',
  },
  {
    id: 'security',
    icon: ShieldAlert,
    hue: '#fabd2f',
    kind: 'external',
    url: SECURITY_URL,
    titleKey: 'contact.security_title',
    titleDefault: 'Report a security issue',
    descKey: 'contact.security_desc',
    descDefault:
      'Found a vulnerability? Please do not open a public issue. Report it privately through GitHub Security Advisories so it can be fixed before it is disclosed.',
    ctaKey: 'contact.security_cta',
    ctaDefault: 'Report privately',
  },
];

/**
 * ExternalCta — a subtle-button-styled link that opens in the system browser.
 * Rendered as a real `<a rel="noreferrer">` (keyboard-focusable, right-click
 * "copy link", screen-reader "link"), but the actual open is routed through
 * `openExternal` so it works inside the Tauri webview too (window.open is
 * blocked there). `preventDefault` keeps the anchor from double-navigating.
 */
function ExternalCta({
  href,
  label,
  ariaLabel,
  leading = null,
  trailing = <ExternalLink size={13} />,
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel || label}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
      className={cn(buttonVariants({ variant: 'subtle', size: 'omniSm' }), 'gap-1.5')}
    >
      {leading}
      <span>{label}</span>
      {trailing}
    </a>
  );
}

// Small mono caption with a trailing hairline — matches the Support page's
// SectionTitle so the two pages read as one family.
/**
 * The contact channels, as a SECTION rather than a page.
 *
 * Each way to reach the project is a card with an icon, a heading and a
 * sentence of guidance, so people pick the right channel (bug / feature /
 * community / support / security) instead of guessing from a flat link list.
 *
 * Sponsor, commercial licensing and contact were three separate destinations
 * for one question — "how do I reach these people / support this" — so they
 * now live together on SupportPage. This exports the body; the page shell
 * (back button, aurora, scroll container) belongs to the host.
 */
export function ContactSections() {
  const { t } = useTranslation();

  // "Support the project" stays INSIDE the app rather than linking out to
  // Ko-fi: the support section is right above this one now, so sending people
  // to a browser for something on the same page would be absurd.
  const goSupport = () =>
    document.getElementById('support-give')?.scrollIntoView({ block: 'start' });

  const renderCta = (s) => {
    const label = t(s.ctaKey, { defaultValue: s.ctaDefault });
    if (s.kind === 'bug') return <ReportBugButton label={label} />;
    if (s.kind === 'internal') {
      return (
        <Button variant="subtle" size="sm" trailing={<ArrowRight size={13} />} onClick={goSupport}>
          {label}
        </Button>
      );
    }
    return <ExternalCta href={s.url} label={label} />;
  };

  return (
    <>
      <section
        className="grid grid-cols-[repeat(auto-fit,minmax(248px,1fr))] gap-3"
        aria-label={t('contact.channels_label', { defaultValue: 'Ways to get in touch' })}
      >
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          return (
            <Card
              key={s.id}
              style={{ '--card-hue': s.hue }}
              className="h-full items-start gap-3 rounded-lg border-border bg-transparent p-5 shadow-none transition-colors hover:border-border-strong hover:bg-[var(--chrome-hover-bg)]"
            >
              <span className="flex size-11 items-center justify-center rounded-md border border-transparent bg-[color-mix(in_srgb,var(--card-hue)_12%,transparent)] text-[var(--card-hue)]">
                <Icon size={20} />
              </span>
              <h3 className="font-serif text-[1.2rem] font-medium leading-snug text-[var(--chrome-fg)]">
                {t(s.titleKey, { defaultValue: s.titleDefault })}
              </h3>
              <p className="font-sans text-[0.82rem] leading-[1.6] text-[var(--chrome-fg-muted)]">
                {t(s.descKey, { defaultValue: s.descDefault })}
              </p>
              <div className="mt-auto pt-1">{renderCta(s)}</div>
            </Card>
          );
        })}
      </section>

      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <ExternalCta
          href={`mailto:${EMAIL}`}
          label={t('contact.email', { defaultValue: 'Email' })}
          ariaLabel={t('contact.email_desc', {
            defaultValue: 'Email — licensing, partnerships, or anything private',
          })}
          leading={<Mail size={13} />}
          trailing={null}
        />
        <ExternalCta
          href={WEBSITE_URL}
          label={t('contact.website', { defaultValue: 'Website' })}
          ariaLabel={t('contact.website_desc', {
            defaultValue: 'Website — more about the project and the maker',
          })}
          leading={<Globe size={13} />}
        />
      </div>
    </>
  );
}

export default ContactSections;
