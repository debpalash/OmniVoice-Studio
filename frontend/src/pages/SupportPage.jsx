import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Heart,
  ExternalLink,
  ArrowLeft,
  Building2,
  Shield,
  Zap,
  Users,
  Headphones,
  Mail,
  Star,
  MessageCircle,
  Gem,
} from 'lucide-react';
import { Button, Badge } from '../ui';
import { Card } from '@/components/ui/card';
import { openExternal } from '../api/external';
import GoalBar from '../components/donate/GoalBar';
import { loadDonationProgress, BUNDLED_PROGRESS } from '../api/donation';

// Ko-fi / PayPal destinations are shared with the footer's donation-moment
// popover — single source of truth in utils/donateLinks.js.
import { KOFI_URL, PAYPAL_URL } from '../utils/donateLinks';
// Sponsor roster + "become a sponsor" links — single source of truth in
// config/sponsors.js (kept in lockstep with SPONSORS.md).
import { SPONSORS, SPONSOR_TIERS, SPONSOR_CONTACT } from '../config/sponsors';
// Suggested amounts — ladder starts at $10; middle ($20) is "most common".
const SUGGESTED_AMOUNTS = [
  { value: 10, label: '$10' },
  { value: 20, label: '$20', common: true },
  { value: 50, label: '$50' },
];

const METHODS = [
  { id: 'kofi', label: 'Ko-fi', descriptionKey: 'donate.coffee_desc', url: KOFI_URL, icon: '☕' },
  {
    id: 'paypal',
    label: 'PayPal',
    descriptionKey: 'donate.paypal_desc',
    url: PAYPAL_URL,
    icon: '💳',
  },
];

// Donate/support accent tracks the themed brand token (per-[data-theme]) so the
// panel recolors with the app theme instead of the old fixed pink.
const DONATE_HUE = 'var(--color-brand)';

// PayPal.me carries the chosen amount straight into the checkout; Ko-fi opens
// its tip page (no reliable preset-amount URL). A non-numeric/"custom" amount
// falls back to the bare link.
function methodUrl(method, amount) {
  if (method.id === 'paypal' && typeof amount === 'number') return `${PAYPAL_URL}/${amount}`;
  return method.url;
}

// Shared "rich link" card — a clickable row with an icon bubble, title + body,
// and a trailing external-link affordance. `hue` tints the icon bubble + hover.
function LinkCard({ icon, label, desc, value, hue, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ '--card-hue': hue }}
      className="flex w-full items-center gap-3 overflow-hidden rounded-md border border-border bg-transparent px-3.5 py-2.5 text-left transition-colors hover:border-transparent hover:bg-[color-mix(in_srgb,var(--card-hue)_6%,transparent)]"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent bg-[color-mix(in_srgb,var(--card-hue)_10%,transparent)] text-[1.1rem]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-xs font-semibold uppercase tracking-[var(--chrome-label-track)] text-[var(--chrome-fg)]">
          {label}
        </span>
        <span className="block font-sans text-[0.68rem] leading-snug text-[var(--chrome-fg-muted)]">
          {desc}
        </span>
        {value && (
          <span className="mt-1 block break-all font-mono text-[11px] text-[var(--chrome-fg-muted)] opacity-85">
            {value}
          </span>
        )}
      </span>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-[var(--chrome-fg-muted)]">
        <ExternalLink size={14} />
      </span>
    </button>
  );
}

