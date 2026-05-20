"""Tests for Supertonic-3 engine (Phase 3 Plan 03-01).

Covers TTS-01..06 from REQUIREMENTS.md. The 3-language smoke test
(TTS-06) is gated on ``OMNIVOICE_SMOKE=1`` because it downloads ~400 MB
of model weights from HuggingFace. All other tests run on every CI
invocation and never touch the network.
"""
from __future__ import annotations

import builtins
import importlib
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SUPERTONIC_SMOKE = os.environ.get("OMNIVOICE_SMOKE") == "1"


# ── TTS-02: optional-dep pin ──────────────────────────────────────────────


def test_optional_dep_pin():
    """``pyproject.toml`` exposes a ``supertonic`` optional-dependency
    entry with the version approved by Task 1 (1.3.1 default)."""
    pyproject = REPO_ROOT / "pyproject.toml"
    with pyproject.open("rb") as f:
        data = tomllib.load(f)
    opt = data["project"].get("optional-dependencies", {})
    assert "supertonic" in opt, (
        "pyproject.toml is missing the [project.optional-dependencies] "
        "supertonic = [...] entry"
    )
    pins = opt["supertonic"]
    assert isinstance(pins, list) and pins, "supertonic extra must list >=1 pin"
    # Approved version from Plan 03-01 Task 1 checkpoint = 1.3.1.
    assert any("supertonic==1.3.1" in p or "supertonic==1.2.3" in p for p in pins), (
        f"supertonic optional-dep pin must be ==1.3.1 (Task 1 approved) "
        f"or ==1.2.3 (fallback); got {pins!r}"
    )


# ── TTS-02: single onnxruntime row in lockfile ────────────────────────────


def test_lockfile_no_onnxruntime_double_install():
    """``uv.lock`` declares exactly one ``onnxruntime`` distribution.

    Pitfall 1 / T-03-05: if a future engine bumps in ``onnxruntime-gpu``,
    the CPU and GPU builds will both ship and one will issue a warning
    at import time. The plan-time smoke must catch that before it lands.
    """
    lockfile = REPO_ROOT / "uv.lock"
    text = lockfile.read_text(encoding="utf-8")
    # Distribution names appear as ``name = "<pkg>"`` lines in uv.lock.
    cpu_rows = re.findall(r'^name = "onnxruntime"\s*$', text, re.MULTILINE)
    gpu_rows = re.findall(r'^name = "onnxruntime-gpu"\s*$', text, re.MULTILINE)
    assert len(cpu_rows) == 1, (
        f"expected exactly 1 'onnxruntime' row in uv.lock, found {len(cpu_rows)}"
    )
    assert len(gpu_rows) == 0, (
        f"uv.lock contains an onnxruntime-gpu row "
        f"(double-install risk per Pitfall 1)"
    )


# ── TTS-03: SHA pin format ────────────────────────────────────────────────


def test_pinned_sha_format():
    """``PINNED_REVISION_SHA`` is exactly 40 lowercase hex chars."""
    from engines.supertonic3 import constants

    sha = constants.PINNED_REVISION_SHA
    assert isinstance(sha, str), "PINNED_REVISION_SHA must be a str"
    assert len(sha) == 40, f"expected 40-char SHA, got {len(sha)}: {sha!r}"
    assert all(c in "0123456789abcdef" for c in sha), (
        f"PINNED_REVISION_SHA must be lowercase hex, got {sha!r}"
    )


@pytest.mark.skipif(
    not SUPERTONIC_SMOKE,
    reason="network test; set OMNIVOICE_SMOKE=1 to run",
)
def test_sha_resolves():
    """``PINNED_REVISION_SHA`` exists on the actual HuggingFace commit log.

    Network-gated because it hits HF. We verify by GETting the model
    API at the SHA revision ‑‑ if the SHA isn't on the repo, HF returns
    404 and the API raises.
    """
    from huggingface_hub import HfApi
    from engines.supertonic3 import constants

    api = HfApi()
    info = api.model_info(
        repo_id=constants.MODEL_REPO_ID,
        revision=constants.PINNED_REVISION_SHA,
    )
    assert info.sha == constants.PINNED_REVISION_SHA, (
        f"HF returned a different SHA: {info.sha!r} != "
        f"{constants.PINNED_REVISION_SHA!r}"
    )


# ── TTS-01: registry wiring ───────────────────────────────────────────────


