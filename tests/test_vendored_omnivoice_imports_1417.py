"""Every symbol the backend imports from the vendored `omnivoice` package
must actually exist there.

#1417: the VoiceStudio rename (5cab8e01) rewrote
`from omnivoice.models.omnivoice import OmniVoice` to `... import VoiceStudio`,
but the class in that module is still `OmniVoice` — the rename changed the
import and never touched the definition. The result shipped in v0.4.2:

  ImportError: cannot import name 'VoiceStudio' from 'omnivoice.models.omnivoice'

Preload swallowed it as "non-fatal", so the app ran with dead TTS and no
visible error; `/generate` retried until "Model load exceeded 1200.0s".

`omnivoice` is the upstream k2-fsa model package, deliberately NOT renamed
(CLAUDE.md keeps the engine/model name while the product became VoiceStudio),
so the import was wrong at the source rather than the class being misnamed.

This checks the relationship statically — an AST scan, no torch/transformers
import — so it is fast, runs everywhere, and catches the whole class of
"a sweep renamed one side of an import" rather than this one symbol.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]
_BACKEND = _REPO / "backend"
_PKG_ROOT = _REPO / "omnivoice"


def _module_file(dotted: str) -> Path | None:
    """Map `omnivoice.models.omnivoice` to its file in the vendored package."""
    if not dotted.startswith("omnivoice"):
        return None
    parts = dotted.split(".")[1:]  # drop the package name itself
    base = _PKG_ROOT.joinpath(*parts)
    for candidate in (base.with_suffix(".py"), base / "__init__.py"):
        if candidate.is_file():
            return candidate
    return None


def _defined_names(path: Path) -> set[str]:
    """Top-level names a module binds: classes, functions, assignments, and
    whatever it re-exports via its own imports."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    names.add(target.id)
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name):
                names.add(node.target.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.Try):
            # Guarded imports/definitions (the vendored package uses these for
            # optional deps) still bind their names.
            for sub in list(node.body) + [h for hs in node.handlers for h in hs.body]:
                if isinstance(sub, (ast.Import, ast.ImportFrom)):
                    for alias in sub.names:
                        names.add(alias.asname or alias.name.split(".")[0])
                elif isinstance(sub, ast.Assign):
                    for target in sub.targets:
                        if isinstance(target, ast.Name):
                            names.add(target.id)
                elif isinstance(sub, ast.ClassDef):
                    names.add(sub.name)
    return names


def _backend_imports_from_omnivoice() -> list[tuple[Path, int, str, str]]:
    """(file, lineno, module, symbol) for every `from omnivoice… import X`."""
    found: list[tuple[Path, int, str, str]] = []
    for py in _BACKEND.rglob("*.py"):
        try:
            tree = ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
        except SyntaxError:  # pragma: no cover - not our file to fix
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                if node.module == "omnivoice" or node.module.startswith("omnivoice."):
                    for alias in node.names:
                        if alias.name != "*":
                            found.append((py, node.lineno, node.module, alias.name))
    return found


def test_the_backend_imports_at_least_one_symbol_from_the_package() -> None:
    """Guards the guard: if the scan silently found nothing, the test below
    would pass while checking absolutely nothing."""
    assert _backend_imports_from_omnivoice(), (
        "No `from omnivoice… import …` found under backend/. Either the layout "
        "moved or this scan is broken — it cannot protect anything as-is."
    )


@pytest.mark.parametrize(
    "py,lineno,module,symbol",
    _backend_imports_from_omnivoice(),
    ids=lambda v: v.name if isinstance(v, Path) else str(v),
)
def test_imported_symbol_exists_in_the_vendored_package(
    py: Path, lineno: int, module: str, symbol: str
) -> None:
    target = _module_file(module)
    if target is None:
        pytest.skip(f"{module} is not a file in the vendored package tree")
    # `from omnivoice.utils import voice_design` imports a SUBMODULE, which is
    # valid without the parent package binding the name — so resolving to a
    # file on disk counts as defined.
    if _module_file(f"{module}.{symbol}") is not None:
        return
    defined = _defined_names(target)
    assert symbol in defined, (
        f"{py.relative_to(_REPO)}:{lineno} imports '{symbol}' from '{module}', "
        f"but {target.relative_to(_REPO)} does not define it.\n"
        f"This is #1417: a rename changed one side of the import only. The "
        f"backend swallows the resulting ImportError as a non-fatal preload "
        f"failure, so it ships as silently dead TTS rather than a crash."
    )
