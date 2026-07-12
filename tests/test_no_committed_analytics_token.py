"""No analytics token may be committed to the repo.

gitleaks caught a hardcoded PostHog key in frontend/src/utils/analytics.ts once.
PostHog client tokens are *publishable* (write-only event ingestion, not data
access), so it was never a credential leak — but a token-shaped literal in the
source is a bad habit, and this project already bans them. The destination is
supplied at BUILD time instead (VITE_POSTHOG_KEY / POSTHOG_PROJECT_TOKEN).

This guard makes the rule ours rather than relying on the scanner to catch it,
and it fails BEFORE a push rather than after. Same file-scanning idiom as
test_no_hardcoded_cjk / test_no_literal_borders.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]

# A PostHog project key. Deliberately matched by SHAPE, not by the specific value,
# so a *different* key can't slip through.
_POSTHOG_KEY_RE = re.compile(r"phc_[A-Za-z0-9]{20,}")

_SKIP_DIRS = {"node_modules", ".git", "target", "dist", "build", ".venv", "zig-out"}
_SCAN_EXT = {".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".json", ".yml", ".yaml", ".md", ".env"}


def _tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=_REPO, capture_output=True, text=True, check=True
    ).stdout
    for name in (n for n in out.split("\0") if n):
        p = Path(name)
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        if p.suffix.lower() in _SCAN_EXT:
            yield name, _REPO / p


def test_no_posthog_token_is_committed():
    offenders = []
    for name, path in _tracked_files():
        # This guard describes the pattern it forbids, so exempt itself.
        if name == "tests/test_no_committed_analytics_token.py":
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if _POSTHOG_KEY_RE.search(text):
            offenders.append(name)

    assert not offenders, (
        "A PostHog token literal is committed in: "
        + ", ".join(offenders)
        + ". Supply it at build time instead (VITE_POSTHOG_KEY for the frontend, "
        "POSTHOG_PROJECT_TOKEN for the backend) — see frontend/src/utils/analytics.ts."
    )


def test_the_frontend_reads_its_token_from_the_build_env():
    """The mechanism that replaces the literal must stay in place."""
    src = (_REPO / "frontend/src/utils/analytics.ts").read_text(encoding="utf-8")
    assert "VITE_POSTHOG_KEY" in src
