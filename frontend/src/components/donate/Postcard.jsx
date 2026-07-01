import React from 'react';
import { useTranslation } from 'react-i18next';
import { Star } from 'lucide-react';
import { useAppStore } from '../../store';
import { openExternal } from '../../api/external';
import GoalBar from './GoalBar';
import Pip from './Pip';

const SPONSOR_URL = 'https://github.com/sponsors/debpalash';
const STAR_URL = 'https://github.com/debpalash/OmniVoice-Studio';

/**
 * Postcard — the kawaii "Fund Claude Max" prompt, rendered as a NON-BLOCKING
 * react-hot-toast custom toast. No backdrop, no focus steal, never covers the
 * result (it lives in the bottom-right corner). Auto-dismisses (~12s) and
 * pauses on hover. Anti-dark-pattern by construction.
 *
 * Actions:
 *   - "Chip in ❤️"   → opens GitHub Sponsors, marks done, dismiss.
 *   - "Maybe later"  → soft dismiss (cooldown already anchored when shown).
 *   - "Don't ask again" (quiet) → terminal opt-out.
 *   - "⭐ Star on GitHub" (free way to help) → opens repo.
 *
 * Lead copy varies by milestone (spec.md variants).
 */
function leadKey(milestone) {
  switch (milestone) {
    case 'first-clone':
      return {
        k: 'donate.postcard.lead_first_clone',
        d: 'Your first voice clone is done — nice! OmniVoice runs entirely on your machine, and your support keeps it that way.',
      };
    case 'tenth-dub':
      return {
        k: 'donate.postcard.lead_tenth_dub',
        d: "Ten dubs in — you're clearly putting it to work. A small monthly chip-in funds the Claude Max that ships these features.",
      };
    case 'sustained-30d':
      return {
        k: 'donate.postcard.lead_sustained',
        d: "You've been with OmniVoice for a month. If it's earned a spot in your workflow, consider helping fund what's next.",
      };
    default:
      return {
        k: 'donate.postcard.lead_default',
        d: 'Glad that worked! OmniVoice is free and fully local. If it saves you time, a small monthly chip-in funds the Claude Max behind it.',
      };
  }
}

export default function Postcard({
  t: tt,
  milestone = null,
  progress = null,
  onDismiss,
  onOptOut,
}) {
  const { t } = useTranslation();
  const lead = leadKey(milestone);

  const onChipIn = () => {
    openExternal(SPONSOR_URL);
    onDismiss?.();
  };
  const onStar = () => {
    openExternal(STAR_URL);
  };
  const onSupportPage = () => {
    useAppStore.getState().setMode?.('donate');
    onDismiss?.();
  };

  return (
    <div className={`postcard ${tt?.visible ? '' : 'is-leaving'}`} role="status" aria-live="polite">
      {/* dot-grain texture + perforation are pure CSS pseudo-elements */}
      <span className="postcard__grain" aria-hidden="true" />

      <div className="postcard__stamp" aria-hidden="true">
        <Pip size={30} />
      </div>

      <button
        type="button"
        className="postcard__close absolute top-[6px] right-[8px] w-[20px] h-[20px] flex items-center justify-center [border:none] bg-transparent text-[var(--chrome-fg-dim)] text-[16px] leading-none cursor-pointer rounded-[var(--chrome-radius-pill)] z-[2] [transition:color_var(--dur-fast),background_var(--dur-fast)]"
        onClick={() => onDismiss?.()}
        aria-label={t('donate.postcard.dismiss_aria', { defaultValue: 'Dismiss' })}
      >
        ×
      </button>

      <div className="postcard__body relative z-[1] ml-[60px] flex flex-col gap-[8px]">
        <div className="postcard__title font-serif text-[0.98rem] font-medium tracking-[-0.01em] text-[var(--chrome-fg)]">
          {t('donate.postcard.title', { defaultValue: 'Fund Claude Max' })}
        </div>
        <p className="postcard__lead m-0 font-sans text-[0.72rem] leading-[1.5] text-[var(--chrome-fg-muted)]">
          {t(lead.k, { defaultValue: lead.d })}
        </p>

        <button
          type="button"
          className="postcard__goal-link block w-full p-0 my-[2px] mx-0 bg-transparent [border:none] text-left cursor-pointer"
          onClick={onSupportPage}
        >
          <GoalBar mini progress={progress} />
        </button>

        <div className="postcard__actions flex items-center gap-[8px] mt-[2px]">
          <button
            type="button"
            className="postcard__cta flex-1 px-[12px] py-[7px] rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-accent-border)] bg-[var(--chrome-accent-bg)] text-[var(--chrome-fg)] font-sans text-[0.74rem] font-semibold cursor-pointer [transition:background_var(--dur-fast),transform_var(--dur-base),border-color_var(--dur-fast)]"
            onClick={onChipIn}
          >
            {t('donate.postcard.chip_in', { defaultValue: 'Chip in' })} ❤️
          </button>
          <button
            type="button"
            className="postcard__later px-[10px] py-[7px] rounded-[var(--chrome-radius-pill)] [border:1px_solid_var(--chrome-border)] bg-transparent text-[var(--chrome-fg-muted)] font-sans text-[0.72rem] cursor-pointer [transition:color_var(--dur-fast),border-color_var(--dur-fast)]"
            onClick={() => onDismiss?.()}
          >
            {t('donate.postcard.later', { defaultValue: 'Maybe later' })}
          </button>
        </div>

        <div className="postcard__minor flex items-center justify-between gap-[8px] mt-[2px]">
          <button
            type="button"
            className="postcard__star inline-flex items-center gap-[4px] py-[2px] px-0 [border:none] bg-transparent font-mono text-[0.64rem] tracking-[0.02em] cursor-pointer [transition:color_var(--dur-fast)]"
            onClick={onStar}
          >
            <Star size={11} /> {t('donate.postcard.star', { defaultValue: 'Star on GitHub' })}
          </button>
          <button
            type="button"
            className="postcard__optout inline-flex items-center gap-[4px] py-[2px] px-0 [border:none] bg-transparent font-mono text-[0.64rem] tracking-[0.02em] cursor-pointer [transition:color_var(--dur-fast)]"
            onClick={() => onOptOut?.()}
          >
            {t('donate.postcard.opt_out', { defaultValue: "Don't ask again" })}
          </button>
        </div>
      </div>
    </div>
  );
}