// Section label: a mono uppercase caption with a trailing hairline.
function SectionTitle({ children }) {
  return (
    <div className="mb-2.5 flex items-center gap-3">
      <span className="whitespace-nowrap font-mono text-[var(--chrome-label-size)] font-semibold uppercase tracking-[var(--chrome-label-track)] text-[var(--chrome-fg-muted)]">
        {children}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/* ── Sponsors ─────────────────────────────────────────────────────────────
   Logo grid grouped by tier when SPONSORS has entries; a tasteful "be the
   first" outlined slot when it's empty. Logos link out via the app's
   openExternal (Tauri-safe) while keeping a real href for accessibility. */

// A single clickable sponsor logo. Real <a href> (right-click / a11y) but the
// click is intercepted so it opens in the system browser, not the webview.
function SponsorLogo({ sponsor }) {
  const { t } = useTranslation();
  return (
    <a
      href={sponsor.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openExternal(sponsor.url);
      }}
      title={sponsor.name}
      aria-label={t('support.sponsors_logo_aria', {
        defaultValue: 'Visit {{name}}, an OmniVoice sponsor',
        name: sponsor.name,
      })}
      className="flex min-h-[64px] items-center justify-center rounded-md border border-border bg-transparent px-4 py-3 transition-colors hover:border-transparent hover:bg-[var(--chrome-hover-bg)]"
    >
      <img
        src={sponsor.logoUrl}
        alt={sponsor.name}
        loading="lazy"
        className="max-h-10 w-auto max-w-full object-contain"
      />
    </a>
  );
}

function SponsorsSection() {
  const { t } = useTranslation();

  // Group by tier in the configured order; anything with an unrecognized (or
  // missing) tier is collected into a trailing untiered group.
  const groups = SPONSOR_TIERS.map((tier) => [
    tier,
    SPONSORS.filter((s) => s.tier === tier),
  ]).filter(([, list]) => list.length > 0);
  const untiered = SPONSORS.filter((s) => !SPONSOR_TIERS.includes(s.tier));
  if (untiered.length) groups.push(['', untiered]);

  return (
    <section>
      <SectionTitle>{t('support.sponsors_title', { defaultValue: 'Sponsors' })}</SectionTitle>
      <p className="mb-3.5 font-sans text-[0.75rem] leading-[1.6] text-[var(--chrome-fg-muted)]">
        {t('support.sponsors_lead', {
          defaultValue: 'The companies and people keeping OmniVoice free, local, and open source.',
        })}
      </p>

      {SPONSORS.length === 0 ? (
        // Empty state — an outlined "your logo here" slot, not a bare message.
        <div
          data-testid="sponsors-empty"
          className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-strong bg-[color-mix(in_srgb,var(--color-brand)_4%,transparent)] px-6 py-8 text-center"
        >
          <span className="flex size-9 items-center justify-center rounded-md border border-transparent bg-[color-mix(in_srgb,var(--color-brand)_12%,transparent)] text-[var(--color-brand)]">
            <Gem size={18} />
          </span>
          <span className="font-serif text-[1.05rem] text-[var(--chrome-fg)]">
            {t('support.sponsors_empty_title', {
              defaultValue: 'Be the first to sponsor OmniVoice',
            })}
          </span>
          <span className="font-mono text-[0.68rem] uppercase tracking-[var(--chrome-label-track)] text-[var(--chrome-fg-dim)]">
            {t('support.sponsors_empty_desc', { defaultValue: 'Your logo here' })}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([tier, list]) => (
            <div key={tier || 'untiered'}>
              {tier && (
                <div className="mb-2 font-mono text-[0.62rem] font-semibold uppercase tracking-[var(--chrome-label-track)] text-[var(--chrome-fg-dim)]">
                  {t(`support.sponsors_tier_${tier}`, { defaultValue: tier })}
                </div>
              )}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5">
                {list.map((s) => (
                  <SponsorLogo key={s.name} sponsor={s} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Become a sponsor — opens the prefilled GitHub issue (zero-token,
          user-reviewed), then a one-line explainer linking to SPONSORS.md. */}
      <div className="mt-4 flex flex-col items-center gap-2.5 text-center">
        <Button
          variant="primary"
          leading={<Gem size={14} />}
          onClick={() => openExternal(SPONSOR_CONTACT.githubIssue)}
          aria-label={t('support.sponsors_become_aria', {
            defaultValue: 'Become a sponsor — opens a prefilled GitHub issue in your browser',
          })}
        >
          {t('support.sponsors_become', { defaultValue: 'Become a sponsor' })}
        </Button>
        <p className="max-w-[440px] font-sans text-[0.7rem] leading-[1.55] text-[var(--chrome-fg-muted)]">
          {t('support.sponsors_perk', {
            defaultValue:
              'Sponsors get their logo in the app, in the README, and a slot on the project site.',
          })}{' '}
          <button
            type="button"
            onClick={() => openExternal(SPONSOR_CONTACT.docsUrl)}
            className="font-semibold text-[var(--chrome-accent)] hover:underline"
          >
            {t('support.sponsors_learn_more', { defaultValue: 'What sponsors get' })}
          </button>
        </p>
      </div>
    </section>
  );
}

/* ── Support (donate) panel ───────────────────────────────────────────── */
function SupportView() {
  const { t } = useTranslation();
  const [progress, setProgress] = useState(BUNDLED_PROGRESS);
  const [amount, setAmount] = useState(null); // none pre-selected by design

  useEffect(() => {
    let alive = true;
    loadDonationProgress().then((p) => {
      if (alive) setProgress(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-md border border-transparent bg-[color-mix(in_srgb,var(--color-brand)_12%,transparent)]">
          <Heart
            size={24}
            className="text-[var(--color-brand)] [fill:color-mix(in_srgb,var(--color-brand)_35%,transparent)] drop-shadow-[0_0_12px_color-mix(in_srgb,var(--color-brand)_50%,transparent)]"
          />
        </span>
        <h2 className="relative inline-block font-serif text-[2rem] font-normal leading-tight tracking-[-0.02em] text-[var(--chrome-fg)]">
          {t('donate.hero_title')}
          <span className="lp-hero__sweep" aria-hidden="true" />
        </h2>
        <p className="mx-auto mt-2.5 max-w-[480px] font-sans text-[0.8rem] leading-[1.65] text-[var(--chrome-fg-muted)]">
          {t('donate.hero_desc')}
        </p>
      </div>

      {/* ── "Fund Claude Max" goal bar + social proof ──────────────────── */}
      <Card className="gap-3 rounded-lg border-border bg-[color-mix(in_srgb,var(--chrome-accent)_4%,transparent)] p-[18px] py-4 shadow-none">
        <GoalBar progress={progress} />
        <div className="flex items-center justify-center gap-1.5 font-mono text-[0.7rem] tracking-[0.01em] text-[var(--chrome-fg-muted)]">
          <Users size={13} className="text-[var(--chrome-accent)]" />
          <span>
            {t('donate.goal.social_proof', {
              defaultValue: 'Join {{count}} supporters funding local AI',
              count: progress.sponsorCount,
            })}
          </span>
        </div>
      </Card>

      {/* ── Step 1: pick an amount (none pre-selected; middle is "most common"). ──
          Selecting only *records* the amount — the supporter then chooses
          Ko-fi or PayPal below, and PayPal carries the amount through. */}
      <section>
        <SectionTitle>
          {t('donate.suggested_title', { defaultValue: 'Pick an amount' })}
        </SectionTitle>
        <div
          className="grid grid-cols-4 gap-2"
          role="group"
          aria-label={t('donate.suggested_title', { defaultValue: 'Pick an amount' })}
        >
          {SUGGESTED_AMOUNTS.map((a) => {
            const selected = amount === a.value;
            return (
              <button
                key={a.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setAmount(selected ? null : a.value)}
                className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-md border px-1.5 py-2 transition-colors ${
                  selected
                    ? 'border-[var(--chrome-accent)] bg-[var(--chrome-accent-bg)]'
                    : `${a.common ? 'border-transparent' : 'border-border'} hover:border-transparent hover:bg-[color-mix(in_srgb,var(--chrome-accent)_7%,transparent)]`
                }`}
              >
                <span className="font-serif text-[1.05rem] font-medium text-[var(--chrome-fg)]">
                  {a.label}
                </span>
                {a.common && (
                  <Badge tone="brand" size="xs" className="text-[0.54rem] tracking-[0.06em]">
                    {t('donate.most_common', { defaultValue: 'most common' })}
                  </Badge>
                )}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={amount === 'custom'}
            onClick={() => setAmount(amount === 'custom' ? null : 'custom')}
            className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-md border px-1.5 py-2 transition-colors ${
              amount === 'custom'
                ? 'border-[var(--chrome-accent)] bg-[var(--chrome-accent-bg)]'
                : 'border-border hover:border-transparent hover:bg-[color-mix(in_srgb,var(--chrome-accent)_7%,transparent)]'
            }`}
          >
            <span className="font-mono text-[0.78rem] uppercase tracking-[var(--chrome-label-track)] text-[var(--chrome-fg-muted)]">
              {t('donate.custom', { defaultValue: 'Custom' })}
            </span>
          </button>
        </div>
      </section>

      {/* ── Step 2: pick where (Ko-fi or PayPal). GitHub Sponsors isn't
          available; the supporter chooses, and PayPal carries the amount. ── */}
      <section>
        <SectionTitle>
          {typeof amount === 'number'
            ? t('donate.choose_method_amount', {
                defaultValue: 'Continue with ${{amount}}',
                amount,
              })
            : t('donate.choose_method', { defaultValue: 'Choose how to give' })}
        </SectionTitle>
        <div className="grid grid-cols-1 gap-2.5">
          {METHODS.map((m) => (
            <LinkCard
              key={m.id}
              icon={m.icon}
              label={m.label}
              desc={t(m.descriptionKey)}
              hue={DONATE_HUE}
              onClick={() => openExternal(methodUrl(m, typeof amount === 'number' ? amount : null))}
            />
          ))}
        </div>
      </section>

      {/* Non-monetary ways to help — gives people who can't (or don't want to)
          donate a real way to support, and balances out the panel. */}
      <section>
        <SectionTitle>{t('support.other_ways')}</SectionTitle>
        <div className="flex flex-wrap justify-center gap-2.5">
          <Button
            variant="subtle"
            size="sm"
            leading={<Star size={14} />}
            onClick={() => openExternal('https://github.com/debpalash/OmniVoice-Studio')}
          >
            {t('support.star_github')}
          </Button>
          <Button
            variant="subtle"
            size="sm"
            leading={<MessageCircle size={14} />}
            onClick={() => openExternal('https://discord.gg/bzQavDfVV9')}
          >
            {t('support.join_discord')}
          </Button>
        </div>
      </section>

      {/* Sponsors — org-level support with an in-app logo slot. Distinct from
          the individual donate ladder above. */}
      <SponsorsSection />

      <div className="pb-5 text-center font-mono text-[0.72rem] tracking-[0.02em] text-[var(--chrome-fg-dim)]">
        {t('donate.footer')}
      </div>
    </div>
  );
}

/* ── Commercial License panel ─────────────────────────────────────────── */
const LICENSE_EMAIL = 'OmniVoice@palash.dev';
const LICENSE_MAILTO =
  'mailto:OmniVoice@palash.dev?subject=OmniVoice Commercial License Inquiry' +
  '&body=Hi Palash,%0A%0AI%27d like to talk about a commercial license for OmniVoice Studio.%0A%0AOrganization:%0ATeam size:%0AUse case:%0A';

function LicenseView() {
  const { t } = useTranslation();
  // The three reasons that actually drive a commercial-license decision — the
  // full benefit grid + FAQ was noise; what matters is "you own it", "no
  // per-minute cost", "direct support". Everything else is one email away.
  const WHY_ITEMS = [
    { icon: Shield, label: t('enterprise.benefit_ip'), desc: t('enterprise.benefit_ip_desc') },
    { icon: Zap, label: t('enterprise.benefit_cost'), desc: t('enterprise.benefit_cost_desc') },
    {
      icon: Headphones,
      label: t('enterprise.benefit_support'),
      desc: t('enterprise.benefit_support_desc'),
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <Badge tone="neutral" size="sm">
          {t('enterprise.badge')}
        </Badge>
        <h2 className="relative mt-2.5 inline-block font-serif text-[2.4rem] font-normal leading-tight tracking-[-0.02em] text-[var(--chrome-fg)]">
          {t('enterprise.hero_title')}
          <span className="lp-hero__sweep" aria-hidden="true" />
        </h2>
        <p className="mx-auto mt-4 max-w-[540px] font-sans text-[0.85rem] leading-[1.65] text-[var(--chrome-fg-muted)]">
          {t('enterprise.hero_simple', {
            defaultValue:
              'OmniVoice Studio is free and open-source under the AGPL-3.0 — including for commercial and internal business use. You only need a commercial license to embed it in a closed-source product without AGPL’s copyleft obligations.',
          })}
        </p>
      </div>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2.5">
        {WHY_ITEMS.map(({ icon: Icon, label, desc }) => (
          <Card
            key={label}
            className="gap-0 rounded-md border-border bg-transparent p-4 shadow-none transition-colors hover:border-border-strong hover:bg-[var(--chrome-hover-bg)]"
          >
            <span className="mb-2.5 flex size-[30px] items-center justify-center rounded-md border border-transparent bg-[color-mix(in_srgb,var(--color-brand)_10%,transparent)] text-[var(--color-brand)]">
              <Icon size={16} />
            </span>
            <div className="mb-1 font-mono text-[0.75rem] font-semibold uppercase tracking-[var(--chrome-label-track)] text-[var(--chrome-fg)]">
              {label}
            </div>
            <div className="font-sans text-[0.72rem] leading-[1.5] text-[var(--chrome-fg-muted)]">
              {desc}
            </div>
          </Card>
        ))}
      </section>

      {/* One clear next step: pricing is quoted per deployment, so the action
          is simply "tell me about your use case". */}
      <section>
        <Card className="items-center gap-3.5 rounded-md border-border bg-[color-mix(in_srgb,#fe8019_5%,transparent)] p-6 text-center shadow-none">
          <p className="m-0 max-w-[540px] leading-[1.5] text-[var(--chrome-fg-muted)]">
            {t('enterprise.contact_lead', {
              defaultValue:
                'Pricing is quoted per deployment so it fits your team and workload. Tell me your use case and I’ll get you a quote.',
            })}
          </p>
          <Button
            variant="subtle"
            leading={<Mail size={13} />}
            onClick={() => openExternal(LICENSE_MAILTO)}
            className="border-transparent bg-[color-mix(in_srgb,#fe8019_18%,transparent)] font-semibold text-[var(--chrome-fg)] hover:border-transparent hover:bg-[color-mix(in_srgb,#fe8019_28%,transparent)]"
          >
            {t('enterprise.request_quote')}
          </Button>
          <button
            type="button"
            onClick={() => openExternal(LICENSE_MAILTO)}
            title={LICENSE_EMAIL}
            className="font-mono text-[0.65rem] text-[var(--chrome-accent)] hover:underline"
          >
            {LICENSE_EMAIL}
          </button>
        </Card>
      </section>
    </div>
  );
}

/**
 * SupportPage — unifies the donate ("Support") and commercial-license panels
 * behind a single charming segmented toggle. Both legacy modes ('donate',
 * 'enterprise') route here with the matching initialView, so every existing
 * entry point (footer heart, dub/export "commercial license" links) still
 * works — they just land on the right tab.
 */
export default function SupportPage({ onBack, initialView = 'support' }) {
  const { t } = useTranslation();
  const [view, setView] = useState(initialView === 'license' ? 'license' : 'support');

  // Literal class strings (no interpolation) so Tailwind's JIT can see them.
  const TAB_BASE =
    'inline-flex items-center justify-center gap-1.5 rounded-md border px-[18px] py-1.5 font-mono text-[0.72rem] font-semibold uppercase tracking-[var(--chrome-label-track)] whitespace-nowrap transition-colors';
  const TAB_INACTIVE =
    'border-transparent text-[var(--chrome-fg-muted)] hover:text-[var(--chrome-fg)]';
  const TAB_SUPPORT_ACTIVE =
    'border-transparent bg-[color-mix(in_srgb,var(--color-brand)_18%,transparent)] text-[var(--chrome-fg)]';
  const TAB_LICENSE_ACTIVE =
    'border-transparent bg-[color-mix(in_srgb,#83a598_18%,transparent)] text-[var(--chrome-fg)]';

  return (
    <div className="relative isolate flex flex-1 flex-col overflow-y-auto bg-[var(--chrome-bg)]">
      {/* Aurora backdrop — shared with the Launchpad */}
      <div className="lp-aurora" aria-hidden="true">
        <span className="lp-aurora__blob lp-aurora__blob--pink" />
        <span className="lp-aurora__blob lp-aurora__blob--green" />
        <span className="lp-aurora__blob lp-aurora__blob--amber" />
      </div>

      {/* Top bar: Back (left) · toggle (center) · spacer (right, balances Back) */}
      <div className="relative z-[2] flex items-center justify-between gap-3 px-11 pt-4">
        <Button variant="subtle" size="sm" onClick={onBack} leading={<ArrowLeft size={14} />}>
          {t('donate.back')}
        </Button>

        <div
          className="grid grid-cols-2 gap-1 rounded-md border border-border bg-[color-mix(in_srgb,var(--chrome-fg)_5%,transparent)] p-[3px]"
          role="tablist"
          aria-label={t('support.toggle_label')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'support'}
            className={`${TAB_BASE} ${view === 'support' ? TAB_SUPPORT_ACTIVE : TAB_INACTIVE}`}
            onClick={() => setView('support')}
          >
            <Heart size={13} /> {t('support.tab_support')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'license'}
            className={`${TAB_BASE} ${view === 'license' ? TAB_LICENSE_ACTIVE : TAB_INACTIVE}`}
            onClick={() => setView('license')}
          >
            <Building2 size={13} /> {t('support.tab_license')}
          </button>
        </div>

        <span className="w-24 shrink-0" aria-hidden="true" />
      </div>

      {/* key={view} remounts the panel so its entry animations replay on toggle.
          The Support panel is short, so it's centered vertically; License is
          tall enough to fill on its own and stays top-aligned. */}
      <div
        className={`relative z-[1] mx-auto flex w-full max-w-[640px] flex-col gap-6 px-8 pb-10 ${
          view === 'support' ? 'flex-1 justify-center' : ''
        }`}
        key={view}
      >
        {view === 'support' ? <SupportView /> : <LicenseView />}
      </div>
    </div>
  );
}
