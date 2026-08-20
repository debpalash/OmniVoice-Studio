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
    """Both files present from the start — a reversed precedence order fails
    here, not just a missing fallback."""
    ckpt = tmp_path / "checkpoints"
    ckpt.mkdir()
    (ckpt / "config.yaml").write_text("model: upstream\n", encoding="utf-8")
    (ckpt / "config_v2_5.yaml").write_text("model: renamed\n", encoding="utf-8")
    assert sidecar._resolve_cfg_path(str(ckpt), version="2.5") == str(ckpt / "config_v2_5.yaml")
    # And with only the upstream name present, precedence falls through to it.
    (ckpt / "config_v2_5.yaml").unlink()
    assert sidecar._resolve_cfg_path(str(ckpt), version="2.5") == str(ckpt / "config.yaml")


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


class _EventedStream:
    """A frame sink that raises an Event per completed write, so tests wait on
    writes instead of sleeping (no sleeps as synchronization)."""

    def __init__(self):
        import io
        import threading

        self._buf = io.BytesIO()
        self.wrote = threading.Event()

    def write(self, data):
        self._buf.write(data)
        return len(data)

    def flush(self):
        self.wrote.set()

    def getvalue(self):
        return self._buf.getvalue()


def _wait_for_frames(stream, count, timeout=5.0):
    import time as _time

    deadline = _time.monotonic() + timeout
    while len(_frames_bytes(stream.getvalue())) < count:
        remaining = deadline - _time.monotonic()
        assert remaining > 0, (
            f"only {len(_frames_bytes(stream.getvalue()))} of {count} frames arrived"
        )
        stream.wrote.clear()
        stream.wrote.wait(remaining)
    return _frames_bytes(stream.getvalue())


def _frames_bytes(raw: bytes) -> list[dict]:
    import json

    out, i = [], 0
    while i + 4 <= len(raw):
        (n,) = struct.unpack("!I", raw[i:i + 4])
        i += 4
        if i + n > len(raw):
            break  # torn frame — callers assert on completeness
        out.append(json.loads(raw[i:i + n].decode("utf-8")))
        i += n
    return out


def test_a_long_blocking_call_keeps_the_watchdog_armed(sidecar, monkeypatch):
    """The heart of the fix: silence is what kills a healthy synthesis, so a
    slow infer() must put progress frames on the wire while it runs."""
    monkeypatch.setattr(sidecar, "_HEARTBEAT_S", 0.01)
    out = _EventedStream()
    with sidecar._heartbeat(out, "synthesizing"):
        frames = _wait_for_frames(out, 3)

    assert len(frames) >= 3
    assert {f["stage"] for f in frames} == {"synthesizing"}
    percents = [f["percent"] for f in frames]
    assert percents == sorted(percents)
    assert all(1 <= p <= 99 for p in percents)


def test_the_heartbeat_stops_with_the_block(sidecar, monkeypatch):
    """A leaked beat thread would keep writing onto a pipe the next request
    owns, corrupting its framing. The context manager joins the thread on
    exit, so no write can arrive after the block."""
    monkeypatch.setattr(sidecar, "_HEARTBEAT_S", 0.01)
    out = _EventedStream()
    with sidecar._heartbeat(out, "loading_model"):
        _wait_for_frames(out, 2)
    settled = len(_frames_bytes(out.getvalue()))
    # The beat thread is joined; a write after this point can only mean the
    # join failed, and would flip the event.
    out.wrote.clear()
    assert not out.wrote.wait(0.1)
    assert len(_frames_bytes(out.getvalue())) == settled


def test_concurrent_sends_never_interleave_frames(sidecar):
    """The heartbeat writes from its own thread. _send holds a lock across the
    length+body pair; this drives real concurrent writers through a stream
    whose write() yields mid-call, so an unlocked (or wrongly scoped) _send
    produces torn frames and fails the decode below."""
    import io
    import threading

    class _YieldingStream:
        """Yields the scheduler between every byte, maximizing interleaving."""

        def __init__(self):
            self._buf = io.BytesIO()

        def write(self, data):
            import time as _time

            for i in range(len(data)):
                self._buf.write(data[i:i + 1])
                _time.sleep(0)  # explicit reschedule point, not synchronization
            return len(data)

        def flush(self):
            pass

        def getvalue(self):
            return self._buf.getvalue()

    out = _YieldingStream()
    per_thread = 25
    payloads = [{"op": "progress", "stage": f"t{t}", "percent": p}
                for t in range(4) for p in range(per_thread)]

    def _writer(t):
        for p in range(per_thread):
            sidecar._send(out, {"op": "progress", "stage": f"t{t}", "percent": p})

    threads = [threading.Thread(target=_writer, args=(t,)) for t in range(4)]
    for th in threads:
        th.start()
    for th in threads:
        th.join(timeout=30)

    decoded = _frames_bytes(out.getvalue())
    assert len(decoded) == len(payloads), "torn frame: a length+body pair interleaved"
    assert sorted((f["stage"], f["percent"]) for f in decoded) == sorted(
        (f["stage"], f["percent"]) for f in payloads
    )
