import React from 'react';
import { CheckCircle, ArrowRight, X, Sparkles, Languages, Mic } from 'lucide-react';
import { Button } from '../ui';

/**
 * Phase 4.3 — between-stage checkpoint banner.
 *
 * The dub pipeline has three natural review points (post-ASR, post-translate,
 * post-generate). Each one is a chance for the user to spot a mistake before
 * it compounds into the next stage. This banner makes that review window
 * explicit instead of silently leaving the user on the segment editor with
 * no cue about what to do next.
 *
 * Render it above the segment table. Pass `onContinue` to advance the
 * pipeline directly from the banner's CTA (translate, generate, etc).
 */

const STAGE_CONFIG = {
  asr: {
    icon: Mic,
    accent: '#b8bb26',
    title: 'Transcripts ready',
    cta: 'Translate',
    ctaIcon: Languages,
    hint: 'Fix any ASR errors now — tight diction saves TTS attempts later.',
  },
  translate: {
    icon: Languages,
    accent: '#83a598',
    title: 'Translations ready',
    cta: 'Generate dub',
    ctaIcon: Sparkles,
    hint: 'Skim the target text. Over-length lines get speed-boosted; you can also edit directly.',
  },
  done: {
    icon: CheckCircle,
    accent: '#8ec07c',
    title: 'Dub complete',
    cta: null,
    hint: 'Review timing and sync ratios. Tweak any line and hit "Regen changed" for a fast partial redo.',
  },
};

export default function CheckpointBanner({ stage, count, onContinue, onDismiss, continueLoading }) {
  const cfg = STAGE_CONFIG[stage];
  if (!cfg) return null;

  const Icon = cfg.icon;
  const CtaIcon = cfg.ctaIcon;

  return (
    <div
      className="checkpoint-banner"
      style={{
        // Accent shows through as a left-edge bar instead of a gradient wash,
        // and the fill stays flat chrome so the banner rhymes with the rest
        // of the studio strips.
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        marginBottom: 6,
        borderRadius: 'var(--chrome-radius-pill)',
        background: 'var(--chrome-bg)',
        border: '1px solid var(--chrome-border)',
        borderLeft: `2px solid ${cfg.accent}`,
      }}
      role="status"
    >
      <Icon size={14} color={cfg.accent} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{
            fontFamily: 'var(--chrome-font-mono)',
            fontSize: 'var(--chrome-label-size)',
            letterSpacing: 'var(--chrome-label-track)',
            textTransform: 'uppercase',
            fontWeight: 600,
            color: 'var(--chrome-fg)',
          }}>
            {cfg.title}
          </span>
          {typeof count === 'number' && (
            <span style={{
              fontFamily: 'var(--chrome-font-mono)',
              fontSize: 'var(--chrome-label-size)',
              color: 'var(--chrome-fg-muted)',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {count} segment{count === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <span style={{ fontSize: '0.64rem', color: 'var(--chrome-fg-muted)', lineHeight: 1.35 }}>
          {cfg.hint}
        </span>
      </div>
      {cfg.cta && onContinue && (
        <Button
          variant="subtle"
          size="sm"
          onClick={onContinue}
          loading={continueLoading}
          leading={CtaIcon ? <CtaIcon size={10} /> : null}
          trailing={<ArrowRight size={10} />}
        >
          {cfg.cta}
        </Button>
      )}
      {onDismiss && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          title="Dismiss — won't reappear for this stage until reload"
          iconSize="sm"
        >
          <X size={10} />
        </Button>
      )}
    </div>
  );
}
