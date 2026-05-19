#!/usr/bin/env python3
"""validate-install-docs.py — Phase 1 INST-06 docs-drift CI gate.

Extract every fenced code block tagged with an HTML comment marker
`<!-- validate -->` from `docs/install/*.md` and assert each line of the
block appears (after normalisation) in `scripts/desktop-prod.sh`. The script
exits 1 on the first drift and prints the offending file + line on stderr so
CI logs lead the contributor straight to the fix.

Markers:
  <!-- validate -->        — gate the next fenced code block
  <!-- validate: skip -->  — opt-out: block exists for human readability only

Normalisation (per RESEARCH Pitfall #4):
  - rstrip trailing whitespace
  - normalise CRLF → LF
  - strip `$ ` and `>>> ` REPL/prompt prefixes
  - skip blank lines + lines that are only `#` comments

The validator is intentionally a one-way check: every validated docs line
must appear in the install script, but the script may contain extra setup
the docs don't surface (cleanup, log dirs, etc.). That asymmetry catches
"docs claim a command that the install path doesn't run" without forcing
docs to repeat every line of the install script.

Public entry point: `main(root: Path | None = None) -> int`
  Returns 0 on success, 1 on drift. Importable from unit tests so we can
  exercise the validator against tmp-path fixtures (per checker B-5 — the
  validator itself is regression-tested).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Iterable

# Match the `<!-- validate -->` (or `<!-- validate: skip -->`) marker on its
# own line, followed by an optional blank line, followed by a fenced block.
_MARKER_RE = re.compile(
    r"<!--\s*validate(?:\s*:\s*(?P<modifier>skip))?\s*-->",
    re.IGNORECASE,
)
_FENCE_OPEN_RE = re.compile(r"^```([A-Za-z0-9_+\-]*)\s*$")
_FENCE_CLOSE_RE = re.compile(r"^```\s*$")

_PROMPT_PREFIXES = ("$ ", ">>> ")


def _normalise_line(line: str) -> str:
    """Strip prompt prefixes + trailing whitespace + CRs. Returns '' for
    blank and comment-only lines (the caller treats '' as 'skip')."""
    # CRLF → LF was done at file read time; rstrip handles trailing CR too.
    s = line.rstrip("\r\n").rstrip()
    if not s:
        return ""
    if s.lstrip().startswith("#"):
        # Skip pure-comment lines — they're docs scaffolding, not commands.
        return ""
    for prefix in _PROMPT_PREFIXES:
        if s.lstrip().startswith(prefix):
            s = s.replace(prefix, "", 1)
            break
    return s.strip()


def _normalise_script(text: str) -> set[str]:
    """Return the set of normalised lines from the install script.

    The script has shebangs, env exports, function defs, etc. — we
    intentionally compare against the *entire* normalised contents (minus
    blanks/comments) so docs may pull any line that survives the install
    flow."""
    out: set[str] = set()
    for raw in text.splitlines():
        norm = _normalise_line(raw)
        if norm:
            out.add(norm)
    return out


def _extract_validated_blocks(md_text: str) -> list[tuple[int, str, bool]]:
    """Return a list of (start_line_no_1_indexed, body, skip_flag) tuples for
    every `<!-- validate -->` block found in the markdown."""
    lines = md_text.splitlines()
    blocks: list[tuple[int, str, bool]] = []
    i = 0
    pending_marker: tuple[int, bool] | None = None
    while i < len(lines):
        line = lines[i]
        m = _MARKER_RE.search(line)
        if m:
            pending_marker = (i + 1, (m.group("modifier") == "skip"))
            i += 1
            continue
        if pending_marker is not None and _FENCE_OPEN_RE.match(line):
            # Consume until matching close fence.
            block_lines: list[str] = []
            block_start = pending_marker[0]
            skip = pending_marker[1]
            pending_marker = None
            i += 1
            while i < len(lines) and not _FENCE_CLOSE_RE.match(lines[i]):
                block_lines.append(lines[i])
                i += 1
            i += 1  # skip the closing fence
            blocks.append((block_start, "\n".join(block_lines), skip))
            continue
        # Marker followed by something other than a fence — drop it.
        if pending_marker is not None and line.strip() and not _FENCE_OPEN_RE.match(line):
            pending_marker = None
        i += 1
    return blocks


def _iter_docs(root: Path) -> Iterable[Path]:
    docs_dir = root / "docs" / "install"
    if not docs_dir.exists():
        return []
    return sorted(docs_dir.glob("*.md"))


def main(root: Path | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Repo root to scan (defaults to the repo containing this script).",
    )
    # When `main()` is called programmatically (unit tests), we still want
    # argparse to work — pass an empty argv so it doesn't accidentally see
    # pytest's command-line args.
    if root is not None:
        args = parser.parse_args([])
        args.root = root
    else:
        args = parser.parse_args()
        if args.root is None:
            args.root = Path(__file__).resolve().parent.parent

    script_path = args.root / "scripts" / "desktop-prod.sh"
    if not script_path.exists():
        print(
            f"validate-install-docs: missing {script_path}; nothing to validate against",
            file=sys.stderr,
        )
        return 1

    canonical = _normalise_script(script_path.read_text(encoding="utf-8"))

    errors: list[str] = []
    validated = 0
    for md_path in _iter_docs(args.root):
        md_text = md_path.read_text(encoding="utf-8")
        for start_line, body, skip in _extract_validated_blocks(md_text):
            validated += 1
            if skip:
                continue
            for offset, raw in enumerate(body.splitlines(), start=0):
                norm = _normalise_line(raw)
                if not norm:
                    continue
                if norm not in canonical:
                    errors.append(
                        f"{md_path.relative_to(args.root)}:{start_line + 1 + offset}: "
                        f"docs line not present in scripts/desktop-prod.sh: {norm!r}"
                    )

    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        print(
            f"\nvalidate-install-docs: {len(errors)} drift(s) in {validated} validated block(s).",
            file=sys.stderr,
        )
        return 1

    print(f"OK — {validated} install docs block(s) validated against {script_path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
