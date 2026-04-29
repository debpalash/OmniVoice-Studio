import React from 'react';
import { Heart, ExternalLink, ArrowLeft, Building2 } from 'lucide-react';
import { Button } from '../ui';
import { openExternal } from '../api/external';
import './DonatePage.css';

const METHODS = [
  {
    id: 'github',
    label: 'GitHub Sponsors',
    description: 'Recurring or one-time — directly through GitHub.',
    url: 'https://github.com/debpalash',
    icon: '🐙',
  },
  {
    id: 'kofi',
    label: 'Ko-fi',
    description: 'Buy the team a coffee. No account needed.',
    url: 'https://ko-fi.com/debpalash',
    icon: '☕',
  },
  {
    id: 'paypal',
    label: 'PayPal',
    description: 'Quick one-time or recurring via PayPal.',
    url: 'https://paypal.me/palashCoder',
    icon: '💳',
  },
];

function LinkCard({ method, style }) {
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
        <div className="donate-card__desc">{method.description}</div>
      </div>
      <div className="donate-card__arrow">
        <ExternalLink size={14} />
      </div>
    </button>
  );
}

export default function DonatePage({ onBack, onEnterprise }) {
  return (
    <div className="donate-page">
      {/* Aurora backdrop — same as Launchpad */}
      <div className="lp-aurora" aria-hidden="true">
        <span className="lp-aurora__blob lp-aurora__blob--pink" />
        <span className="lp-aurora__blob lp-aurora__blob--green" />
        <span className="lp-aurora__blob lp-aurora__blob--amber" />
      </div>

      {/* Top bar: Back (left) + Commercial License (right) */}
      <div className="donate-page__topbar">
        <Button
          variant="subtle"
          size="sm"
          onClick={onBack}
          leading={<ArrowLeft size={14} />}
        >
          Back to Studio
        </Button>
        {onEnterprise && (
          <Button
            variant="subtle"
            size="sm"
            onClick={onEnterprise}
            leading={<Building2 size={14} />}
            trailing={<ExternalLink size={12} />}
          >
            Commercial License
          </Button>
        )}
      </div>

      <div className="donate-page__content">
        {/* Hero */}
        <div className="donate-hero">
          <div className="donate-hero__icon-wrap">
            <Heart size={24} className="donate-hero__heart" />
          </div>
          <h2 className="donate-hero__title">
            Support OmniVoice
            <span className="lp-hero__sweep" aria-hidden="true" />
          </h2>
          <p className="donate-hero__subtitle">
            OmniVoice is free, open-source, and runs entirely on your hardware.
            If it brings value to your workflow, consider supporting the core team.
          </p>
        </div>

        {/* Platforms */}
        <section className="donate-section">
          <div className="donate-section__title">
            <span>Platforms</span>
          </div>
          <div className="donate-grid donate-grid--links">
            {METHODS.map((m, i) => (
              <LinkCard
                key={m.id}
                method={m}
                style={{ '--anim-i': i, '--card-hue': '#d3869b' }}
              />
            ))}
          </div>
        </section>

        <div className="donate-footer">
          Every contribution helps push the boundaries of local AI. ♥
        </div>
      </div>
    </div>
  );
}
