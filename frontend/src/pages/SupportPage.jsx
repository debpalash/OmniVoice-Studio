import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Heart, ExternalLink, ArrowLeft, Building2,
  Shield, Zap, Users, Headphones, Code, Globe, Mail,
  Star, MessageCircle,
} from 'lucide-react';
import { Button } from '../ui';
import { openExternal } from '../api/external';
import GoalBar from '../components/donate/GoalBar';
import { loadDonationProgress, BUNDLED_PROGRESS } from '../api/donation';
import './DonatePage.css';
import './EnterprisePage.css';
import './SupportPage.css';

const SPONSOR_URL = 'https://github.com/sponsors/debpalash';
// Suggested amounts — middle option ($5) is flagged "most common".
// None is pre-selected (no dark-pattern default-charge nudge).
const SUGGESTED_AMOUNTS = [
  { value: 3,  label: '$3' },
  { value: 5,  label: '$5', common: true },
  { value: 10, label: '$10' },
];

const METHODS = [
  { id: 'github', label: 'GitHub Sponsors', descriptionKey: 'donate.github_desc', url: 'https://github.com/debpalash', icon: '🐙' },
  { id: 'kofi', label: 'Ko-fi', descriptionKey: 'donate.coffee_desc', url: 'https://ko-fi.com/debpalash', icon: '☕' },
  { id: 'paypal', label: 'PayPal', descriptionKey: 'donate.paypal_desc', url: 'https://paypal.me/palashCoder', icon: '💳' },
];

function LinkCard({ method, style }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="donate-card donate-card--link lp-glow-card"
      style={style}
      onClick={() => openExternal(method.url)}
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
    loadDonationProgress().then((p) => { if (alive) setProgress(p); });
    return () => { alive = false; };
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

      {/* ── Suggested amounts (none pre-selected; middle is "most common") ── */}
      <section className="donate-section">
        <div className="donate-section__title"><span>{t('donate.suggested_title', { defaultValue: 'Pick an amount' })}</span></div>
        <div className="donate-amounts" role="group" aria-label={t('donate.suggested_title', { defaultValue: 'Pick an amount' })}>
          {SUGGESTED_AMOUNTS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={`donate-amount ${amount === a.value ? 'is-selected' : ''} ${a.common ? 'donate-amount--common' : ''}`}
              aria-pressed={amount === a.value}
              onClick={() => { setAmount(a.value); openExternal(SPONSOR_URL); }}
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
            onClick={() => { setAmount('custom'); openExternal(SPONSOR_URL); }}
          >
            <span className="donate-amount__value">{t('donate.custom', { defaultValue: 'Custom' })}</span>
          </button>
        </div>
      </section>

      <section className="donate-section">
        <div className="donate-section__title"><span>{t('donate.platforms')}</span></div>
        <div className="donate-grid support-methods">
          {METHODS.map((m, i) => (
            <LinkCard key={m.id} method={m} style={{ '--anim-i': i, '--card-hue': '#d3869b' }} />
          ))}
        </div>
      </section>

      {/* Non-monetary ways to help — gives people who can't (or don't want to)
          donate a real way to support, and balances out the panel. */}
      <section className="donate-section">
        <div className="donate-section__title"><span>{t('support.other_ways')}</span></div>
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
function LicenseView() {
  const { t } = useTranslation();
  const WHY_ITEMS = [
    { icon: Shield, label: t('enterprise.benefit_ip'), desc: t('enterprise.benefit_ip_desc') },
    { icon: Zap, label: t('enterprise.benefit_cost'), desc: t('enterprise.benefit_cost_desc') },
    { icon: Users, label: t('enterprise.benefit_team'), desc: t('enterprise.benefit_team_desc') },
    { icon: Headphones, label: t('enterprise.benefit_support'), desc: t('enterprise.benefit_support_desc') },
    { icon: Code, label: t('enterprise.benefit_source'), desc: t('enterprise.benefit_source_desc') },
    { icon: Globe, label: t('enterprise.benefit_lang'), desc: t('enterprise.benefit_lang_desc') },
  ];
  return (
    <div className="support-view">
      <div className="ent-hero">
        <span className="ent-hero__kicker">{t('enterprise.badge')}</span>
        <h2 className="ent-hero__title">
          {t('enterprise.hero_title')}
          <span className="lp-hero__sweep" aria-hidden="true" />
        </h2>
        <p className="ent-hero__subtitle">{t('enterprise.hero_desc')}</p>
        <p className="ent-hero__subtitle">{t('enterprise.hero_note')}</p>
      </div>

      <section className="ent-why">
        <div className="ent-section-title"><span>{t('enterprise.why_title')}</span></div>
        <div className="ent-why__grid">
          {WHY_ITEMS.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="ent-why__card">
              <div className="ent-why__icon"><Icon size={16} /></div>
              <div className="ent-why__label">{label}</div>
              <div className="ent-why__desc">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="ent-tiers-section">
        <div className="ent-section-title"><span>{t('enterprise.pricing_title')}</span></div>
        <div className="ent-coming-soon">
          <p>
            <strong>{t('enterprise.pricing_desc')}</strong>{' '}
            {t('enterprise.pricing_detail')}
          </p>
          <button
            type="button"
            className="ent-coming-soon__cta"
            onClick={() => openExternal('mailto:OmniVoice@palash.dev?subject=OmniVoice Commercial License Inquiry&body=Hi Palash,%0A%0AI%27d like to talk about a commercial license for OmniVoice Studio.%0A%0AOrganization:%0ATeam size:%0AUse case:%0A')}
          >
            <Mail size={13} />
            {t('enterprise.request_quote')}
          </button>
        </div>
      </section>

      <section className="ent-faq">
        <div className="ent-section-title"><span>{t('enterprise.faq_title')}</span></div>
        <div className="ent-faq__list">
          <details className="ent-faq__item">
            <summary>{t('enterprise_faq.q_internal_tools')}</summary>
            <p>{t('enterprise_faq.a_internal_tools')}</p>
          </details>
          <details className="ent-faq__item">
            <summary>{t('enterprise_faq.q_try_before')}</summary>
            <p>{t('enterprise_faq.a_try_before')}</p>
          </details>
          <details className="ent-faq__item">
            <summary>{t('enterprise_faq.q_watermark')}</summary>
            <p>{t('enterprise_faq.a_watermark')}</p>
          </details>
        </div>
      </section>

      <div className="ent-cta-footer">
        <p>
          <button
            type="button"
            className="ent-cta-footer__link"
            onClick={() => openExternal('mailto:OmniVoice@palash.dev')}
            title="OmniVoice@palash.dev"
          >
            {t('enterprise.footer_email')}
          </button>
        </p>
        <p className="ent-cta-footer__sub">
          <button
            type="button"
            className="ent-cta-footer__link"
            onClick={() => openExternal('https://discord.gg/bzQavDfVV9')}
            title="discord.gg/bzQavDfVV9"
          >
            {t('enterprise.footer_discord')}
          </button>
        </p>
      </div>
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
      <div className={`support-page__content donate-page__content support-page__content--${view}`} key={view}>
        {view === 'support' ? <SupportView /> : <LicenseView />}
      </div>
    </div>
  );
}
