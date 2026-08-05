"""#1348 — a source-built GGUF runtime must actually run.

Two independent failures from the same report (LXC Debian, CPU-only,
built from source):

1. ``scripts/build-omnivoice-tts.sh`` copied only the executable out of the
   temp build tree; a dynamically-linked build (buildcpu.sh, or cmake with
   BLAS present) left its ``libggml*`` shared libraries behind for the EXIT
   trap to delete, so the shipped binary died on first spawn with exit 127
   — "libggml.so.0: cannot open shared object file".
2. ``_GENERATE_TIMEOUT_S`` was hardcoded to 120s, which reaped legitimate
   CPU-only generates mid-synthesis with no way to raise it.
"""

import ast
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

from engines.omnivoice_gguf import backend as gguf  # noqa: E402


# ── the per-spawn timeout is env-tunable and CPU-realistic ──────────────────


def test_default_timeout_exceeds_the_pool_generate_budget(monkeypatch):
    # The pool guard (OMNIVOICE_GENERATE_TIMEOUT_S, 300s floor) must be the
    # deadline users actually hit — it classifies and explains. The inner
    # subprocess timeout only reaps a wedged C++ process, so it must sit
    # strictly above the pool floor or it fires first with a worse error.
    monkeypatch.delenv("OMNIVOICE_GGUF_GENERATE_TIMEOUT_S", raising=False)
    assert gguf._generate_timeout_s() > 300.0


def test_env_override_is_read_at_call_time(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_GGUF_GENERATE_TIMEOUT_S", "45.5")
    assert gguf._generate_timeout_s() == 45.5


def test_bad_env_values_fall_back_to_the_default(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_GGUF_GENERATE_TIMEOUT_S", "unlimited")
    assert gguf._generate_timeout_s() == 600.0
    monkeypatch.setenv("OMNIVOICE_GGUF_GENERATE_TIMEOUT_S", "0")
    assert gguf._generate_timeout_s() == 1.0  # floored, never instant-kill


def test_timeout_error_names_the_env_knob():
    # The user in #1348 had to read the source to find the constant; the
    # error itself must carry the escape hatch now.
    src = (REPO / "backend/engines/omnivoice_gguf/backend.py").read_text()
    timed_out = src[src.index("timed out after") :]
    assert "OMNIVOICE_GGUF_GENERATE_TIMEOUT_S" in timed_out[:300]


# ── spawns carry a loader path that can see bin/'s shared libs ──────────────


def test_spawn_env_puts_bin_on_the_loader_path(monkeypatch):
    monkeypatch.setenv("LD_LIBRARY_PATH", "/opt/elsewhere")
    monkeypatch.delenv("DYLD_FALLBACK_LIBRARY_PATH", raising=False)
    env = gguf._spawn_env()
    bin_dir = str(gguf._binary_path().parent)
    # Prepended, with the pre-existing path preserved after it.
    assert env["LD_LIBRARY_PATH"] == bin_dir + os.pathsep + "/opt/elsewhere"
    assert env["DYLD_FALLBACK_LIBRARY_PATH"] == bin_dir


def test_every_spawn_of_the_engine_binary_passes_the_loader_env():
    # Class rule: any subprocess.run that execs the GGUF binary must pass
    # env=_spawn_env(), or a dynamically-linked build fails exit 127 from
    # that call site. (The /usr/bin/xattr quarantine probe is the one
    # legitimate literal-argv exception.)
    src = (REPO / "backend/engines/omnivoice_gguf/backend.py").read_text()
    tree = ast.parse(src)
    spawns = 0
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "run"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "subprocess"
        ):
            continue
        first = node.args[0] if node.args else None
        if (
            isinstance(first, ast.List)
            and first.elts
            and isinstance(first.elts[0], ast.Constant)
        ):
            continue  # literal argv (xattr probe) — not the engine binary
        spawns += 1
        kw = {k.arg for k in node.keywords}
        assert "env" in kw, (
            f"subprocess.run at line {node.lineno} spawns the engine binary "
            f"without env=_spawn_env() — a dynamically-linked source build "
            f"dies with exit 127 there (#1348)"
        )
    assert spawns >= 2  # probe_load --help + _run_subprocess


# ── the build script ships the shared libs it links against ─────────────────


def test_build_script_copies_shared_libs_on_every_platform_branch():
    script = (REPO / "scripts/build-omnivoice-tts.sh").read_text()
    assert "copy_shared_libs()" in script
    # Every copy of the executable is followed by the shared-lib copy —
    # the bug lived in ALL platform branches, not just Linux.
    binary_cps = re.findall(r'cp -v build/(?:Release/)?omnivoice-tts(?:\.exe)? "\$BIN_DIR', script)
    calls = script.count("copy_shared_libs\n")
    assert len(binary_cps) == 4
    assert calls == len(binary_cps), (
        "every platform branch that copies the binary must also call "
        "copy_shared_libs — otherwise that platform's dynamic build "
        "ships broken (#1348)"
    )
    # The finder must cover all three platforms' shared-lib extensions.
    for pattern in ("libggml*.so*", "libggml*.dylib", "ggml*.dll"):
        assert pattern in script
