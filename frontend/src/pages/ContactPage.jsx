import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ExternalLink, MessageCircle, Mail, Bug, Globe } from 'lucide-react';
import { Button } from '../ui';
import { openExternal } from '../api/external';
import './DonatePage.css';
import './SupportPage.css';

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
    <div className="support-page donate-page">
      <div className="lp-aurora" aria-hidden="true">
        <span className="lp-aurora__blob lp-aurora__blob--pink" />
        <span className="lp-aurora__blob lp-aurora__blob--green" />
        <span className="lp-aurora__blob lp-aurora__blob--amber" />
      </div>

      <div className="support-page__topbar">
        <Button variant="subtle" size="sm" onClick={onBack} leading={<ArrowLeft size={14} />}>
          {t('donate.back')}
        </Button>
        <span className="support-page__spacer" aria-hidden="true" />
      </div>

      <div className="support-page__content donate-page__content support-page__content--support">
        <div className="support-view">
          <div className="donate-hero">
            <div className="donate-hero__icon-wrap">
              <MessageCircle size={24} className="donate-hero__heart" />
            </div>
            <h2 className="donate-hero__title">
              {t('contact.hero_title', { defaultValue: 'Get in touch' })}
              <span className="lp-hero__sweep" aria-hidden="true" />
            </h2>
            <p className="donate-hero__subtitle">
              {t('contact.hero_desc', {
                defaultValue:
                  'Questions, bugs, licensing, or just to say hi — here’s how to reach me.',
              })}
            </p>
          </div>

          <section className="donate-section">
            <div className="donate-grid support-methods">
              {CHANNELS.map((c, i) => {
                const Icon = c.icon;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="donate-card donate-card--link lp-glow-card"
                    style={{ '--anim-i': i, '--card-hue': c.hue }}
                    onClick={() => openExternal(c.url)}
                  >
                    <span className="donate-card__glow" aria-hidden="true" />
                    <div className="donate-card__icon">
                      <Icon size={20} />
                    </div>
                    <div className="donate-card__body">
                      <div className="donate-card__label">
                        {t(c.labelKey, { defaultValue: c.labelDefault })}
                      </div>
                      <div className="donate-card__desc">
                        {t(c.descKey, { defaultValue: c.descDefault })}
                      </div>
                      <div className="contact-card__value">{c.value}</div>
                    </div>
                    <div className="donate-card__arrow">
                      <ExternalLink size={14} />
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