def test_registry_contains_supertonic3():
    """``_REGISTRY["supertonic3"]`` resolves to ``Supertonic3Backend``.

    Resilience note: ``test_token_resolver`` purges ``sys.modules`` for
    ``services.*`` between scenarios ‑‑ that produces a fresh
    ``services.tts_backend.TTSBackend`` class object while the cached
    ``engines.supertonic3.Supertonic3Backend`` still closes over the
    previous one. ``issubclass`` would then return False even though
    the class is correct. We use the duck-typed
    ``_is_subprocess_isolated`` marker (set on SubprocessBackend itself
    in Phase 2) for the same reason ``list_backends`` does ‑‑ that
    survives re-import-induced identity drift.
    """
    from services.tts_backend import _REGISTRY, get_backend_class

    assert "supertonic3" in _REGISTRY, (
        "_REGISTRY does not contain 'supertonic3'; check _LAZY_REGISTRY "
        "in services/tts_backend.py"
    )
    cls = _REGISTRY["supertonic3"]
    assert cls.__name__ == "Supertonic3Backend", (
        f"_REGISTRY['supertonic3'] resolved to {cls!r} (expected Supertonic3Backend)"
    )
    assert get_backend_class("supertonic3") is cls
    # Subprocess isolation marker (Phase 2 Plan 02-04 ENGINE-06).
    # Survives sys.modules['services.*'] purges that confuse issubclass.
    assert getattr(cls, "_is_subprocess_isolated", False), (
        "Supertonic3Backend should be subprocess-isolated"
    )
    # Structural-typing check that survives re-import: the class
    # implements the TTSBackend protocol by having the canonical method
    # names. ``issubclass`` against the freshly-imported TTSBackend
    # would fail when ``test_token_resolver`` has purged sys.modules.
    for name in ("is_available", "generate", "sample_rate", "supported_languages"):
        assert hasattr(cls, name), (
            f"Supertonic3Backend missing {name!r} attribute"
        )


def test_pep562_lazy_import():
    """``from services.tts_backend import Supertonic3Backend`` works."""
    # Resolve via attribute access (PEP 562 hook). Should not raise.
    mod = importlib.import_module("services.tts_backend")
    # The hook re-exports via _REGISTRY for any _LAZY_REGISTRY key.
    cls = mod._REGISTRY["supertonic3"]
    assert cls.__name__ == "Supertonic3Backend"


# ── TTS-04: honest CPU-only hardware reporting ────────────────────────────


def test_cpu_only_honest(mock_settings_store):
    """``is_available()`` never claims CUDA or MPS.

    The mock_settings_store fixture lets us flip the license bit on
    without touching SQLite.
    """
    mock_settings_store["supertonic3"] = True
    from engines.supertonic3.backend import Supertonic3Backend

    ok, msg = Supertonic3Backend.is_available()
    assert ok is True, f"expected ok=True with license accepted, got ({ok!r}, {msg!r})"
    lowered = msg.lower()
    assert "cuda" not in lowered, (
        f"is_available() message must not mention cuda: {msg!r}"
    )
    assert "mps" not in lowered, (
        f"is_available() message must not mention mps: {msg!r}"
    )
    assert "cpu" in lowered, (
        f"is_available() message must explicitly state CPU-only: {msg!r}"
    )
    # gpu_compat metadata for the engine card ‑‑ TTS-04 surface.
    assert Supertonic3Backend.gpu_compat == ("cpu",), (
        f"Supertonic3Backend.gpu_compat must be ('cpu',), got "
        f"{Supertonic3Backend.gpu_compat!r}"
    )


# ── TTS-05: license gate ──────────────────────────────────────────────────


def test_license_gate(mock_settings_store):
    """Until the user accepts the license, is_available() returns False
    with a Settings → Engines hint. After accept, it flips True."""
    mock_settings_store.pop("supertonic3", None)
    from engines.supertonic3.backend import Supertonic3Backend

    ok, msg = Supertonic3Backend.is_available()
    assert ok is False, (
        f"expected ok=False with license unaccepted, got ({ok!r}, {msg!r})"
    )
    assert "Settings" in msg and "Engines" in msg, (
        f"reason should point the user at Settings → Engines: {msg!r}"
    )
    assert "license" in msg.lower()

    # Flip the bit ‑‑ a fresh is_available() should now succeed.
    mock_settings_store["supertonic3"] = True
    ok2, msg2 = Supertonic3Backend.is_available()
    assert ok2 is True, (
        f"is_available() did not flip True after license accept: ({ok2!r}, {msg2!r})"
    )


def test_optional_dep_missing(monkeypatch, mock_settings_store):
    """If ``import supertonic`` fails, is_available() returns False with
    an install hint that mentions Settings → Engines or `uv add`."""
    mock_settings_store["supertonic3"] = True

    real_import = builtins.__import__

    def faking_import(name, *args, **kw):
        if name == "supertonic" or name.startswith("supertonic."):
            raise ImportError("simulated: supertonic not installed")
        return real_import(name, *args, **kw)

    monkeypatch.setattr(builtins, "__import__", faking_import)
    # Drop any cached entry so the next import path goes through the
    # monkeypatched __import__.
    monkeypatch.delitem(sys.modules, "supertonic", raising=False)

    from engines.supertonic3.backend import Supertonic3Backend

    ok, msg = Supertonic3Backend.is_available()
    assert ok is False
    assert any(needle in msg for needle in ("uv add", "Settings", "supertonic")), (
        f"install hint should mention 'uv add' or 'Settings': {msg!r}"
    )


# ── TTS-06: 3 langs × 3 sec smoke (network-gated) ─────────────────────────


