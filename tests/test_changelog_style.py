"""CHANGELOG.md quiet-style linter — deterministic CI for the release-notes rule.

CLAUDE.md, "Release notes / changelog" (hard rule, owner-restyled 2026-07-17):
sections are **quiet and scannable** — a short `**Highlights**` bullet list
first, then `### Changed` / `### Added` / … subsections where each entry is a
single one-liner carrying its `(#NNN)` ref and `— thanks @user!` credit where
applicable. No multi-line paragraphs, no raw commit dumps.

Scope: the file is newest-first, so the linter checks `## [Unreleased]` and any
released section until it reaches the first release dated before the restyle
(2026-07-17). Everything older is grandfathered in the old bold-lead style —
and because new sections are always inserted at the top, nothing new can hide
behind an old date or a typo'd heading.
"""

import datetime
import os
import re

_REPO_CHANGELOG = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "CHANGELOG.md"
)

_RULE = 'CLAUDE.md "Release notes / changelog" (hard rule, owner-restyled 2026-07-17)'

# Sections released before the owner restyle keep their old bold-lead style.
_STYLE_EPOCH = datetime.date(2026, 7, 17)

# Longest a one-liner entry may run. Generous — the point is to fail paragraph
# entries, not to golf good one-liners.
_MAX_ENTRY_CHARS = 400

# Entry subsections whose bullets must carry a `(#N)` ref or a
# `— thanks @user!` credit. Changed/Docs/CI/License lines are often
# owner-authored housekeeping without an issue, so only these two.
_REF_REQUIRED_SECTIONS = {"Added", "Fixed"}

# Owner-authored infra entries allowed without a ref/credit (direct-to-main
# work with no issue or PR to point at). Match is by substring; keep this list
# short and delete entries once they ship in a tagged release.
_REF_ALLOWLIST = (
    # owner commit 7036e101 — first-run consent prompt, committed straight to main
    "First-run consent question for the existing opt-in analytics",
    # owner commits ce842737 + dc766baf — Colab notebook, committed straight to main
    "Official Google Colab notebook",
    # owner-directed architecture work (remote/goal.md → goal_v2.md), no issue
    "Remote workers** sends individual jobs to GPUs",
    # owner-requested workspace promotion (engines + model store out of Settings), no issue
    "Model Catalogue** — a workspace of its own",
)

_HEADING = re.compile(r"^## \[([^\]]+)\](?:\s*[—–-]\s*(.*))?$")
_REF_AT_END = re.compile(r"\(#\d+(?:,\s*#\d+)*\)\s*$")
_CREDIT = re.compile(r"— thanks @\w[\w-]*")


def _section_date(suffix):
    if not suffix:
        return None
    try:
        return datetime.date.fromisoformat(suffix.strip())
    except ValueError:
        return None


def lint_changelog(text):
    """Return a list of violation strings (empty = clean)."""
    violations = []

    # Split into version sections, newest first; stop at the first release
    # dated before the restyle epoch.
    sections = []  # (heading_line, lineno, body_lines)
    current = None
    for lineno, line in enumerate(text.splitlines(), start=1):
        m = _HEADING.match(line)
        if m:
            version, suffix = m.group(1), m.group(2)
            date = _section_date(suffix)
            if version != "Unreleased" and date is not None and date < _STYLE_EPOCH:
                current = None  # grandfathered — and everything below it too
                break
            current = (line, lineno, [])
            sections.append(current)
        elif current is not None:
            current[2].append((lineno, line))

    for heading, _, body in sections:
        subsection = None  # current "### X" title, None = section preamble
        has_subsections = any(ln.startswith("### ") for _, ln in body)
        has_highlights = any(ln.strip() == "**Highlights**" for _, ln in body)
        if has_subsections and not has_highlights:
            violations.append(
                f"{heading}: entry subsections exist but no `**Highlights**` "
                f"block — quiet style opens with a short Highlights bullet "
                f"list ({_RULE})."
            )
        last_bullet = None  # (lineno, text) of the most recent bullet
        for lineno, line in body:
            if line.startswith("### "):
                subsection = line[4:].strip()
                last_bullet = None
                continue
            if not line.strip():
                continue
            if line.startswith("- "):
                last_bullet = (lineno, line)
                if len(line) > _MAX_ENTRY_CHARS:
                    violations.append(
                        f"line {lineno}: entry runs {len(line)} chars — "
                        f"one-liners only, max ~{_MAX_ENTRY_CHARS} "
                        f"({_RULE}): {line[:120]}…"
                    )
                if (
                    subsection in _REF_REQUIRED_SECTIONS
                    and not _REF_AT_END.search(line)
                    and not _CREDIT.search(line)
                    and not any(a in line for a in _REF_ALLOWLIST)
                ):
                    violations.append(
                        f"line {lineno} (### {subsection}): entry has neither "
                        f"a trailing `(#N)` ref nor a `— thanks @user!` credit "
                        f"({_RULE}; owner-authored infra lines may instead be "
                        f"added to _REF_ALLOWLIST in "
                        f"tests/test_changelog_style.py): {line}"
                    )
                continue
            # Non-blank, non-bullet, non-heading line.
            if line[0] in " \t":
                # Indented continuation — a wrapped multi-line bullet.
                if last_bullet is not None:
                    violations.append(
                        f"line {lineno}: continuation of the entry on line "
                        f"{last_bullet[0]} — entries must be a SINGLE line, "
                        f"no wrapped bullets ({_RULE}): {line.strip()[:120]}"
                    )
                    last_bullet = None  # report each wrapped bullet once
                continue
            if subsection is not None:
                # Prose paragraph inside an entry subsection — the old
                # bold-lead paragraph style.
                violations.append(
                    f"line {lineno} (### {subsection}): prose paragraph "
                    f"between entries — quiet style is one-liner bullets "
                    f"only ({_RULE}): {line[:120]}"
                )
            # Preamble prose before the first ### (release intro) is allowed.
    return violations


