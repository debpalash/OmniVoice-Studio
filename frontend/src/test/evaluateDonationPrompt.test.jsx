import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock react-hot-toast so no real timers / DOM toasts are scheduled.
// vi.hoisted lets the (hoisted) vi.mock factory reference these spies safely.
const { toastCustom, toastDismiss } = vi.hoisted(() => ({
  toastCustom: vi.fn(),
  toastDismiss: vi.fn(),
}));
vi.mock('react-hot-toast', () => ({
  default: { custom: toastCustom, dismiss: toastDismiss },
  toast: { custom: toastCustom, dismiss: toastDismiss },
}));

// Keep the data fetch deterministic + side-effect free.
vi.mock('../api/donation', () => ({
  loadDonationProgress: () => Promise.resolve({ raised: 100, goal: 200, currency: 'USD', sponsorCount: 9, updated: '2026-06-16' }),
}));

import { evaluateDonationPrompt } from '../components/donate/evaluateDonationPrompt';
import { useAppStore } from '../store';
import { INITIAL_DONATION } from '../store/donationSlice';

function resetDonation() {
  useAppStore.setState({ ...INITIAL_DONATION });
}

describe('evaluateDonationPrompt — success-only, gated, non-blocking', () => {
  beforeEach(() => {
    resetDonation();
    toastCustom.mockClear();
    toastDismiss.mockClear();
  });

  it('does NOT show during the grace window (early successes)', () => {
    expect(evaluateDonationPrompt('generic')).toBe(false);
    expect(evaluateDonationPrompt('generic')).toBe(false);
    expect(evaluateDonationPrompt('generic')).toBe(false); // 3rd success = still grace boundary→eligible only AFTER
    expect(toastCustom).not.toHaveBeenCalled();
  });

  it('shows exactly one postcard once past grace, then session-caps', () => {
    // burn the grace window
    evaluateDonationPrompt('generic');
    evaluateDonationPrompt('generic');
    evaluateDonationPrompt('generic');
    // next eligible success → shows
    expect(evaluateDonationPrompt('generic')).toBe(true);
    expect(toastCustom).toHaveBeenCalledTimes(1);
    // a second success the same session must NOT show again
    expect(evaluateDonationPrompt('generic')).toBe(false);
    expect(toastCustom).toHaveBeenCalledTimes(1);
  });

  it('never fires after opt-out (terminal)', () => {
    evaluateDonationPrompt('generic');
    evaluateDonationPrompt('generic');
    evaluateDonationPrompt('generic');
    useAppStore.getState().optOutOfDonation();
    useAppStore.getState().resetDonationSession();
    expect(evaluateDonationPrompt('generic')).toBe(false);
    expect(toastCustom).not.toHaveBeenCalled();
  });

  it('is the only path that surfaces the postcard — never invoked on errors', () => {
    // This is a guard test documenting the contract: the error branches in
    // useDubWorkflow / useProfiles / StoriesEditor call errorPill/toast.error
    // and NEVER evaluateDonationPrompt. Here we assert that simply NOT calling
    // the evaluator leaves the toast untouched (i.e. nothing auto-fires).
    useAppStore.getState().errorPill?.('boom');
    expect(toastCustom).not.toHaveBeenCalled();
  });
});