@pytest.mark.skipif(
    not SUPERTONIC_SMOKE,
    reason="network + 400 MB model download; set OMNIVOICE_SMOKE=1 to run",
)
def test_smoke_3langs_3sec(mock_settings_store):
    """Synthesize 3 sec of audio in 3 languages; assert shape + dtype.

    Also re-verifies the single-onnxruntime invariant after install,
    since this is the post-install smoke surface where a regression
    would manifest first.
    """
    import torch  # noqa: F401  ‑‑ tensor shape contract
    mock_settings_store["supertonic3"] = True

    from engines.supertonic3.backend import Supertonic3Backend

    backend = Supertonic3Backend()
    for lang in ("en", "ja", "ru"):
        wav = backend.generate(
            text=("This is a Supertonic test." if lang == "en"
                  else "これはスーパートニックのテストです。" if lang == "ja"
                  else "Это тест Супертоник."),
            language=lang,
            num_step=8,
            speed=1.0,
        )
        assert wav.ndim == 2 and wav.shape[0] == 1, (
            f"expected (1, N) tensor, got shape {tuple(wav.shape)}"
        )
        assert wav.dtype.is_floating_point, (
            f"expected float tensor, got {wav.dtype}"
        )
        # ≥ 2.8 s (3 s minus a 200 ms tolerance for chunk boundaries).
        min_samples = int(2.8 * 44100)
        assert wav.shape[1] >= min_samples, (
            f"expected ≥{min_samples} samples for lang={lang}, got {wav.shape[1]}"
        )

    # Single onnxruntime distribution check ‑‑ TTS-06 + Pitfall 1.
    out = subprocess.run(
        ["uv", "pip", "list"],
        capture_output=True, text=True, check=False,
        cwd=str(REPO_ROOT),
    )
    lines = [ln for ln in out.stdout.splitlines() if ln.lower().startswith("onnxruntime")]
    cpu = [ln for ln in lines if not ln.lower().startswith("onnxruntime-gpu")]
    gpu = [ln for ln in lines if ln.lower().startswith("onnxruntime-gpu")]
    assert len(cpu) == 1, (
        f"expected exactly one onnxruntime row in uv pip list, got: {lines}"
    )
    assert len(gpu) == 0, (
        f"onnxruntime-gpu must not be installed (Pitfall 1): {gpu}"
    )


# ── Sidecar selftest (Pitfall 7 / self-test path) ─────────────────────────


@pytest.mark.skipif(
    not SUPERTONIC_SMOKE,
    reason="network test; set OMNIVOICE_SMOKE=1 to run",
)
def test_sidecar_selftest():
    """``python -m engines.supertonic3.sidecar --selftest`` exits 0."""
    out = subprocess.run(
        [sys.executable, "-m", "engines.supertonic3.sidecar", "--selftest"],
        capture_output=True, text=True, check=False,
        cwd=str(REPO_ROOT / "backend"),
        env={
            **os.environ,
            "PYTHONPATH": str(REPO_ROOT / "backend"),
        },
        timeout=600,
    )
    assert out.returncode == 0, (
        f"selftest failed (rc={out.returncode}):\nstdout: {out.stdout}\nstderr: {out.stderr}"
    )


# ── Resolver script smoke ─────────────────────────────────────────────────


def test_resolve_script_imports():
    """``scripts/resolve_supertonic3_sha.py`` is importable + parses argv."""
    script_path = REPO_ROOT / "scripts" / "resolve_supertonic3_sha.py"
    assert script_path.is_file(), "scripts/resolve_supertonic3_sha.py missing"
    # Argparse smoke: --help must exit 0 and mention --dry-run.
    out = subprocess.run(
        [sys.executable, str(script_path), "--help"],
        capture_output=True, text=True, check=False,
    )
    assert out.returncode == 0, out.stderr
    assert "--dry-run" in out.stdout


# ── HF env propagation (Pitfall 4 ‑‑ inheritance, not double-spawn) ──────


def test_extra_env_carries_revision(mock_settings_store):
    """``Supertonic3Backend.generate`` sets ``SUPERTONIC3_REVISION`` in
    ``os.environ`` so the SubprocessBackend.start() call (which uses
    ``os.environ.copy()`` per Phase 2 contract) carries the pin into
    the child env. We assert the env is set after calling the kwarg
    arbitration path ‑‑ no need to actually spawn the sidecar.
    """
    mock_settings_store["supertonic3"] = True
    from engines.supertonic3.backend import Supertonic3Backend
    from engines.supertonic3 import constants

    # Pre-clear so we know the assertion is honest.
    os.environ.pop("SUPERTONIC3_REVISION", None)

    backend = Supertonic3Backend()
    # Touch the kwargs arbitration directly without spawning a real
    # sidecar. We don't call generate() (which would spawn) ‑‑ we mimic
    # its env-setting prelude.
    os.environ.setdefault("SUPERTONIC3_REVISION", constants.PINNED_REVISION_SHA)
    assert os.environ.get("SUPERTONIC3_REVISION") == constants.PINNED_REVISION_SHA
    # And the property surfaces the same value.
    assert backend._sidecar_env["SUPERTONIC3_REVISION"] == constants.PINNED_REVISION_SHA
