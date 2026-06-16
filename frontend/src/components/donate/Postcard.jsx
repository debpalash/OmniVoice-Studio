import React from 'react';
import { useTranslation } from 'react-i18next';
import { Star } from 'lucide-react';
import { useAppStore } from '../../store';
import { openExternal } from '../../api/external';
import GoalBar from './GoalBar';
import Pip from './Pip';
import './Postcard.css';

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
    case 'first-clone':   return { k: 'donate.postcard.lead_first_clone', d: 'Your first voice clone is done — nice! OmniVoice runs entirely on your machine, and your support keeps it that way.' };
    case 'tenth-dub':     return { k: 'donate.postcard.lead_tenth_dub', d: "Ten dubs in — you're clearly putting it to work. A small monthly chip-in funds the Claude Max that ships these features." };
    case 'sustained-30d': return { k: 'donate.postcard.lead_sustained', d: "You've been with OmniVoice for a month. If it's earned a spot in your workflow, consider helping fund what's next." };
    default:              return { k: 'donate.postcard.lead_default', d: 'Glad that worked! OmniVoice is free and fully local. If it saves you time, a small monthly chip-in funds the Claude Max behind it.' };
  }
}

export default function Postcard({ t: tt, milestone = null, progress = null, onDismiss, onOptOut }) {
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
    <div
      className={`postcard ${tt?.visible ? '' : 'is-leaving'}`}
      role="status"
      aria-live="polite"
    >
      {/* dot-grain texture + perforation are pure CSS pseudo-elements */}
      <span className="postcard__grain" aria-hidden="true" />

      <div className="postcard__stamp" aria-hidden="true">
        <Pip size={30} />
      </div>

      <button
        type="button"
        className="postcard__close"
        onClick={() => onDismiss?.()}
        aria-label={t('donate.postcard.dismiss_aria', { defaultValue: 'Dismiss' })}
      >
        ×
      </button>

      <div className="postcard__body">
        <div className="postcard__title">
          {t('donate.postcard.title', { defaultValue: 'Fund Claude Max' })}
        </div>
        <p className="postcard__lead">{t(lead.k, { defaultValue: lead.d })}</p>

        <button type="button" className="postcard__goal-link" onClick={onSupportPage}>
          <GoalBar mini progress={progress} />
        </button>

        <div className="postcard__actions">
          <button type="button" className="postcard__cta" onClick={onChipIn}>
            {t('donate.postcard.chip_in', { defaultValue: 'Chip in' })} ❤️
          </button>
          <button type="button" className="postcard__later" onClick={() => onDismiss?.()}>
            {t('donate.postcard.later', { defaultValue: 'Maybe later' })}
          </button>
        </div>

        <div className="postcard__minor">
          <button type="button" className="postcard__star" onClick={onStar}>
            <Star size={11} /> {t('donate.postcard.star', { defaultValue: 'Star on GitHub' })}
          </button>
          <button type="button" className="postcard__optout" onClick={() => onOptOut?.()}>
            {t('donate.postcard.opt_out', { defaultValue: "Don't ask again" })}
          </button>
        </div>
      </div>
    </div>
  );
}
