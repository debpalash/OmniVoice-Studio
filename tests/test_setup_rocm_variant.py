"""Source installs must honour `OMNIVOICE_TORCH_VARIANT=rocm` (#1665).

`uv sync` always restores the lockfile's CUDA torch build, which is CPU-only
on AMD cards, and `uv run` re-syncs before every launch — so a hand-swapped
ROCm wheel was silently reverted by the next `bun run desktop`. The packaged
app's bootstrap (`bootstrap.rs`) already performs the swap on opt-in; these
tests pin the dev-flow equivalents: `scripts/setup.py` reinstalls the ROCm
wheel after the sync, and `scripts/dev-backend.mjs` launches with
`uv run --no-sync` so it sticks.
"""
import importlib.util
import os
import re
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SETUP = os.path.join(_ROOT, "scripts", "setup.py")
_DEV_BACKEND = os.path.join(_ROOT, "scripts", "dev-backend.mjs")
_BOOTSTRAP = os.path.join(_ROOT, "frontend", "src-tauri", "src", "bootstrap.rs")


def _load_setup():
    spec = importlib.util.spec_from_file_location("vs_setup", _SETUP)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_rocm_opt_in_requires_explicit_variant():
    setup = _load_setup()
    assert setup._rocm_opt_in({}) is None
    assert setup._rocm_opt_in({"OMNIVOICE_TORCH_VARIANT": "auto"}) is None
    assert setup._rocm_opt_in({"OMNIVOICE_TORCH_VARIANT": "ROCm"}) == setup.ROCM_TORCH_INDEX
    assert (
        setup._rocm_opt_in({"OMNIVOICE_TORCH_VARIANT": "rocm", "OMNIVOICE_TORCH_INDEX": "https://x/"})
        == "https://x/"
    )


def test_rocm_reinstall_targets_this_venv_with_bootstrap_pins():
    setup = _load_setup()
    cmd = setup.rocm_torch_reinstall_cmd("https://idx/", python="/venv/bin/python")
    assert cmd[:4] == ["uv", "pip", "install", "--reinstall"]
    assert cmd[cmd.index("--python") + 1] == "/venv/bin/python"
    assert cmd[-2:] == ["--index-url", "https://idx/"]
    # Same pins + default index as the packaged app's bootstrap.
    rs = open(_BOOTSTRAP, encoding="utf-8").read()
    for pin in setup.ROCM_TORCH_PINS:
        assert f'"{pin}"' in rs, f"{pin} drifted from bootstrap.rs"
    assert f'"{setup.ROCM_TORCH_INDEX}"' in rs


def test_dev_backend_skips_resync_when_rocm_requested():
    src = open(_DEV_BACKEND, encoding="utf-8").read()
    fn = re.search(r"export function uvRunArgs[\s\S]*?\n}", src)
    assert fn, "dev-backend.mjs must export uvRunArgs()"
    assert "OMNIVOICE_TORCH_VARIANT" in fn.group(0)
    assert '"--no-sync"' in fn.group(0)
    assert "spawn(\"uv\", uvRunArgs()" in src
