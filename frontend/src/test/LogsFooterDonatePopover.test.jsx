// LogsFooter donation-moment popover — render-level coverage: the footer
// hears DONATION_MOMENT_EVENT, anchors the speech bubble above the heart,
// pulses the heart while open, and honors Later / Don't-ask-again / the
// ~15s auto-dismiss. Storage is the mocked localStorage from setup.js; the
// eligibility RNG/clock are injected where the engine is driven end-to-end.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

vi.mock('../api/hooks', () => ({
  useSystemLogs: () => ({ data: null, refetch: vi.fn() }),
  useTauriLogs: () => ({ data: null, refetch: vi.fn() }),
  useNotifications: () => ({ data: null }),
}));
vi.mock('../api/system', () => ({
  clearSystemLogs: vi.fn(),
  clearTauriLogs: vi.fn(),
}));
// NetworkToggle fetches /system/network/state on mount — out of scope here.
vi.mock('../components/NetworkToggle', () => ({ default: () => null }));

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('../api/external', () => ({ openExternal }));

import LogsFooter from '../components/LogsFooter';
import { DONATE_POPOVER_AUTO_DISMISS_MS } from '../components/DonateMomentPopover';
import {
  recordValueMoment,
  _resetDonationSessionForTests,
  DONATION_MOMENT_EVENT,
  MIN_LIFETIME_MOMENTS,
  FIRST_PROMPT_MIN_DAYS,
  LS_MOMENT_COUNT,
  LS_FIRST_MOMENT_AT,
  LS_OPT_OUT,
} from '../utils/donationMoments';
import { KOFI_URL, PAYPAL_URL } from '../utils/donateLinks';
import { useAppStore } from '../store';

const DAY = 24 * 60 * 60 * 1000;

function fireMoment(line = 0) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(DONATION_MOMENT_EVENT, { detail: { kind: 'export', line } }),
    );
  });
}

const popover = () => screen.queryByTestId('donate-moment-popover');
const heartBtn = () => screen.getByLabelText('Support this project');

beforeEach(() => {
  localStorage.clear();
  _resetDonationSessionForTests();
  openExternal.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LogsFooter donation-moment popover', () => {
  it('is hidden by default and appears on the donation-moment event', () => {
    render(<LogsFooter />);
    expect(popover()).toBeNull();

    fireMoment(0);
    expect(popover()).toBeInTheDocument();
    // Line 1 copy (en), Ko-fi + PayPal CTAs, Later, and the quiet opt-out.
    expect(screen.getByText(/100% local/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support OmniVoice on Ko-fi' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Support OmniVoice via PayPal' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Don't ask again" })).toBeInTheDocument();
  });

  it('shows end-to-end when the eligibility engine fires (mocked storage + random)', () => {
    render(<LogsFooter />);
    // Seed persisted history: past the lifetime minimum, first moment long ago.
    localStorage.setItem(LS_MOMENT_COUNT, String(MIN_LIFETIME_MOMENTS));
    localStorage.setItem(
      LS_FIRST_MOMENT_AT,
      String(Date.now() - (FIRST_PROMPT_MIN_DAYS + 1) * DAY),
    );
    act(() => {
      const res = recordValueMoment('export', { random: () => 0 }); // roll always wins
      expect(res.show).toBe(true);
    });
    expect(popover()).toBeInTheDocument();
  });

  it('pulses the heart while open, and "Later" quietly dismisses', () => {
    render(<LogsFooter />);
    expect(heartBtn().className).toContain('heart-glow');

    fireMoment(1);
    expect(heartBtn().className).toContain('donate-heart-pulse');

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(popover()).toBeNull();
    expect(heartBtn().className).toContain('heart-glow');
    // "Later" must NOT opt the user out.
    expect(localStorage.getItem(LS_OPT_OUT)).toBeNull();
  });

  it('"Don\'t ask again" sets the permanent opt-out (new + legacy flags)', () => {
    render(<LogsFooter />);
    fireMoment(2);
    fireEvent.click(screen.getByRole('button', { name: "Don't ask again" }));
    expect(popover()).toBeNull();
    expect(localStorage.getItem(LS_OPT_OUT)).toBe('1');
    expect(useAppStore.getState().optedOut).toBe(true);
  });

  it('Ko-fi / PayPal CTAs open the existing donate links and dismiss', () => {
    render(<LogsFooter />);
    fireMoment(0);
    fireEvent.click(screen.getByRole('button', { name: 'Support OmniVoice on Ko-fi' }));
    expect(openExternal).toHaveBeenCalledWith(KOFI_URL);
    expect(popover()).toBeNull();

    fireMoment(0);
    fireEvent.click(screen.getByRole('button', { name: 'Support OmniVoice via PayPal' }));
    expect(openExternal).toHaveBeenCalledWith(PAYPAL_URL);
    expect(popover()).toBeNull();
  });

  it(`auto-dismisses after ${DONATE_POPOVER_AUTO_DISMISS_MS / 1000}s`, () => {
    vi.useFakeTimers();
    render(<LogsFooter />);
    fireMoment(3);
    expect(popover()).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(DONATE_POPOVER_AUTO_DISMISS_MS - 1);
    });
    expect(popover()).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(popover()).toBeNull();
  });

  it('manual entry is unchanged: the heart still opens the donate view', () => {
    render(<LogsFooter />);
    fireMoment(0);
    fireEvent.click(heartBtn());
    // Popover retires and the app routes to the existing donate mode.
    expect(popover()).toBeNull();
    expect(useAppStore.getState().mode).toBe('donate');
  });
});
