import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Shield, Zap, Users, Headphones, Code, Globe,
  Building2, Mail,
} from 'lucide-react';
import { Button } from '../ui';
import { openExternal } from '../api/external';
import './EnterprisePage.css';

const WHY_ITEMS = [
  { icon: Shield, labelKey: 'enterprise.feature_full_ip', descKey: 'enterprise.feature_full_ip_desc' },
  { icon: Zap, labelKey: 'enterprise.feature_zero_cost', descKey: 'enterprise.feature_zero_cost_desc' },
  { icon: Users, labelKey: 'enterprise.feature_team_access', descKey: 'enterprise.feature_team_access_desc' },
  { icon: Headphones, labelKey: 'enterprise.feature_direct_support', descKey: 'enterprise.feature_direct_support_desc' },
  { icon: Code, labelKey: 'enterprise.feature_source_available', descKey: 'enterprise.feature_source_available_desc' },
  { icon: Globe, labelKey: 'enterprise.feature_languages', descKey: 'enterprise.feature_languages_desc' },
];

export default function EnterprisePage({ onBack }) {
  const { t } = useTranslation();

  return (
    <div className="enterprise-page">
      {/* Aurora backdrop — same as Launchpad */}
      <div className="lp-aurora" aria-hidden="true">
        <span className="lp-aurora__blob lp-aurora__blob--pink" />
        <span className="lp-aurora__blob lp-aurora__blob--green" />
        <span className="lp-aurora__blob lp-aurora__blob--amber" />
      </div>

      <div className="enterprise-page__back">
        <Button
          variant="subtle"
          size="sm"
          onClick={onBack}
          leading={<ArrowLeft size={14} />}
        >
          {t('enterprise.back_to_studio')}
        </Button>
      </div>

      <div className="enterprise-page__content">
        {/* Hero */}
        <div className="ent-hero">
          <span className="ent-hero__kicker">{t('enterprise.commercial_license')}</span>
          <h2 className="ent-hero__title">
            {t('enterprise.hero_title')}
            <span className="lp-hero__sweep" aria-hidden="true" />
          </h2>
          <p className="ent-hero__subtitle">
            {t('enterprise.hero_subtitle_p1')}{' '}
            <button
              type="button"
              className="ent-cta-footer__link"
              onClick={() => openExternal('https://fsl.software/')}
            >
              Functional Source License
            </button>
            {t('enterprise.hero_subtitle_p2')}
            <strong> {t('enterprise.hero_subtitle_cta')}</strong>
          </p>
        </div>

        {/* Why Businesses Choose OmniVoice */}
        <section className="ent-why">
          <div className="ent-section-title">
            <span>{t('enterprise.why_businesses')}</span>
          </div>
          <div className="ent-why__grid">
            {WHY_ITEMS.map(({ icon: Icon, labelKey, descKey }) => (
              <div key={labelKey} className="ent-why__card">
                <div className="ent-why__icon"><Icon size={16} /></div>
                <div className="ent-why__label">{t(labelKey)}</div>
                <div className="ent-why__desc">{t(descKey)}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing — coming soon */}
        <section className="ent-tiers-section">
          <div className="ent-section-title">
            <span>{t('enterprise.pricing')}</span>
          </div>
          <div className="ent-coming-soon">
            <p>
              <strong>{t('enterprise.pricing_note')}</strong>
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

        {/* FAQ */}
        <section className="ent-faq">
          <div className="ent-section-title">
            <span>{t('enterprise.common_questions')}</span>
          </div>
          <div className="ent-faq__list">
            <details className="ent-faq__item">
              <summary>{t('enterprise.faq_internal')}</summary>
              <p>{t('enterprise.faq_internal_answer_page')}</p>
            </details>
            <details className="ent-faq__item">
              <summary>{t('enterprise.faq_try')}</summary>
              <p>{t('enterprise.faq_try_answer_page')}</p>
            </details>
            <details className="ent-faq__item">
              <summary>{t('enterprise.faq_watermark')}</summary>
              <p>{t('enterprise.faq_watermark_answer_page')}</p>
            </details>
            <details className="ent-faq__item">
              <summary>{t('enterprise.faq_apache')}</summary>
              <p>{t('enterprise.faq_apache_answer_page')}</p>
            </details>
          </div>
        </section>

        {/* CTA footer */}
        <div className="ent-cta-footer">
          <p>{t('enterprise.footer_contact')} <button type="button" className="ent-cta-footer__link" onClick={() => openExternal('mailto:OmniVoice@palash.dev')}>OmniVoice@palash.dev</button></p>
          <p className="ent-cta-footer__sub">
            {t('enterprise.footer_discord')} <button type="button" className="ent-cta-footer__link" onClick={() => openExternal('https://discord.gg/bzQavDfVV9')}>{t('enterprise.footer_discord_link')}</button> {t('enterprise.footer_community_support')}
          </p>
        </div>
      </div>
    </div>
  );
}
