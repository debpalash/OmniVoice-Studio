"""IndexTTS 2.5 install + long-text synthesis (#1611).

Two independent defects, both reported against a working upstream install:

1. **Install always failed.** ``IndexTeam/IndexTTS-2.5`` ships ``config.yaml``
   — at the pinned revision and at HEAD; ``config_v2_5.yaml`` exists in no
   upstream revision. VoiceStudio demanded that name, so ``_weights_floor_ok``
   never found it and the install died claiming "the download was likely
   interrupted" when the download had been perfect. The only way through was
   to hand-rename the file, which is what the reporter did.

2. **Long text was killed at 60s.** ``infer()`` is one blocking upstream call
   that says nothing on the wire, and IndexTTS was the only sidecar still on
   the 60s ``recv_timeout_s`` class default. Raising that default alone does
   NOT fix it (the reporter tried 3600): frames are also what report activity
   to the GPU pool's execution clock, so a silent sidecar still trips the
   outer generate budget. The sidecar has to heartbeat.

Installs created with the hand-renamed config must keep working untouched —
existing-engine compatibility is a hard rule.
"""
from __future__ import annotations

import importlib
import io
import struct

import pytest


@pytest.fixture
def si():
    return importlib.import_module("services.sidecar_install")


@pytest.fixture
def sidecar():
    """The IndexTTS sidecar script, loaded as a module by path.

    It lives under backend/engines/, is executed as a script inside the
    engine's own venv, and imports indextts lazily — so importing it here
    costs nothing and needs none of that venv.
    """
    import pathlib
    import sys

    path = pathlib.Path(__file__).resolve().parents[1] / "backend" / "engines" / "indextts" / "main.py"
    spec = importlib.util.spec_from_file_location("_indextts_sidecar_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


# ── 1. the config filename ────────────────────────────────────────────────

def test_the_spec_accepts_the_name_upstream_actually_ships(si):
    """config.yaml is what IndexTeam/IndexTTS-2.5 contains."""
    spec = si.get_spec("indextts2")
    assert "config.yaml" in spec.weights_config_names


def test_the_spec_still_accepts_the_hand_renamed_config(si):
    """Anyone who applied the pre-fix workaround must not have to reinstall."""
    spec = si.get_spec("indextts2")
    assert "config_v2_5.yaml" in spec.weights_config_names


@pytest.mark.parametrize("present", ["config.yaml", "config_v2_5.yaml"])
def test_the_weights_floor_accepts_either_config(si, tmp_path, present):
    (tmp_path / present).write_text("model: {}\n", encoding="utf-8")
    (tmp_path / "model.safetensors").write_bytes(b"\0" * (6 * 1024 * 1024))
    assert si._weights_floor_ok(
        tmp_path, config_names=("config.yaml", "config_v2_5.yaml"),
    ) is True


def test_the_weights_floor_still_rejects_a_config_less_dir(si, tmp_path):
    """The floor's real job — catching a truncated download — is unchanged."""
    (tmp_path / "model.safetensors").write_bytes(b"\0" * (6 * 1024 * 1024))
    assert si._weights_floor_ok(
        tmp_path, config_names=("config.yaml", "config_v2_5.yaml"),
    ) is False


def test_a_fresh_upstream_download_resolves_its_config(sidecar, tmp_path):
    """The load path, not just the installer: a clean IndexTTS-2.5 snapshot
    has only config.yaml, and pre-fix that produced a cfg_path to nowhere."""
    ckpt = tmp_path / "checkpoints"
    ckpt.mkdir()
    (ckpt / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    assert sidecar._resolve_cfg_path(str(ckpt), version="2.5") == str(ckpt / "config.yaml")


def test_a_hand_renamed_install_still_resolves(sidecar, tmp_path):
    ckpt = tmp_path / "checkpoints"
    ckpt.mkdir()
    (ckpt / "config_v2_5.yaml").write_text("model: {}\n", encoding="utf-8")
    assert sidecar._resolve_cfg_path(str(ckpt), version="2.5") == str(ckpt / "config_v2_5.yaml")


def test_the_deliberately_renamed_config_wins_when_both_exist(sidecar, tmp_path):
    ckpt = tmp_path / "checkpoints"
    ckpt.mkdir()
    (ckpt / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    (ckpt / "config_v2_5.yaml").write_text("model: {}\n", encoding="utf-8")
    assert sidecar._resolve_cfg_path(str(ckpt), version="2.5") == str(ckpt / "config_v2_5.yaml")


def test_a_missing_config_names_a_real_upstream_path(sidecar, tmp_path):
    """Degrade to the name upstream ships, so the error a user sees names a
    file that could actually exist."""
    assert sidecar._resolve_cfg_path(str(tmp_path), version="2.5").endswith("config.yaml")


def test_indextts_2_is_untouched(sidecar, tmp_path):
    assert sidecar._resolve_cfg_path(str(tmp_path), version="2").endswith("config.yaml")


# ── 2. the 60s kill ───────────────────────────────────────────────────────

def _frames(buf: io.BytesIO) -> list[dict]:
    import json

    raw, out = buf.getvalue(), []
    i = 0
    while i + 4 <= len(raw):
        (n,) = struct.unpack("!I", raw[i:i + 4])
        i += 4
        out.append(json.loads(raw[i:i + n].decode("utf-8")))
        i += n
    return out


def test_the_recv_deadline_outlasts_a_long_passage():
    from engines.indextts import IndexTTS2Backend
    from services.subprocess_backend import RECV_TIMEOUT_S

    got = IndexTTS2Backend().recv_timeout_s
    assert got > RECV_TIMEOUT_S, "IndexTTS is back on the 60s default that killed #1611"
    assert got >= 600


@pytest.mark.parametrize("raw,expected", [
    ("1200", 1200.0),
    ("10", 30.0),          # floor — a too-short deadline is the original bug
    ("inf", 900.0),        # the watchdog must not be disableable
    ("nonsense", 900.0),
])
def test_the_recv_deadline_is_tunable_but_bounded(monkeypatch, raw, expected):
    from engines.indextts import IndexTTS2Backend

    monkeypatch.setenv("OMNIVOICE_INDEXTTS_RECV_TIMEOUT_S", raw)
    assert IndexTTS2Backend().recv_timeout_s == expected


def test_a_long_blocking_call_keeps_the_watchdog_armed(sidecar, monkeypatch):
    """The heart of the fix: silence is what kills a healthy synthesis, so a
    slow infer() must put progress frames on the wire while it runs."""
    monkeypatch.setattr(sidecar, "_HEARTBEAT_S", 0.01)
    out = io.BytesIO()
    with sidecar._heartbeat(out, "synthesizing"):
        deadline = __import__("time").monotonic() + 2.0
        while len(_frames(out)) < 3 and __import__("time").monotonic() < deadline:
            __import__("time").sleep(0.01)

    frames = _frames(out)
    assert len(frames) >= 3, f"no liveness on the wire: {frames}"
    assert {f["stage"] for f in frames} == {"synthesizing"}
    assert [f["percent"] for f in frames] == sorted(f["percent"] for f in frames)
    assert all(1 <= f["percent"] <= 99 for f in frames)


def test_the_heartbeat_stops_with_the_block(sidecar, monkeypatch):
    """A leaked beat thread would keep writing onto a pipe the next request
    owns, corrupting its framing."""
    monkeypatch.setattr(sidecar, "_HEARTBEAT_S", 0.01)
    out = io.BytesIO()
    with sidecar._heartbeat(out, "loading_model"):
        __import__("time").sleep(0.05)
    settled = len(_frames(out))
    __import__("time").sleep(0.1)
    assert len(_frames(out)) == settled


def test_frame_writes_are_serialized(sidecar):
    """The heartbeat writes from its own thread; without the lock a concurrent
    length+body pair interleaves and desynchronizes the wire."""
    assert hasattr(sidecar, "_send_lock")
    import threading

    assert isinstance(sidecar._send_lock, type(threading.Lock()))
