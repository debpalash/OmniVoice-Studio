"""Hard rule: no decorative literal-color borders in the frontend.

The app-wide border/divider removal (owner-approved) stripped every decorative
border, hairline, divider, and panel frame. Perceivability is preserved through
background/elevation cues (selection, inputs, chips) and the kept
``:focus-visible`` / ``--color-ring`` / ``--focus-ring`` focus indicators.

This guard fails if the *regression class* reappears — the hardcoded neutral
hairlines and inline border colors that ``--color-border`` token-zeroing can't
reach:

  1. Neutral (white / black) literal ``border[-x]:`` colors in ``index.css``.
  2. ``border-white/…`` / ``border-black/…`` Tailwind utilities, or
     ``border-[#…]`` / ``border-[rgb(a)(…)]`` / ``border-[hsl(…)]`` literal-color
     arbitrary utilities, in ``*.jsx`` / ``*.tsx``.
  3. Inline ``style={{ borderColor: … }}`` (non-transparent) in ``*.jsx`` /
     ``*.tsx``.

It deliberately does NOT flag: ``:focus-visible`` / ring rules, the
``--color-ring`` / ``--focus-ring`` focus tokens, ``border-transparent`` /
``border-0``, ``var(--…)``-driven borders (the ``--*-border`` tokens are zeroed
centrally; accent/severity token borders are intentional semantic state cues),
or colored non-neutral literal CSS borders kept as functional editor / severity
affordances (e.g. the waveform segment editor).
"""
import re
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_SRC = _REPO / "frontend" / "src"
_INDEX_CSS = _SRC / "index.css"

# This enforcement file's own pattern literals must not trip the scan.
_SELF = Path(__file__).name

# ── 1) Neutral literal border colors in index.css ────────────────────────────
# `(?<![\w-])` keeps `--color-border` / `--chrome-border` custom-property
# *definitions* (which are token-zeroed by the trailing override block) from
# matching; only real `border[-x]:` declarations using a white/black rgba fill.
_CSS_NEUTRAL_BORDER = re.compile(
    r"(?<![\w-])border[a-z-]*\s*:[^;{}]*?"
    r"rgba\(\s*(?:255\s*,\s*255\s*,\s*255|0\s*,\s*0\s*,\s*0)\s*,",
)

# ── 2) Literal-color border utilities in JSX/TSX ─────────────────────────────
_JSX_BORDER_UTIL = re.compile(
    r"border(?:-[trblxy])?-(?:white|black)(?:/|\b)"
    r"|border(?:-[trblxy])?-\[(?:#|rgba?\(|hsl\()",
)

# ── 3) Inline borderColor (non-transparent) ──────────────────────────────────
_JSX_BORDERCOLOR = re.compile(r"borderColor\s*:")


def _iter_frontend_files(suffixes):
    for p in _SRC.rglob("*"):
        if p.suffix in suffixes and p.name != _SELF:
            yield p


def test_no_neutral_literal_borders_in_index_css():
    offenders = []
    for i, line in enumerate(_INDEX_CSS.read_text().splitlines(), 1):
        if _CSS_NEUTRAL_BORDER.search(line):
            offenders.append(f"index.css:{i}: {line.strip()}")
    assert not offenders, (
        "Decorative neutral (white/black) literal borders reappeared in "
        "index.css. Use `border: … transparent` (or drop the border) — the "
        "app-wide border removal zeroed these.\n" + "\n".join(offenders)
    )


def test_no_literal_color_border_utilities_in_jsx():
    offenders = []
    for p in _iter_frontend_files({".jsx", ".tsx"}):
        for i, line in enumerate(p.read_text().splitlines(), 1):
            for m in _JSX_BORDER_UTIL.finditer(line):
                token = m.group(0)
                if "border-transparent" in token:
                    continue
                offenders.append(f"{p.relative_to(_REPO)}:{i}: …{token}…")
    assert not offenders, (
        "Literal-color border utilities reappeared. Use `border-transparent` "
        "(keep the width to suppress the no-Preflight UA border) or a "
        "background tint for active/selected state.\n" + "\n".join(offenders)
    )


def test_no_inline_border_color_in_jsx():
    offenders = []
    for p in _iter_frontend_files({".jsx", ".tsx"}):
        for i, line in enumerate(p.read_text().splitlines(), 1):
            if _JSX_BORDERCOLOR.search(line) and "transparent" not in line:
                offenders.append(f"{p.relative_to(_REPO)}:{i}: {line.strip()}")
    assert not offenders, (
        "Inline `borderColor` reappeared. Convey selection/error via a "
        "background tint (see WorkspaceHistory / DubSegmentRow) instead.\n"
        + "\n".join(offenders)
    )


def test_focus_indicators_are_preserved():
    """Regression guard: the border removal must not strip focus a11y."""
    css = _INDEX_CSS.read_text()
    assert "--color-ring:" in css, "--color-ring focus token was removed"
    assert "--focus-ring:" in css, "--focus-ring token was removed"
    assert ":focus-visible" in css, ":focus-visible ring rules were removed"
    # The token-zeroing override must NOT have zeroed the focus ring.
    assert "--color-ring: transparent" not in css
    assert "--focus-ring: transparent" not in css


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
