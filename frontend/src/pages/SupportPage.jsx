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
} from 'lucide-react';
import { Button } from '../ui';
import { openExternal } from '../api/external';
import GoalBar from '../components/donate/GoalBar';
import { loadDonationProgress, BUNDLED_PROGRESS } from '../api/donation';
import './DonatePage.css';
import './EnterprisePage.css';
import './SupportPage.css';

// GitHub Sponsors isn't available, so donations go through Ko-fi or PayPal and
// the supporter picks which — no default-charge nudge, none pre-selected.
const KOFI_URL = 'https://ko-fi.com/debpalash';
const PAYPAL_URL = 'https://paypal.me/palashCoder';
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

// PayPal.me carries the chosen amount straight into the checkout; Ko-fi opens
// its tip page (no reliable preset-amount URL). A non-numeric/"custom" amount
// falls back to the bare link.
function methodUrl(method, amount) {
  if (method.id === 'paypal' && typeof amount === 'number') return `${PAYPAL_URL}/${amount}`;
  return method.url;
}

function LinkCard({ method, amount, style }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="donate-card donate-card--link lp-glow-card"
      style={style}
      onClick={() => openExternal(methodUrl(method, amount))}
    >
      <span className="donate-card__glow" aria-hidden="true" />
      <div className="donate-card__icon">{method.icon}</div>
      <div className="donate-card__body">
        <div className="donate-card__label">{method.label}</div>
        <div className="donate-card__desc">{t(method.descriptionKey)}</div>
      </div>
      <div className="donate-card__arrow">
        <ExternalLink size={14} />
      </div>
    </button>
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
    <div className="support-view">
      <div className="donate-hero">
        <div className="donate-hero__icon-wrap">
          <Heart size={24} className="donate-hero__heart" />
        </div>
        <h2 className="donate-hero__title">
          {t('donate.hero_title')}
          <span className="lp-hero__sweep" aria-hidden="true" />
        </h2>
        <p className="donate-hero__subtitle">{t('donate.hero_desc')}</p>
      </div>

      {/* ── "Fund Claude Max" goal bar + social proof ──────────────────── */}
      <section className="donate-section donate-goal-section">
        <GoalBar progress={progress} />
        <div className="donate-social-proof">
          <Users size={13} />
          <span>
            {t('donate.goal.social_proof', {
              defaultValue: 'Join {{count}} supporters funding local AI',
              count: progress.sponsorCount,
            })}
          </span>
        </div>
      </section>

      {/* ── Step 1: pick an amount (none pre-selected; middle is "most common"). ──
          Selecting only *records* the amount — the supporter then chooses
          Ko-fi or PayPal below, and PayPal carries the amount through. */}
      <section className="donate-section">
        <div className="donate-section__title">
          <span>{t('donate.suggested_title', { defaultValue: 'Pick an amount' })}</span>
        </div>
        <div
          className="donate-amounts"
          role="group"
          aria-label={t('donate.suggested_title', { defaultValue: 'Pick an amount' })}
        >
          {SUGGESTED_AMOUNTS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={`donate-amount ${amount === a.value ? 'is-selected' : ''} ${a.common ? 'donate-amount--common' : ''}`}
              aria-pressed={amount === a.value}
              onClick={() => setAmount(amount === a.value ? null : a.value)}
            >
              <span className="donate-amount__value">{a.label}</span>
              {a.common && (
                <span className="donate-amount__badge">
                  {t('donate.most_common', { defaultValue: 'most common' })}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            className={`donate-amount donate-amount--custom ${amount === 'custom' ? 'is-selected' : ''}`}
            aria-pressed={amount === 'custom'}
            onClick={() => setAmount(amount === 'custom' ? null : 'custom')}
          >
            <span className="donate-amount__value">
              {t('donate.custom', { defaultValue: 'Custom' })}
            </span>
          </button>
        </div>
      </section>

      {/* ── Step 2: pick where (Ko-fi or PayPal). GitHub Sponsors isn't
          available; the supporter chooses, and PayPal carries the amount. ── */}
      <section className="donate-section">
        <div className="donate-section__title">
          <span>
            {typeof amount === 'number'
              ? t('donate.choose_method_amount', {
                  defaultValue: 'Continue with ${{amount}}',
                  amount,
                })
              : t('donate.choose_method', { defaultValue: 'Choose how to give' })}
          </span>
        </div>
        <div className="donate-grid support-methods">
          {METHODS.map((m, i) => (
            <LinkCard
              key={m.id}
              method={m}
              amount={typeof amount === 'number' ? amount : null}
              style={{ '--anim-i': i, '--card-hue': '#d3869b' }}
            />
          ))}
        </div>
      </section>

      {/* Non-monetary ways to help — gives people who can't (or don't want to)
          donate a real way to support, and balances out the panel. */}
      <section className="donate-section">
        <div className="donate-section__title">
          <span>{t('support.other_ways')}</span>
        </div>
        <div className="support-chips">
          <button
            type="button"
            className="support-chip"
            onClick={() => openExternal('https://github.com/debpalash/OmniVoice-Studio')}
          >
            <Star size={14} /> {t('support.star_github')}
          </button>
          <button
            type="button"
            className="support-chip"
            onClick={() => openExternal('https://discord.gg/bzQavDfVV9')}
          >
            <MessageCircle size={14} /> {t('support.join_discord')}
          </button>
        </div>
      </section>

      <div className="donate-footer">{t('donate.footer')}</div>
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
    <div className="support-view">
      <div className="ent-hero">
        <span className="ent-hero__kicker">{t('enterprise.badge')}</span>
        <h2 className="ent-hero__title">
          {t('enterprise.hero_title')}
          <span className="lp-hero__sweep" aria-hidden="true" />
        </h2>
        <p className="ent-hero__subtitle">
          {t('enterprise.hero_simple', {
            defaultValue:
              'OmniVoice Studio is free and open-source under the AGPL-3.0 — including for commercial and internal business use. You only need a commercial license to embed it in a closed-source product without AGPL’s copyleft obligations.',
          })}
        </p>
      </div>

      <section className="ent-why">
        <div className="ent-why__grid">
          {WHY_ITEMS.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="ent-why__card">
              <div className="ent-why__icon">
                <Icon size={16} />
              </div>
              <div className="ent-why__label">{label}</div>
              <div className="ent-why__desc">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* One clear next step: pricing is quoted per deployment, so the action
          is simply "tell me about your use case". */}
      <section className="ent-tiers-section">
        <div className="ent-coming-soon">
          <p>
            {t('enterprise.contact_lead', {
              defaultValue:
                'Pricing is quoted per deployment so it fits your team and workload. Tell me your use case and I’ll get you a quote.',
            })}
          </p>
          <button
            type="button"
            className="ent-coming-soon__cta"
            onClick={() => openExternal(LICENSE_MAILTO)}
          >
            <Mail size={13} />
            {t('enterprise.request_quote')}
          </button>
          <p className="ent-cta-footer__sub">
            <button
              type="button"
              className="ent-cta-footer__link"
              onClick={() => openExternal(LICENSE_MAILTO)}
              title={LICENSE_EMAIL}
            >
              {LICENSE_EMAIL}
            </button>
          </p>
        </div>
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

  return (
    <div className="support-page donate-page">
      {/* Aurora backdrop — shared with the Launchpad */}
      <div className="lp-aurora" aria-hidden="true">
        <span className="lp-aurora__blob lp-aurora__blob--pink" />
        <span className="lp-aurora__blob lp-aurora__blob--green" />
        <span className="lp-aurora__blob lp-aurora__blob--amber" />
      </div>

      {/* Top bar: Back (left) · toggle (center) · spacer (right, balances Back) */}
      <div className="support-page__topbar">
        <Button variant="subtle" size="sm" onClick={onBack} leading={<ArrowLeft size={14} />}>
          {t('donate.back')}
        </Button>

        <div className="support-toggle" role="tablist" aria-label={t('support.toggle_label')}>
          <span className="support-toggle__pill" data-view={view} aria-hidden="true" />
          <button
            type="button"
            role="tab"
            aria-selected={view === 'support'}
            className={`support-toggle__opt ${view === 'support' ? 'is-active' : ''}`}
            onClick={() => setView('support')}
          >
            <Heart size={13} /> {t('support.tab_support')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'license'}
            className={`support-toggle__opt ${view === 'license' ? 'is-active' : ''}`}
            onClick={() => setView('license')}
          >
            <Building2 size={13} /> {t('support.tab_license')}
          </button>
        </div>

        <span className="support-page__spacer" aria-hidden="true" />
      </div>

      {/* key={view} remounts the panel so its entry animations replay on toggle.
          The --support modifier vertically centers the (short) Support panel so
          it doesn't float at the top of an empty page; License stays top-aligned
          since it's tall enough to fill on its own. */}
      <div
        className={`support-page__content donate-page__content support-page__content--${view}`}
        key={view}
      >
        {view === 'support' ? <SupportView /> : <LicenseView />}
      </div>
    </div>
  );
}
