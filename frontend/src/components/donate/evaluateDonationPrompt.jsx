import React from 'react';
import toast from 'react-hot-toast';
import { useAppStore } from '../../store';
import { loadDonationProgress } from '../../api/donation';
import Postcard from './Postcard';

/**
 * The ONE shared entry point that decides whether to surface the "Fund Claude
 * Max" postcard after a successful action, and renders it as a non-blocking
 * custom toast if so.
 *
 * Call this right after a *successful* completePill(...) / clone-save resolve —
 * NEVER on the error / in-progress / setup / first-run path. The slice's state
 * machine (grace, ≤1/session, escalating cooldowns, opt-out, milestones) makes
 * the final call; this function just wires it to the toast UI.
 *
 * @param {'clone'|'dub'|'longform'|'generic'} kind  which success happened
 * @param {{ now?: number }} [opts]
 * @returns {boolean} whether a postcard was shown
 */
export function evaluateDonationPrompt(kind = 'generic', opts = {}) {
  const store = useAppStore.getState();
  const decision = store.recordDonationSuccess(kind, opts.now);
  if (!decision.show) return false;

  // Mark shown immediately so a second rapid success in the same tick can't
  // double-fire (the session cap + cooldown anchor are set right away).
  store.markDonationShown(decision.milestone, opts.now);

  const id = `donate-postcard-${Date.now()}`;

  // Best-effort fetch the freshest progress for the mini bar inside the card;
  // Postcard falls back to the bundled snapshot if this is slow/offline.
  let progress = null;
  loadDonationProgress()
    .then((p) => { progress = p; })
    .catch(() => {});

  toast.custom(
    (tt) => (
      <Postcard
        t={tt}
        milestone={decision.milestone}
        progress={progress}
        onDismiss={() => toast.dismiss(id)}
        onOptOut={() => { useAppStore.getState().optOutOfDonation(); toast.dismiss(id); }}
      />
    ),
    {
      id,
      duration: 12000,        // auto-dismiss ~12s
      position: 'bottom-right',
    },
  );
  return true;
}

export default evaluateDonationPrompt;
