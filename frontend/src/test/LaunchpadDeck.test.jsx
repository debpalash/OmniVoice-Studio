// Launchpad deck-of-cards regression suite (feat/launchpad-deck).
//
// The launchpad's seven feature cards render as an overlapping left→right
// fan on wide shells; hovering or keyboard-focusing any card raises it
// (`--front`) while every other card tucks toward/under it (`--tuck-r` /
// `--tuck-l`). On `shell-narrow`/`shell-mini` shells (the app-container's
// own width classes — NOT viewport @media) the deck degrades to the
// pre-existing flat ActionCard grid. Both branches share one feature list,
// so these tests pin: card count + order, navigation targets, the
// raise/tuck interaction for pointer AND focus, and the narrow fallback.
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { useAppStore } from '../store';
import Launchpad from '../pages/Launchpad';

// ReadinessChecklist needs a react-query provider + live endpoints — not
// under test here.
vi.mock('../components/ReadinessChecklist', () => ({ default: () => null }));

// Feature order is part of the contract: deck slot i = grid slot i.
const FEATURE_NAMES = [
  'Voice Clone',
  'Voice Design',
  'Video Dubbing',
  'Stories',
  'Audiobook',
  'Voice Gallery',
  'Transcripts',
];

function makeProps(overrides = {}) {
  return {
    profiles: [],
    studioProjects: [],
    exportHistory: [],
    setMode: vi.fn(),
    setIsCompareModalOpen: vi.fn(),
    handleSelectProfile: vi.fn(),
    loadProject: vi.fn(),
    ...overrides,
  };
}

// The component reads its breakpoint from the closest `.app-container`'s
// shell-narrow/shell-mini classes (mirroring App.jsx's shell-width classes),
// so tests wrap it in a stand-in shell.
function renderShell(props, shellClass = 'app-container') {
  return render(
    <I18nextProvider i18n={i18n}>
      <div className={shellClass}>
        <Launchpad {...props} />
      </div>
    </I18nextProvider>,
  );
}

const deckCards = (container) => [...container.querySelectorAll('.lp-deck-card')];

describe('Launchpad deck (wide shell)', () => {
  it('renders all 7 features as deck cards, in the canonical order', () => {
    const { container } = renderShell(makeProps());
    const cards = deckCards(container);
    expect(cards).toHaveLength(7);
    expect(cards.map((c) => c.querySelector('.lp-deck-card__name').textContent)).toEqual(
      FEATURE_NAMES,
    );
    // Deck replaces the grid on wide shells — never both.
    expect(container.querySelectorAll('.lp-action-card')).toHaveLength(0);
  });

  it('every card keeps its navigation target', () => {
    const setMode = vi.fn();
    const { container } = renderShell(makeProps({ setMode }));
    const cards = deckCards(container);
    const modeTargets = [
      [2, 'dub'],
      [3, 'stories'],
      [4, 'audiobook'],
      [5, 'gallery'],
      [6, 'transcriptions'],
    ];
    for (const [i, mode] of modeTargets) {
      fireEvent.click(cards[i]);
      expect(setMode).toHaveBeenLastCalledWith(mode);
    }
  });

  it('clone/design cards open the studio preset to the matching method', () => {
    const setMode = vi.fn();
    const { container } = renderShell(makeProps({ setMode }));
    const cards = deckCards(container);

    act(() => useAppStore.getState().setDefineMethod('design'));
    fireEvent.click(cards[0]); // Voice Clone
    expect(setMode).toHaveBeenLastCalledWith('studio');
    expect(useAppStore.getState().defineMethod).toBe('audio');

    fireEvent.click(cards[1]); // Voice Design
    expect(setMode).toHaveBeenLastCalledWith('studio');
    expect(useAppStore.getState().defineMethod).toBe('design');
  });

  it('hovering a card raises it and tucks every other card toward it', () => {
    const { container } = renderShell(makeProps());
    const deck = container.querySelector('.lp-deck');
    const cards = deckCards(container);

    fireEvent.mouseOver(cards[3]);
    expect(deck.className).toContain('lp-deck--active');
    expect(cards[3].className).toContain('lp-deck-card--front');
    // Cards left of the raised one slide right toward it…
    for (const i of [0, 1, 2]) expect(cards[i].className).toContain('lp-deck-card--tuck-r');
    // …cards right of it slide left — everything hides under the raised card.
    for (const i of [4, 5, 6]) expect(cards[i].className).toContain('lp-deck-card--tuck-l');

    // Symmetric: raising a different card re-partitions the tuck sides.
    fireEvent.mouseOver(cards[6]);
    expect(cards[6].className).toContain('lp-deck-card--front');
    for (const i of [0, 1, 2, 3, 4, 5]) {
      expect(cards[i].className).toContain('lp-deck-card--tuck-r');
    }

    // Leaving the deck settles the fan back to rest.
    fireEvent.mouseOut(deck);
    expect(deck.className).not.toContain('lp-deck--active');
    expect(container.querySelector('.lp-deck-card--front')).toBeNull();
  });

  it('keyboard focus raises a card exactly like hover (a11y parity)', () => {
    const { container } = renderShell(makeProps());
    const deck = container.querySelector('.lp-deck');
    const cards = deckCards(container);

    act(() => cards[5].focus());
    expect(deck.className).toContain('lp-deck--active');
    expect(cards[5].className).toContain('lp-deck-card--front');
    expect(cards[6].className).toContain('lp-deck-card--tuck-l');

    act(() => cards[5].blur());
    expect(deck.className).not.toContain('lp-deck--active');
    expect(container.querySelector('.lp-deck-card--front')).toBeNull();
  });

  it('waveform strips are decorative only (aria-hidden, 7 bars each)', () => {
    const { container } = renderShell(makeProps());
    for (const card of deckCards(container)) {
      const wave = card.querySelector('.lp-deck-wave');
      expect(wave).not.toBeNull();
      expect(wave.getAttribute('aria-hidden')).toBe('true');
      expect(wave.querySelectorAll('.lp-deck-wave__bar')).toHaveLength(7);
    }
  });
});

describe('Launchpad deck (narrow fallback)', () => {
  it.each(['shell-narrow', 'shell-mini'])(
    'degrades to the flat ActionCard grid under %s',
    (cls) => {
      const setMode = vi.fn();
      const { container } = renderShell(makeProps({ setMode }), `app-container ${cls}`);
      expect(container.querySelectorAll('.lp-deck-card')).toHaveLength(0);
      const gridCards = [...container.querySelectorAll('.lp-action-card')];
      expect(gridCards).toHaveLength(7);
      expect(gridCards.map((c) => c.querySelector('h3').textContent)).toEqual(FEATURE_NAMES);
      // Fallback cards keep the same navigation wiring.
      fireEvent.click(gridCards[2]);
      expect(setMode).toHaveBeenLastCalledWith('dub');
    },
  );

  it('reacts to the shell class flipping at runtime (resize past breakpoint)', async () => {
    const { container } = renderShell(makeProps());
    expect(container.querySelectorAll('.lp-deck-card')).toHaveLength(7);

    const shell = container.querySelector('.app-container');
    await act(async () => {
      shell.classList.add('shell-narrow');
      await Promise.resolve(); // flush the MutationObserver microtask
    });
    expect(container.querySelectorAll('.lp-deck-card')).toHaveLength(0);
    expect(container.querySelectorAll('.lp-action-card')).toHaveLength(7);

    await act(async () => {
      shell.classList.remove('shell-narrow');
      await Promise.resolve();
    });
    expect(container.querySelectorAll('.lp-deck-card')).toHaveLength(7);
  });
});
