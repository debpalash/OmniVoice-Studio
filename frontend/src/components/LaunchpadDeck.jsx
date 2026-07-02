import React, { useState } from 'react';

// ── Feature-card geometry ───────────────────────────────────────────
// Decorative waveform bar heights (px) on each card face — 7 CSS-only bars
// pulse via stagger-delayed scaleY keyframes (see .lp-card-wave in
// index.css). Static under prefers-reduced-motion.
const CARD_WAVE = [8, 15, 10, 19, 12, 16, 9];
// Card min-track (px) handed to the grid's `repeat(auto-fit, minmax(min, 1fr))`.
// This floor is the ONLY responsive knob: the browser derives the column count
// from the grid's OWN rendered width (= the shell's own width under the
// `zoom: --ui-scale` model), so columns reflow 7→…→1 with zero viewport @media.
// A wider floor on narrow shells yields fewer, comfier columns.
const CARD_MIN_WIDE = '200px';
const CARD_MIN_NARROW = '240px';

/**
 * FeatureCard — one launchpad feature tile in the full-width grid. `--card-hue`
 * (inline) drives the accent: icon, border, waveform, badge, glow. Hover OR
 * keyboard focus raises the card forward (`lp-action-card--raised`: lift + glow
 * + top z) — the raise is class-driven from React state so pointer and keyboard
 * share one code path and tests can assert it. The waveform strip is pure
 * decoration (aria-hidden); the button's accessible name stays title + desc.
 */
function FeatureCard({ hue, Icon, title, desc, count, onClick, index, raised, onRaise, onSettle }) {
  // Cursor-tracked spotlight: pointer position feeds --mx/--my so the
  // .lp-glow-layer radial gradient follows the cursor (it centres itself on
  // keyboard focus, which has no pointer).
  const handleMouseMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  return (
    <button
      type="button"
      className={`lp-action-card lp-animate lp-glow-card${raised === index ? ' lp-action-card--raised' : ''}`}
      style={{ '--card-hue': hue, '--lp-i': index }}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => onRaise(index)}
      onFocus={() => onRaise(index)}
      onBlur={onSettle}
    >
      <span className="lp-glow-layer" aria-hidden="true" />
      {count > 0 && <span className="card-count">{count}</span>}
      <div className="card-icon">
        <Icon size={18} color={hue} />
      </div>
      <h3>{title}</h3>
      <p className="card-desc">{desc}</p>
      <span className="lp-card-wave" aria-hidden="true">
        {CARD_WAVE.map((h, i) => (
          <span
            key={i}
            className="lp-card-wave__bar"
            style={{ '--wave-h': `${h}px`, '--wave-i': i }}
          />
        ))}
      </span>
    </button>
  );
}

/**
 * LaunchpadDeck — the launchpad's seven feature cards as a full-width,
 * responsive grid. PR #904 fanned them into a fixed ~780px deck that left dead
 * margins in a maximized window; this fills the content width instead and
 * reflows its column count (7→…→1 from a maximized ~2560px display down to the
 * 900×600 minimum) via `repeat(auto-fit, minmax(--lp-card-min, 1fr))` — the
 * same container-driven mechanism the rest of the launchpad uses, never a
 * viewport @media (which fires at the wrong width whenever --ui-scale ≠ 1).
 * `narrow` (the app-container's own width class, via useShellNarrow) only
 * widens the card floor so narrow shells get fewer, comfier columns. Which card
 * is raised by hover/focus lives here in React so keyboard focus shares the
 * exact same forward-lift as the pointer and tests can assert it.
 */
export default function LaunchpadDeck({ features, narrow = false }) {
  const [raised, setRaised] = useState(null);
  return (
    <div
      className="lp-cards"
      style={{ '--lp-card-min': narrow ? CARD_MIN_NARROW : CARD_MIN_WIDE }}
      onMouseLeave={() => setRaised(null)}
    >
      {features.map((f, i) => (
        <FeatureCard
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
