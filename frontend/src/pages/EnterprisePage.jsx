import React from 'react';
import {
  ArrowLeft, Shield, Zap, Users, Headphones, Code, Globe,
  Building2, Mail,
} from 'lucide-react';
import { Button } from '../ui';
import { openExternal } from '../api/external';
import './EnterprisePage.css';

const WHY_ITEMS = [
  { icon: Shield, label: 'Full IP ownership', desc: 'Your voices, your data, your servers. No third-party dependency.' },
  { icon: Zap, label: 'Zero per-minute costs', desc: 'Flat licensing. Generate millions of minutes without usage caps.' },
  { icon: Users, label: 'Team-wide access', desc: 'Share across your org. No per-seat API key management.' },
  { icon: Headphones, label: 'Direct support', desc: 'Talk to the engineers who built it, not a helpdesk.' },
  { icon: Code, label: 'Source-available core', desc: 'Audit the code. Fork if needed. Apache 2.0 two years after release — no vendor lock-in.' },
  { icon: Globe, label: '646 languages', desc: 'Ship global content from one tool. No third-party locale add-ons.' },
];

export default function EnterprisePage({ onBack }) {
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
          Back to Studio
        </Button>
      </div>

      <div className="enterprise-page__content">
        {/* Hero */}
        <div className="ent-hero">
          <span className="ent-hero__kicker">Commercial License</span>
          <h2 className="ent-hero__title">
            Ship AI voices in production
            <span className="lp-hero__sweep" aria-hidden="true" />
          </h2>
          <p className="ent-hero__subtitle">
            OmniVoice Studio is source-available under the{' '}
            <button
              type="button"
              className="ent-cta-footer__link"
              onClick={() => openExternal('https://fsl.software/')}
            >
              Functional Source License
            </button>
            {' '}— free for personal, educational, and non-commercial use,
            and converts to Apache 2.0 two years after each release.
            Building a competing product or service on top of OmniVoice?
            <strong> Pricing tiers coming soon — get in touch in the meantime.</strong>
          </p>
        </div>

        {/* Why Businesses Choose OmniVoice */}
        <section className="ent-why">
          <div className="ent-section-title">
            <span>Why businesses choose OmniVoice</span>
          </div>
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

        {/* Pricing — coming soon */}
        <section className="ent-tiers-section">
          <div className="ent-section-title">
            <span>Pricing</span>
          </div>
          <div className="ent-coming-soon">
            <p>
              <strong>Tiers and pricing are still being finalized.</strong>{' '}
              Until they're public, every commercial deployment is being
              quoted individually so we can right-size for your team and
              workload.
            </p>
            <button
              type="button"
              className="ent-coming-soon__cta"
              onClick={() => openExternal('mailto:OmniVoice@palash.dev?subject=OmniVoice Commercial License Inquiry&body=Hi Palash,%0A%0AI%27d like to talk about a commercial license for OmniVoice Studio.%0A%0AOrganization:%0ATeam size:%0AUse case:%0A')}
            >
              <Mail size={13} />
              Request a quote
            </button>
          </div>
        </section>

        {/* FAQ */}
        <section className="ent-faq">
          <div className="ent-section-title">
            <span>Common questions</span>
          </div>
          <div className="ent-faq__list">
            <details className="ent-faq__item">
              <summary>Do I need a license for internal tools?</summary>
              <p>Internal use by your employees and contractors is a Permitted Purpose under the FSL — no license required. A commercial license is needed when you make OmniVoice available to others as part of a competing product or service (resale, hosted SaaS, white-label).</p>
            </details>
            <details className="ent-faq__item">
              <summary>Can I try before committing?</summary>
              <p>Yes. The full app is free to download and run locally for evaluation under the FSL. When you're ready to discuss a commercial deployment, email us and we'll work through the details together.</p>
            </details>
            <details className="ent-faq__item">
              <summary>What about the watermark?</summary>
              <p>The invisible AudioSeal watermark is embedded by default. Commercial licensees can disable it in Settings → Privacy. Free/personal use always includes the watermark.</p>
            </details>
            <details className="ent-faq__item">
              <summary>Does the source ever become Apache 2.0?</summary>
              <p>Yes. Each release converts automatically to the Apache License, Version 2.0 on the second anniversary of its publication. That means today's release is Apache 2.0 in two years, no action required from us — the FSL guarantees it irrevocably.</p>
            </details>
          </div>
        </section>

        {/* CTA footer */}
        <div className="ent-cta-footer">
          <p>Questions? Reach out at <button type="button" className="ent-cta-footer__link" onClick={() => openExternal('mailto:OmniVoice@palash.dev')}>OmniVoice@palash.dev</button></p>
          <p className="ent-cta-footer__sub">
            Join our <button type="button" className="ent-cta-footer__link" onClick={() => openExternal('https://discord.gg/aRRdVj3de7')}>Discord</button> for community support.
          </p>
        </div>
      </div>
    </div>
  );
}
