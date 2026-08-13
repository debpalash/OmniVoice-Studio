// The merged support page — sponsor, commercial licence and contact are three
// sections of one scroll now, and `initialView` decides which one you land on.
//
// The subtle part is that App.jsx renders SupportPage in the SAME tree position
// for `donate`, `enterprise` and `contact`, so React keeps one instance alive
// and only swaps props. A view change is therefore a prop change, not a mount —
// which is exactly how "support scrolls to the top" got missed: the effect
// treated 'support' as already-there and left you on whichever section you had
// navigated from.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../api/external', () => ({ openExternal: vi.fn() }));
// Partial mock: only the network call is stubbed. GoalBar imports the real
// progressPct / isGoalMet, and a hand-written module object would silently
// drop whichever helper it gains next.
vi.mock('../api/donation', async (importOriginal) => ({
  ...(await importOriginal()),
  loadDonationProgress: () => Promise.resolve({ raised: 0, goal: 100, sponsorCount: 0 }),
}));

import SupportPage from '../pages/SupportPage';

/** Ids that were scrolled to, in order.
 *
 * `scrollIntoView` does not exist in this DOM environment, so it is stubbed on
 * the prototype — before the first render, since the effect fires on mount. The
 * stub records `this.id`, which is what makes "landed on the right section"
 * assertable at all. */
const scrolledTo = [];

beforeEach(() => {
  scrolledTo.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function scrollIntoViewStub() {
    scrolledTo.push(this.id);
  });
  // The effect defers to rAF so layout has happened; run it synchronously.
  vi.stubGlobal('requestAnimationFrame', (cb) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

describe('the merged support page', () => {
  it('carries all three sections on one scroll', () => {
    render(<SupportPage onBack={() => {}} />);
    for (const id of ['support-give', 'support-license', 'support-contact']) {
      expect(document.getElementById(id)).toBeInTheDocument();
    }
    // Contact's channels came along with it, not just its heading.
    expect(screen.getByRole('heading', { name: 'Report a bug' })).toBeInTheDocument();
  });

  it('lands on the section the route asked for', () => {
    const { rerender } = render(<SupportPage onBack={() => {}} initialView="support" />);
    rerender(<SupportPage onBack={() => {}} initialView="contact" />);
    expect(scrolledTo).toContain('support-contact');
  });

  it('goes back to the top when the route returns to support', () => {
    // THE REGRESSION: the same instance is reused across donate / enterprise /
    // contact, so a 'support' view that skipped scrolling left the footer heart
    // showing the contact section you were already on.
    const { rerender } = render(<SupportPage onBack={() => {}} initialView="contact" />);
    expect(scrolledTo).toEqual(['support-contact']);

    rerender(<SupportPage onBack={() => {}} initialView="support" />);
    expect(scrolledTo).toEqual(['support-contact', 'support-give']);
  });
});
