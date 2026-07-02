// Launchpad feature-card regression suite (feat/launchpad-fullwidth).
//
// PR #904 fanned the seven feature cards into a fixed ~780px deck; this reworks
// them into a full-width, responsive grid (`.lp-cards`) that reflows its column
// count from the shell's OWN width — `repeat(auto-fit, minmax(--lp-card-min,
// 1fr))`, never a viewport @media. The grid renders at EVERY shell width (no
// deck-vs-fallback split); `useShellNarrow` only widens the card floor
// (`--lp-card-min`) so narrow shells pack fewer, comfier columns. Each card
// keeps #904's character: hue accent, count badge, animated waveform, and a
// hover/focus-forward raise (class-driven from React state so pointer and
// keyboard share one path). These tests pin: card count + order, that the cards
// fill width via the grid (not a fixed deck), the narrow-vs-wide responsive
// floor, navigation targets, and the raise interaction for pointer AND focus.
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

// Feature order is part of the contract: grid slot i = feature i.
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

const cardEls = (container) => [...container.querySelectorAll('.lp-action-card')];
const cardTitles = (container) => cardEls(container).map((c) => c.querySelector('h3').textContent);
const cardMin = (container) =>
  container.querySelector('.lp-cards').style.getPropertyValue('--lp-card-min').trim();

describe('Launchpad feature cards (full-width grid)', () => {
  it('renders all 7 features as grid cards, in the canonical order', () => {
    const { container } = renderShell(makeProps());
    const cards = cardEls(container);
    expect(cards).toHaveLength(7);
    expect(cardTitles(container)).toEqual(FEATURE_NAMES);
  });

  it('lays the cards out in the full-width grid, not a fixed-width deck', () => {
    const { container } = renderShell(makeProps());
    const grid = container.querySelector('.lp-cards');
    expect(grid).not.toBeNull();
    // Every card is a direct child of the one grid — no leftover deck fan.
    expect(container.querySelectorAll('.lp-deck, .lp-deck-card')).toHaveLength(0);
    expect(grid.querySelectorAll(':scope > .lp-action-card')).toHaveLength(7);
    // The grid's responsive column floor is wired (auto-fit minmax reads it).
    expect(cardMin(container)).toBe('200px');
  });

  it('uses a wider card floor on narrow shells — responsive columns, same 7 cards', () => {
    const wide = renderShell(makeProps());
    const narrow = renderShell(makeProps(), 'app-container shell-narrow');
    const mini = renderShell(makeProps(), 'app-container shell-mini');

    // The only responsive knob differs by the shell's OWN width class…
    expect(cardMin(wide.container)).toBe('200px');
    expect(cardMin(narrow.container)).toBe('240px');
    expect(cardMin(mini.container)).toBe('240px');
    // …but every shell renders the same seven cards (nothing is dropped).
    for (const r of [wide, narrow, mini]) {
      expect(cardTitles(r.container)).toEqual(FEATURE_NAMES);
    }
  });

  it('every card keeps its navigation target', () => {
    const setMode = vi.fn();
    const { container } = renderShell(makeProps({ setMode }));
    const cards = cardEls(container);
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
    const cards = cardEls(container);

    act(() => useAppStore.getState().setDefineMethod('design'));
    fireEvent.click(cards[0]); // Voice Clone
    expect(setMode).toHaveBeenLastCalledWith('studio');
    expect(useAppStore.getState().defineMethod).toBe('audio');

    fireEvent.click(cards[1]); // Voice Design
    expect(setMode).toHaveBeenLastCalledWith('studio');
    expect(useAppStore.getState().defineMethod).toBe('design');
  });

  it('hovering a card raises it forward; the others stay put', () => {
    const { container } = renderShell(makeProps());
    const grid = container.querySelector('.lp-cards');
    const cards = cardEls(container);

    fireEvent.mouseOver(cards[3]);
    expect(cards[3].className).toContain('lp-action-card--raised');
    // No overlap/tuck — every other card is unaffected.
    for (const i of [0, 1, 2, 4, 5, 6]) {
      expect(cards[i].className).not.toContain('lp-action-card--raised');
    }

    // Raising a different card moves the raise, never stacking two.
    fireEvent.mouseOver(cards[6]);
    expect(cards[6].className).toContain('lp-action-card--raised');
    expect(cards[3].className).not.toContain('lp-action-card--raised');

    // Leaving the grid settles every card back to rest.
    fireEvent.mouseOut(grid);
    expect(container.querySelector('.lp-action-card--raised')).toBeNull();
  });

  it('keyboard focus raises a card exactly like hover (a11y parity)', () => {
    const { container } = renderShell(makeProps());
    const cards = cardEls(container);

    act(() => cards[5].focus());
    expect(cards[5].className).toContain('lp-action-card--raised');
    for (const i of [0, 1, 2, 3, 4, 6]) {
      expect(cards[i].className).not.toContain('lp-action-card--raised');
    }

    act(() => cards[5].blur());
    expect(container.querySelector('.lp-action-card--raised')).toBeNull();
  });

  it('waveform strips are decorative only (aria-hidden, 7 bars each)', () => {
    const { container } = renderShell(makeProps());
    for (const card of cardEls(container)) {
      const wave = card.querySelector('.lp-card-wave');
      expect(wave).not.toBeNull();
      expect(wave.getAttribute('aria-hidden')).toBe('true');
      expect(wave.querySelectorAll('.lp-card-wave__bar')).toHaveLength(7);
    }
  });

  it('reacts to the shell class flipping at runtime (resize past breakpoint)', async () => {
    const { container } = renderShell(makeProps());
    expect(cardEls(container)).toHaveLength(7);
    expect(cardMin(container)).toBe('200px');

    const shell = container.querySelector('.app-container');
    await act(async () => {
      shell.classList.add('shell-narrow');
      await Promise.resolve(); // flush the MutationObserver microtask
    });
    // Same seven cards, just a wider column floor — no card dropped on resize.
    expect(cardEls(container)).toHaveLength(7);
    expect(cardMin(container)).toBe('240px');

    await act(async () => {
      shell.classList.remove('shell-narrow');
      await Promise.resolve();
    });
    expect(cardMin(container)).toBe('200px');
  });
});
