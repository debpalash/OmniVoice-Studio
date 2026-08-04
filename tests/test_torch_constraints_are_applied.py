"""The torch trio must stay coupled on the `uv pip install` paths (#1357).

`pyproject.toml` declares `torch>=2.4`, `torchaudio>=2.4`, `torchvision>=0.19`
independently, because no PEP 508 syntax expresses "these three move together".
The coupling lives in `[tool.uv] constraint-dependencies`.

That setting is part of the **project** API — `uv sync`, `uv lock`, `uv run`.
`uv pip install` is the pip-compatible interface and ignores it. Both install
paths that use `uv pip install --system` (the Colab notebook and the Docker
image) therefore resolved the trio on its bare lower bounds, free to upgrade
torch while leaving a torchvision built against an older ABI in place:

    RuntimeError: operator torchvision::nms does not exist

That is #1357, reported on Colab, where the stale torchvision sat in the
preinstalled `/usr/local/lib/python3.12/dist-packages/`.

Verified directly rather than assumed: with the pin present only in
`constraint-dependencies`, `uv pip install --dry-run .` into a clean
environment resolves torchvision **0.28.0**, not the pinned 0.23.0.

So the pin is passed explicitly via `--constraint`, and these tests fail if the
file drifts from pyproject, if either call site stops passing it, or if the
Docker guard stops covering torchvision.
"""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
_CONSTRAINTS = _ROOT / "deploy" / "torch-constraints.txt"
_DOCKERFILE = _ROOT / "deploy" / "Dockerfile"
_NOTEBOOK = _ROOT / "notebooks" / "OmniVoice_Studio_Colab.ipynb"

_PACKAGES = ("torch", "torchaudio", "torchvision")


def _pins(text: str) -> dict:
    """`{name: version}` for every `name==version` line, comments stripped."""
    out = {}
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        m = re.fullmatch(r"([A-Za-z0-9_.\-]+)==([^\s;]+)", line)
        if m:
            out[m.group(1).lower()] = m.group(2)
    return out


@pytest.fixture(scope="module")
def project_constraints() -> dict:
    data = tomllib.loads((_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return _pins("\n".join(data["tool"]["uv"]["constraint-dependencies"]))


@pytest.fixture(scope="module")
def file_constraints() -> dict:
    return _pins(_CONSTRAINTS.read_text(encoding="utf-8"))


def test_the_constraints_file_exists(file_constraints):
    assert file_constraints, f"{_CONSTRAINTS} has no pins"


@pytest.mark.parametrize("pkg", _PACKAGES)
def test_every_member_of_the_trio_is_pinned(pkg, file_constraints):
    """A trio with one member unpinned is the bug: the unpinned one is exactly
    the one free to drift out of ABI compatibility with the other two."""
    assert pkg in file_constraints, f"{pkg} missing from {_CONSTRAINTS.name}"


def test_the_file_matches_pyproject(project_constraints, file_constraints):
    """Two sources of truth that disagree would ship `uv sync` users one torch
    and Docker/Colab users another, with no error anywhere."""
    for pkg in _PACKAGES:
        assert file_constraints.get(pkg) == project_constraints.get(pkg), (
            f"{pkg} drifted: {_CONSTRAINTS.name} says {file_constraints.get(pkg)}, "
            f"pyproject [tool.uv] constraint-dependencies says "
            f"{project_constraints.get(pkg)}"
        )


def test_the_pins_carry_no_local_version(file_constraints):
    """`==2.8.0+cu128` would match only the CUDA build and force a reinstall on
    the ROCm image and on Colab. Bare `==2.8.0` matches every local segment
    (PEP 440), which is what lets one file serve all three."""
    for pkg in _PACKAGES:
        assert "+" not in file_constraints[pkg], (
            f"{pkg} pins a local version ({file_constraints[pkg]}), which would "
            f"clobber the vendor-built wheel it is supposed to preserve"
        )


# ── the call sites ────────────────────────────────────────────────────────

def test_the_dockerfile_passes_the_constraint():
    text = _DOCKERFILE.read_text(encoding="utf-8")
    install = [ln for ln in text.splitlines() if "uv pip install" in ln and "--system" in ln]
    assert install, "no `uv pip install --system` line found in the Dockerfile"
    for line in install:
        assert "--constraint" in line and "torch-constraints.txt" in line, (
            f"Docker installs without the torch constraint, so the trio can "
            f"drift again:\n  {line.strip()}"
        )


def test_the_dockerfile_copies_the_constraints_file():
    """A --constraint pointing at a path the build context never copied fails
    the build, but only once someone rebuilds — pin it here instead."""
    text = _DOCKERFILE.read_text(encoding="utf-8")
    assert re.search(r"^COPY .*torch-constraints\.txt", text, re.MULTILINE), (
        "Dockerfile references the constraints file but never COPYs it"
    )


def test_the_docker_guard_covers_torchvision():
    """The pre-existing guard asserted on torch and torchaudio only — omitting
    the one package that actually broke in #1357."""
    text = _DOCKERFILE.read_text(encoding="utf-8")
    guard = [ln for ln in text.splitlines() if "torch.version.hip" in ln or "torchvision.ops" in ln]
    assert guard, "the GPU-flavour guard is gone"
    assert "torchvision.ops" in text, (
        "the guard does not exercise torchvision's C++ ops, so an ABI mismatch "
        "would still ship and surface at runtime as torchvision::nms"
    )


def test_the_colab_notebook_passes_the_constraint():
    nb = json.loads(_NOTEBOOK.read_text(encoding="utf-8"))
    installs = [
        "".join(c["source"]) for c in nb["cells"]
        if c["cell_type"] == "code" and '"uv", "pip", "install"' in "".join(c["source"])
    ]
    assert installs, "no uv pip install cell found in the Colab notebook"
    for src in installs:
        assert "torch-constraints.txt" in src, (
            "the Colab install cell resolves the torch trio unconstrained — the "
            "exact path #1357 was reported on"
        )


def test_the_notebook_is_still_valid_json_and_has_its_cells():
    """The install cell is edited programmatically; a malformed notebook fails
    for the user at open time, not here, unless this looks."""
    nb = json.loads(_NOTEBOOK.read_text(encoding="utf-8"))
    assert nb["cells"], "notebook has no cells"
    for c in nb["cells"]:
        assert c["cell_type"] in ("code", "markdown")
        assert isinstance(c["source"], list)
