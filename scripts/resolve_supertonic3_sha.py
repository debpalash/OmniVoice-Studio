"""Resolve the latest model SHA for Supertone/supertonic-3.

Used during release-prep to bump :data:`PINNED_REVISION_SHA` in
``backend/engines/supertonic3/constants.py``. The bump is *intentional*
‑‑ TTS-03 forbids ``revision="main"``. The release engineer runs this
script, verifies the diff between the proposed and current SHAs touches
ONNX weights or tokenizer (not just README polish), and commits the
constant update.

Usage::

    # Print the candidate SHA without touching anything:
    uv run python scripts/resolve_supertonic3_sha.py --dry-run

    # Write the candidate SHA into constants.py (only if it differs):
    uv run python scripts/resolve_supertonic3_sha.py

    # Pass --no-filter to skip the "tree must contain .onnx / tokenizer"
    # heuristic — useful when the upstream layout changes and we want to
    # pin to whatever main currently is:
    uv run python scripts/resolve_supertonic3_sha.py --no-filter

The script picks the most recent commit on ``main`` whose tree contains
at least one ``.onnx`` file or a ``tokenizer.json``. That filters out
non-code commits (README polish, audio-sample additions) which don't
affect inference behaviour. If no commit in the recent window matches,
the latest commit is returned with a warning.

Exit codes:
    0 ‑‑ SHA resolved (and printed; written if no --dry-run and the
         current value differs)
    1 ‑‑ HF API call failed or no candidate found
    2 ‑‑ ``--dry-run`` returned an SHA but it equals the current pin
         (informational; not a failure)
"""
from __future__ import annotations

import argparse
import logging
import re
import sys
from pathlib import Path
from typing import Iterable, Optional

REPO_ID = "Supertone/supertonic-3"
CONSTANTS_PATH = (
    Path(__file__).resolve().parents[1]
    / "backend" / "engines" / "supertonic3" / "constants.py"
)

# Match the PINNED_REVISION_SHA line in constants.py for in-place edits.
_SHA_LINE_RE = re.compile(
    r'^(PINNED_REVISION_SHA\s*:\s*str\s*=\s*)"([0-9a-f]{40})"',
    re.MULTILINE,
)


def _read_current_sha() -> Optional[str]:
    """Parse the current PINNED_REVISION_SHA from constants.py."""
    if not CONSTANTS_PATH.is_file():
        return None
    text = CONSTANTS_PATH.read_text(encoding="utf-8")
    m = _SHA_LINE_RE.search(text)
    return m.group(2) if m else None


def _commit_touches_inference(api, commit_oid: str) -> bool:
    """Heuristic: does this commit's tree contain ONNX weights / tokenizer?

    A commit that only adds a README or sample audio doesn't change
    inference behaviour. We accept any tree under the commit that has at
    least one ``.onnx`` file or a ``tokenizer.json``. This is a cheap
    filter ‑‑ ``list_repo_tree`` over the recursive root is one API call.
    """
    try:
        tree = api.list_repo_tree(
            repo_id=REPO_ID,
            revision=commit_oid,
            recursive=True,
        )
    except Exception as exc:
        logging.debug("list_repo_tree(%s) failed: %s", commit_oid[:12], exc)
        return False
    for entry in tree:
        path = getattr(entry, "path", "")
        if path.endswith(".onnx") or path.endswith("tokenizer.json"):
            return True
    return False


def _iter_main_commits(api) -> Iterable[object]:
    """Yield commits on ``main`` newest-first.

    ``HfApi.list_repo_commits`` returns an iterator/list of ``GitCommit``
    objects with at minimum ``.commit_id`` and ``.title``; we only need
    the SHA.
    """
    return api.list_repo_commits(
        repo_id=REPO_ID,
        revision="main",
    )


def resolve(
    *,
    filter_inference: bool = True,
    max_commits: int = 25,
) -> Optional[str]:
    """Return the candidate SHA, or ``None`` if no commit matches.

    Walks up to ``max_commits`` commits newest-first. The first commit
    whose tree contains ONNX / tokenizer is returned. If
    ``filter_inference=False``, the first commit is returned without
    filtering.
    """
    try:
        from huggingface_hub import HfApi  # type: ignore[import-not-found]
    except ImportError as exc:
        print(
            f"error: huggingface_hub not installed: {exc}",
            file=sys.stderr,
        )
        return None

    api = HfApi()
    try:
        commits = list(_iter_main_commits(api))
    except Exception as exc:
        print(
            f"error: list_repo_commits failed: {exc}",
            file=sys.stderr,
        )
        return None

    if not commits:
        print("error: no commits returned from list_repo_commits", file=sys.stderr)
        return None

    # Different huggingface_hub releases expose either .commit_id or .oid.
    def _sha(c) -> str:
        return getattr(c, "commit_id", None) or getattr(c, "oid", "")

    if not filter_inference:
        return _sha(commits[0])

    for commit in commits[:max_commits]:
        oid = _sha(commit)
        if not oid:
            continue
        if _commit_touches_inference(api, oid):
            return oid

    # Fallback: nothing in the recent window matches; return the newest
    # SHA with a warning so the human still gets a usable value.
    fallback = _sha(commits[0])
    print(
        f"warning: no commit in the last {max_commits} touched .onnx / "
        f"tokenizer.json — falling back to {fallback[:12]} (newest on main)",
        file=sys.stderr,
    )
    return fallback


def _rewrite_constants(new_sha: str) -> None:
    """In-place edit of PINNED_REVISION_SHA. Preserves surrounding text."""
    text = CONSTANTS_PATH.read_text(encoding="utf-8")
    new_text, count = _SHA_LINE_RE.subn(
        lambda m: f'{m.group(1)}"{new_sha}"',
        text,
        count=1,
    )
    if count != 1:
        raise RuntimeError(
            f"failed to locate PINNED_REVISION_SHA line in {CONSTANTS_PATH}"
        )
    CONSTANTS_PATH.write_text(new_text, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the candidate SHA but do not modify constants.py",
    )
    parser.add_argument(
        "--no-filter", action="store_true",
        help="Skip the .onnx/tokenizer filter; use the newest commit on main",
    )
    parser.add_argument(
        "--max-commits", type=int, default=25,
        help="How many recent commits to scan when filtering (default: 25)",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true",
        help="Enable debug logging",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
    )

    candidate = resolve(
        filter_inference=not args.no_filter,
        max_commits=args.max_commits,
    )
    if not candidate:
        return 1

    if len(candidate) != 40 or not all(c in "0123456789abcdef" for c in candidate.lower()):
        print(
            f"error: resolved value {candidate!r} is not a 40-char SHA",
            file=sys.stderr,
        )
        return 1

    candidate = candidate.lower()
    current = _read_current_sha()
    print(candidate)

    if args.dry_run:
        if current == candidate:
            print(
                f"info: current PINNED_REVISION_SHA already matches "
                f"(no change needed)",
                file=sys.stderr,
            )
            return 2
        print(
            f"info: would update PINNED_REVISION_SHA "
            f"({current[:12] if current else 'unset'} -> {candidate[:12]})",
            file=sys.stderr,
        )
        return 0

    if current == candidate:
        print(
            f"info: PINNED_REVISION_SHA already at {candidate[:12]}, "
            f"nothing to do",
            file=sys.stderr,
        )
        return 0

    _rewrite_constants(candidate)
    print(
        f"info: updated {CONSTANTS_PATH.relative_to(CONSTANTS_PATH.parents[3])} "
        f"({current[:12] if current else 'unset'} -> {candidate[:12]})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
