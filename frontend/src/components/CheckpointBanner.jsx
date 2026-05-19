import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, ArrowRight, X, Sparkles, Languages, Mic } from 'lucide-react';
import { Button } from '../ui';
import './Misc.css';

const STAGE_KEYS = {
  asr: {
    icon: Mic,
    accent: '#b8bb26',
    titleKey: 'dub.transcripts_ready',
    ctaKey: 'dub.translate',
    ctaIcon: Languages,
    hintKey: 'dub.checkpoint_asr_hint',
  },
  translate: {
    icon: Languages,
    accent: '#83a598',
    titleKey: 'dub.translations_ready',
    ctaKey: 'dub.generate_dub',
    ctaIcon: Sparkles,
    hintKey: 'dub.checkpoint_translate_hint',
  },
  done: {
    icon: CheckCircle,
    accent: '#8ec07c',
    titleKey: 'dub.dub_complete',
    ctaKey: null,
    hintKey: 'dub.checkpoint_review',
  },
};

export default function CheckpointBanner({ stage, count, onContinue, onDismiss, continueLoading }) {
  const { t } = useTranslation();
  const cfg = STAGE_KEYS[stage];
  if (!cfg) return null;

  const Icon = cfg.icon;
  const CtaIcon = cfg.ctaIcon;

  return (
    <div
      className="checkpoint-banner ckpt-banner"
      style={{ borderLeft: `2px solid ${cfg.accent}` }}
      role="status"
    >
      <Icon size={14} color={cfg.accent} className="ckpt-icon" />
      <div className="ckpt-body">
        <div className="ckpt-head">
          <span className="ckpt-title">
            {t(cfg.titleKey)}
          </span>
          {typeof count === 'number' && (
            <span className="ckpt-count">
              {count} {t('dub.segments')}
            </span>
          )}
        </div>
        <span className="ckpt-hint">
          {t(cfg.hintKey)}
        </span>
      </div>
      {cfg.ctaKey && onContinue && (
        <Button
          variant="subtle"
          size="sm"
          onClick={onContinue}
          loading={continueLoading}
          leading={CtaIcon ? <CtaIcon size={10} /> : null}
          trailing={<ArrowRight size={10} />}
        >
          {t(cfg.ctaKey)}
        </Button>
      )}
      {onDismiss && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          title={t('dub.checkpoint_dismiss')}
          iconSize="sm"
        >
          <X size={10} />
        </Button>
      )}
    </div>
  );
}
