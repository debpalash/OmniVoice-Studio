"""Guard against dead code in backend/services/.

Every module under backend/services/ must be referenced (imported or named)
by at least one other Python file in the repo — a router, another service,
core, scripts, or a test. An unreferenced service module is dead code that
confuses contributors and rots silently (see PR removing services/batched_tts,
an April-2026 throughput experiment that shipped with zero call sites and sat
unreachable for months).

If a module is intentionally unreferenced (e.g. a documented extension point
loaded only by third-party plugins), add it to _INTENTIONALLY_UNREFERENCED
with a justification instead of deleting it.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVICES_DIR = REPO_ROOT / "backend" / "services"

# Directories whose *.py files count as legitimate referencers.
_SEARCH_ROOTS = ("backend", "tests", "scripts")

# module name -> justification for existing with no in-repo referencer.
_INTENTIONALLY_UNREFERENCED: dict[str, str] = {}


def _py_files() -> list[Path]:
    files: list[Path] = []
    for root in _SEARCH_ROOTS:
        base = REPO_ROOT / root
        if base.is_dir():
            files.extend(base.rglob("*.py"))
    return files


def _reference_pattern(mod: str) -> re.Pattern[str]:
    """Match any plausible reference to services.<mod>.

    Covers `from services.<mod> import ...`, `import services.<mod>`,
    attribute/string references like `services.<mod>` (including dynamic
    importlib strings, which appear verbatim in source), relative imports
    within the package (`from .<mod> import ...`), and
    `from services import ..., <mod>, ...`.
    """
    escaped = re.escape(mod)
    return re.compile(
        rf"(?:\bservices\.{escaped}\b"
        rf"|from\s+\.\s*{escaped}\s+import"
        rf"|from\s+(?:backend\.)?services\s+import\s[^\n]*\b{escaped}\b)"
    )


def test_every_services_module_is_referenced_somewhere():
    assert SERVICES_DIR.is_dir(), f"missing {SERVICES_DIR}"

    corpus = [
        (path, path.read_text(encoding="utf-8", errors="ignore"))
        for path in _py_files()
    ]

    orphans: list[str] = []
    for mod_file in sorted(SERVICES_DIR.glob("*.py")):
        mod = mod_file.stem
        if mod == "__init__" or mod in _INTENTIONALLY_UNREFERENCED:
            continue
        pattern = _reference_pattern(mod)
        if not any(
            path != mod_file and pattern.search(text) for path, text in corpus
        ):
            orphans.append(mod)

    assert not orphans, (
        "Dead code: backend/services module(s) with no referencer anywhere in "
        f"{_SEARCH_ROOTS}: {orphans}. Either wire the module into a caller, "
        "delete it, or add it to _INTENTIONALLY_UNREFERENCED in "
        f"{Path(__file__).name} with a justification."
    )


def test_intentionally_unreferenced_allowlist_is_not_stale():
    """Every allowlisted module must still exist, and must actually be
    unreferenced — an allowlist entry for a module that gained a caller (or
    was deleted) is stale and must be removed."""
    corpus = None
    for mod, why in _INTENTIONALLY_UNREFERENCED.items():
        assert why.strip(), f"empty justification for allowlisted module {mod!r}"
        mod_file = SERVICES_DIR / f"{mod}.py"
        assert mod_file.is_file(), (
            f"allowlisted services module {mod!r} no longer exists — remove it "
            "from _INTENTIONALLY_UNREFERENCED"
        )
        if corpus is None:
            corpus = [
                (path, path.read_text(encoding="utf-8", errors="ignore"))
                for path in _py_files()
            ]
        pattern = _reference_pattern(mod)
        if any(path != mod_file and pattern.search(text) for path, text in corpus):
            raise AssertionError(
                f"allowlisted services module {mod!r} is now referenced — "
                "remove its _INTENTIONALLY_UNREFERENCED entry"
            )