def test_repo_changelog_is_quiet_style():
    with open(_REPO_CHANGELOG, encoding="utf-8") as fh:
        violations = lint_changelog(fh.read())
    assert not violations, (
        "CHANGELOG.md violates the quiet release-notes style:\n  "
        + "\n  ".join(violations)
    )


# ── linter self-tests: each rule must actually fire ──────────────────────────

_GOOD = """# Changelog

## [Unreleased]

**Highlights**

- Something plain and short

### Added

- A neat feature, one line, with its ref (#123)
- Community contribution — thanks @someone! (#124)
- First-run consent question for the existing opt-in analytics (allowlisted)

### Changed

- Housekeeping line, refs not required here

### Fixed

- A bug squashed (#125, #126)

## [0.9.9] — 2026-01-01

### Added

- **Old bold-lead style.** Grandfathered: this section predates the restyle,
  wrapped lines and all. No ref, no credit, no Highlights.
"""


def test_linter_accepts_quiet_sample_and_grandfathers_old_sections():
    assert lint_changelog(_GOOD) == []


def test_linter_flags_missing_highlights():
    bad = "## [Unreleased]\n\n### Fixed\n\n- A bug (#1)\n"
    v = lint_changelog(bad)
    assert len(v) == 1 and "**Highlights**" in v[0]


def test_linter_flags_wrapped_multiline_entry():
    bad = (
        "## [Unreleased]\n\n**Highlights**\n\n- Hi\n\n### Fixed\n\n"
        "- A bug whose description carries its ref (#1)\n"
        "  but wraps onto a second indented line anyway\n"
    )
    v = lint_changelog(bad)
    assert len(v) == 1 and "SINGLE line" in v[0]


def test_linter_flags_overlong_entry():
    bad = (
        "## [Unreleased]\n\n**Highlights**\n\n- Hi\n\n### Fixed\n\n- "
        + "x" * _MAX_ENTRY_CHARS
        + " (#1)\n"
    )
    v = lint_changelog(bad)
    assert len(v) == 1 and "one-liners only" in v[0]


def test_linter_flags_paragraph_between_entries():
    bad = (
        "## [Unreleased]\n\n**Highlights**\n\n- Hi\n\n### Added\n\n"
        "- Fine entry (#1)\n\nA bold-lead paragraph explaining at length.\n"
    )
    v = lint_changelog(bad)
    assert len(v) == 1 and "prose paragraph" in v[0]


def test_linter_flags_missing_ref_only_where_required():
    bad = (
        "## [Unreleased]\n\n**Highlights**\n\n- Hi\n\n"
        "### Changed\n\n- No ref needed here\n\n"
        "### Fixed\n\n- Fixed something with no ref\n"
    )
    v = lint_changelog(bad)
    assert len(v) == 1 and "(#N)" in v[0] and "Fixed something" in v[0]


def test_linter_scopes_by_date_not_position():
    """A post-epoch release is linted; the first pre-epoch one ends the scope."""
    bad = (
        "## [1.0.1] — 2026-08-01\n\n### Fixed\n\n- New-era entry with no ref\n\n"
        "## [1.0.0] — 2026-07-01\n\n### Fixed\n\n- Old-era entry with no ref\n"
    )
    v = lint_changelog(bad)
    assert len(v) == 2  # missing Highlights + missing ref, 1.0.1 only
    assert all("New-era" in x or "Highlights" in x for x in v)
    assert not any("Old-era" in x for x in v)
