import React, { useState } from 'react';

// ── Deck-of-cards geometry ──────────────────────────────────────────
// Per-card tilt (deg) and lift (px) for the fanned spread. Hand-picked so
// the fan reads "artistically shuffled" but stays subtle (±4° / ≤14px) and
// deterministic — same layout every launch, no randomness. Index-aligned
// with the launchpad feature order.
const DECK_TILT = [-3.5, 2, -1, 3, -2, 3.5, -1.5];
const DECK_LIFT = [10, 2, 14, 0, 12, 4, 8];
// Decorative waveform bar heights (px) on each card face — 7 CSS-only bars
// pulse via stagger-delayed scaleY keyframes (see .lp-deck-wave in
// index.css). Static under prefers-reduced-motion.
const DECK_WAVE = [8, 15, 10, 19, 12, 16, 9];

/**
 * DeckCard — one card in the fanned deck. Absolutely positioned by CSS from
 * `--deck-i` (fan slot), `--deck-r` (tilt) and `--deck-y` (lift); `--card-hue`
 * drives the accent exactly like ActionCard. Hover OR keyboard focus raises
 * the card (`--front`: straighten + scale up + top z) while every sibling
 * tucks toward it underneath (`--tuck-r` for cards left of it slides them
 * right, `--tuck-l` slides the right-side ones left) — the raise/tuck classes
 * are state-driven so pointer and focus share one code path. The icon + name
 * cluster is width-capped to the peeking strip so it stays readable while the
 * card sits under its right neighbor; the waveform strip is pure decoration
 * (aria-hidden), the button's accessible name stays name + description.
 */
function DeckCard({ hue, Icon, title, desc, count, onClick, index, raised, onRaise, onSettle }) {
  const state =
    raised == null
      ? ''
      : raised === index
        ? 'lp-deck-card--front'
        : index < raised
          ? 'lp-deck-card--tuck-r'
          : 'lp-deck-card--tuck-l';
  return (
    <button
      type="button"
      className={`lp-deck-card ${state}`}
      style={{
        '--card-hue': hue,
        '--deck-i': index,
        '--deck-r': `${DECK_TILT[index]}deg`,
        '--deck-y': `${DECK_LIFT[index]}px`,
      }}
      onClick={onClick}
      onMouseEnter={() => onRaise(index)}
      onFocus={() => onRaise(index)}
      onBlur={onSettle}
    >
      {count > 0 && <span className="card-count">{count}</span>}
      <span className="lp-deck-card__peek">
        <span className="card-icon">
          <Icon size={16} color={hue} />
        </span>
        <span className="lp-deck-card__name">{title}</span>
      </span>
      <span className="lp-deck-card__desc">{desc}</span>
      <span className="lp-deck-wave" aria-hidden="true">
        {DECK_WAVE.map((h, i) => (
          <span
            key={i}
            className="lp-deck-wave__bar"
            style={{ '--wave-h': `${h}px`, '--wave-i': i }}
          />
        ))}
      </span>
    </button>
  );
}

/**
 * LaunchpadDeck — the launchpad's feature cards as an overlapping
 * left→right fan (wide shells only; Launchpad.jsx renders the flat
 * ActionCard grid on shell-narrow/shell-mini instead). Interaction state —
 * which card is raised by hover/focus, or none — lives here in React (not
 * pure CSS :hover) so keyboard focus shares the exact same raise/tuck
 * behavior and tests can assert it.
 */
export default function LaunchpadDeck({ features }) {
  const [raised, setRaised] = useState(null);
  return (
    <div
      className={`lp-deck${raised != null ? ' lp-deck--active' : ''}`}
      style={{ '--deck-n': features.length }}
      onMouseLeave={() => setRaised(null)}
    >
      {features.map((f, i) => (
        <DeckCard
          key={f.key}
          index={i}
          hue={f.hue}
          Icon={f.Icon}
          title={f.title}
          desc={f.desc}
          count={f.count}
          onClick={f.go}
          raised={raised}
          onRaise={setRaised}
          onSettle={() => setRaised(null)}
        />
      ))}
    </div>
  );
}
