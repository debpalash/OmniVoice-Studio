"""omnivoice-subprocess engine: registry wiring, recv-timeout override, and the
hard-kill-on-timeout recovery that is the whole point of the engine (#730/#1190).

The in-process engine's abandoned worker thread cannot be killed and holds the
MPS device; a subprocess engine's child CAN be hard-killed (proc.kill() in
SubprocessBackend._timeout_kill), reclaiming VRAM/device, and the next request
respawns a fresh sidecar. The hard-kill test below is the deterministic proof,
the direct counterpart to the in-process ThreadPoolExecutor reproducer where
the zombie outlives the reset.

CI stays model-free: the roundtrip/hard-kill tests spawn a stub sidecar that
speaks the wire protocol and either returns a sine wave or wedges forever
(text == "HANG"), instead of loading the multi-GB VoiceStudio model.
"""
import struct
import json
import math
import array
import base64
import io
import os
import subprocess
import sys
import time
import asyncio
from pathlib import Path

import pytest

from services.subprocess_backend import (
    RECV_TIMEOUT_S,
    SubprocessBackend,
)
from services.tts_backend import OmniVoiceBackend, get_backend_class, list_backends
from engines.omnivoice_subprocess import (
    OmniVoiceMPSSubprocessBackend,
    OmniVoiceSubprocessBackend,
)


# ── stub sidecar (model-free) ──────────────────────────────────────────────

STUB_SIDECAR = r'''
import sys, os, json, struct, time, math, array, base64, subprocess

def _send(o):
    b = json.dumps(o, separators=(",", ":")).encode()
    sys.stdout.buffer.write(struct.pack("!I", len(b)) + b)
    sys.stdout.buffer.flush()

def _recv():
    h = sys.stdin.buffer.read(4)
    if len(h) < 4:
        return None
    (n,) = struct.unpack("!I", h)
    body = bytearray()
    while len(body) < n:
        c = sys.stdin.buffer.read(n - len(body))
        if not c:
            return None
        body.extend(c)
    return json.loads(bytes(body).decode())

_send({"op": "ready", "engine": "omnivoice-subprocess", "sample_rate": 24000})
while True:
    m = _recv()
    if m is None:
        sys.exit(0)
    op = m.get("op")
    if op == "ping":
        _send({"op": "pong", "vram_mb": 0.0})
    elif op == "shutdown":
        sys.exit(0)
    elif op == "synthesize":
        t = m.get("text", "")
        if t == "CRASH":
            os._exit(137)
        if t == "HANG":
            while True:  # wedge forever; the parent must hard-kill us
                time.sleep(1)
        if t == "HANG_CHILD":
            subprocess.Popen([
                sys.executable,
                "-c",
                "import os,time; time.sleep(1); "
                "open(os.environ['OMNIVOICE_TIMEOUT_MARKER'], 'w').write('bad')",
            ])
            while True:
                time.sleep(1)
        # Emit progress frames before the audio when asked, to exercise the
        # parent's progress-consuming recv loop (the cold-load fix).
        if t.startswith("PROG:"):
            for p in (10, 50, 90):
                _send({"op": "progress", "stage": "loading_model", "percent": p})
        sr = 24000
        pcm = array.array("h", (int(32767 * math.sin(2 * math.pi * 440 * i / sr)) for i in range(sr)))
        _send({"op": "audio", "audio_pcm_b64": base64.b64encode(pcm.tobytes()).decode(),
               "sample_rate": sr, "n_samples": sr})
    else:
        _send({"op": "error", "stage": "dispatch", "message": "unknown op %r" % op})
'''


@pytest.fixture
def stub_sidecar(tmp_path):
    p = tmp_path / "stub_sidecar.py"
    p.write_text(STUB_SIDECAR)
    return p


def _use_stub(monkeypatch, stub_path):
    monkeypatch.setattr(
        OmniVoiceSubprocessBackend, "sidecar_script",
        classmethod(lambda cls: stub_path),
    )


# ── registry + isolation ───────────────────────────────────────────────────


def test_registry_resolves_to_subprocess_backend():
    assert get_backend_class("omnivoice-subprocess") is OmniVoiceSubprocessBackend


@pytest.mark.parametrize(
    ("family", "expected_name"),
    [("mps", "OmniVoiceMPSSubprocessBackend"), ("cuda", "OmniVoiceBackend"),
     ("cpu", "OmniVoiceBackend")],
)
def test_omnivoice_is_crash_isolated_only_on_mps(monkeypatch, family, expected_name):
    from core.device_caps import HostCaps

    available = (family, "cpu") if family != "cpu" else ("cpu",)
    monkeypatch.setattr(
        "core.device_caps.detect_host_caps",
        lambda: HostCaps(family=family, available_families=available),
    )

    resolved = get_backend_class("omnivoice")
    assert resolved.__name__ == expected_name
    if family != "mps":
        assert resolved is OmniVoiceBackend


def test_engine_catalogue_reports_effective_mps_isolation(monkeypatch):
    from core.device_caps import HostCaps
    from services import tts_backend

    monkeypatch.setattr(tts_backend, "_REGISTRY", {"omnivoice": OmniVoiceBackend})
    monkeypatch.setattr(
        "core.device_caps.detect_host_caps",
        lambda: HostCaps(family="mps", available_families=("mps", "cpu")),
    )
    monkeypatch.setattr(
        "engines.omnivoice_subprocess.OmniVoiceSubprocessBackend.is_available",
        classmethod(lambda cls: (True, "ready")),
    )

    row = next(item for item in list_backends() if item["id"] == "omnivoice")
    assert row["isolation_mode"] == "subprocess"


def test_mps_startup_does_not_preload_native_model(monkeypatch):
    from core.device_caps import HostCaps
    from services import model_manager

    monkeypatch.setattr(
        "core.device_caps.detect_host_caps",
        lambda: HostCaps(family="mps", available_families=("mps", "cpu")),
    )
    monkeypatch.setenv("OMNIVOICE_TTS_BACKEND", "omnivoice")
    monkeypatch.setattr(model_manager, "model", None)

    async def fail_load():
        raise AssertionError("native OmniVoice must not load in the API process on MPS")

    monkeypatch.setattr(model_manager, "_load_model_with_timeout", fail_load)
    asyncio.run(model_manager.preload_model())


def test_streaming_mps_path_does_not_load_native_model(monkeypatch):
    from api.routers.tts_stream import _resolve_stream_backend
    from services import model_manager, tts_backend

    sentinel = object()
    monkeypatch.setattr(tts_backend, "active_backend_id", lambda: "omnivoice")
    monkeypatch.setattr(
        tts_backend, "get_backend_class", lambda _id: OmniVoiceMPSSubprocessBackend,
    )
    monkeypatch.setattr(tts_backend, "get_active_tts_backend", lambda: sentinel)

    async def fail_load():
        raise AssertionError("streaming must not load native OmniVoice on MPS")

    monkeypatch.setattr(model_manager, "get_model", fail_load)
    assert asyncio.run(_resolve_stream_backend(None)) is sentinel


def test_is_marked_subprocess_isolated():
    # list_backends() detects isolation via this duck-typed marker, not issubclass.
    assert getattr(OmniVoiceSubprocessBackend, "_is_subprocess_isolated", False) is True


def test_is_available_returns_tuple():
    ok, msg = OmniVoiceSubprocessBackend.is_available()
    assert isinstance(ok, bool)
    assert isinstance(msg, str)


# ── recv-timeout override (the F1-1 base-class hook) ───────────────────────


class _PlainBackend(SubprocessBackend):
    """Minimal concrete subclass that does NOT override recv_timeout_s."""
    id = "plain"

    @classmethod
    def is_available(cls):
        return True, "ok"

    @property
    def sample_rate(self):
        return 24000

    @property
    def supported_languages(self):
        return ["multi"]


def test_base_default_recv_timeout_is_60s():
    # A subclass that does NOT override keeps the conservative default, so the
    # existing subprocess engines (IndexTTS, dots.tts, ...) are byte-identical.
    assert SubprocessBackend.recv_timeout_s == RECV_TIMEOUT_S == 60.0
    assert _PlainBackend().recv_timeout_s == 60.0


def test_sidecar_spawn_delegates_all_containment_to_nested_owner(monkeypatch, tmp_path):
    from services import subprocess_backend as backend_module

    captured = {}

    class StubProcess:
        stderr = io.BytesIO()

        @staticmethod
        def poll():
            return None

    def fake_spawn(argv, **kwargs):
        captured.update(kwargs)
        return StubProcess()

    monkeypatch.setattr(_PlainBackend, "venv_python", classmethod(lambda cls: Path(sys.executable)))
    monkeypatch.setattr(
        _PlainBackend,
        "sidecar_script",
        classmethod(lambda cls: tmp_path / "stub.py"),
    )
    monkeypatch.setattr(backend_module, "spawn_owned", fake_spawn)
    monkeypatch.setattr(backend_module, "_ensure_reaper_running", lambda: None)
    backend = _PlainBackend()
    monkeypatch.setattr(backend, "_recv_with_timeout", lambda _timeout: {"op": "ready"})

    try:
        backend._spawn()
        assert not ({"start_new_session", "creationflags", "preexec_fn"} & captured.keys())
    finally:
        backend._proc = None


def test_omnivoice_subprocess_recv_timeout_overrides_default():
    b = OmniVoiceSubprocessBackend()
    assert b.recv_timeout_s == 300.0  # aligns with the generate budget


def test_omnivoice_subprocess_has_longer_spawn_budget_than_other_sidecars():
    assert _PlainBackend.spawn_ready_timeout_s == 30.0
    assert OmniVoiceSubprocessBackend.spawn_ready_timeout_s == 120.0


def test_spawn_uses_backend_specific_ready_timeout(monkeypatch, tmp_path):
    _use_stub(monkeypatch, tmp_path / "unused.py")
    backend = OmniVoiceSubprocessBackend()
    observed = []

    class StubProcess:
        stderr = io.BytesIO()

        @staticmethod
        def poll():
            return None

    monkeypatch.setattr(
        "services.subprocess_backend.spawn_owned",
        lambda *_args, **_kwargs: StubProcess(),
    )
    monkeypatch.setattr(
        backend,
        "_recv_with_timeout",
        lambda timeout: observed.append(timeout) or {"op": "ready"},
    )
    monkeypatch.setattr("services.subprocess_backend._ensure_reaper_running", lambda: None)

    try:
        backend._spawn()
    finally:
        backend._proc = None

    assert observed == [120.0]


def test_omnivoice_subprocess_recv_timeout_env_override(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_SIDECAR_RECV_TIMEOUT_S", "120")
    assert OmniVoiceSubprocessBackend().recv_timeout_s == 120.0


def test_omnivoice_subprocess_recv_timeout_floors_at_30s(monkeypatch):
    # A misconfigured tiny value must still leave time for a real handshake.
    monkeypatch.setenv("OMNIVOICE_SIDECAR_RECV_TIMEOUT_S", "1")
    assert OmniVoiceSubprocessBackend().recv_timeout_s == 30.0


# ── roundtrip via the stub sidecar ─────────────────────────────────────────


def test_roundtrip_synthesize_returns_audio_tensor(stub_sidecar, monkeypatch):
    _use_stub(monkeypatch, stub_sidecar)
    b = OmniVoiceSubprocessBackend()
    try:
        tensor = b.generate("hello")
        assert tensor.shape[0] == 1              # (1, n_samples)
        assert tensor.shape[1] == 24000          # 1s of 24 kHz from the stub
        assert tensor.abs().max() > 0.0          # non-silent sine
    finally:
        b.shutdown()


def test_generate_consumes_progress_frames_before_audio(stub_sidecar, monkeypatch):
    # Regression for the cold-load bug: a sidecar that emits {"op": "progress"}
    # frames (as the real one does during a model load) before the audio frame
    # must NOT make generate() raise "unexpected op". The base loops on progress.
    _use_stub(monkeypatch, stub_sidecar)
    b = OmniVoiceSubprocessBackend()
    try:
        tensor = b.generate("PROG:hello")  # stub emits 3 progress frames first
        assert tensor.shape[1] == 24000    # got the audio despite the progress
    finally:
        b.shutdown()


# ── hard-kill on timeout + recovery (the load-bearing regression) ──────────


def test_wedged_sidecar_is_hard_killed_and_recovers(stub_sidecar, monkeypatch):
    _use_stub(monkeypatch, stub_sidecar)
    # Short effective timeout so the test is fast. The property floors env at
    # 30s, so drive the watchdog directly via the class attribute the base reads.
    monkeypatch.setattr(OmniVoiceSubprocessBackend, "recv_timeout_s",
                        property(lambda self: 2.0))
    b = OmniVoiceSubprocessBackend()
    try:
        # 1. A wedged generate raises (the watchdog kills the child at 2s, the
        #    pipe closes, _recv returns None -> "closed pipe").
        with pytest.raises(RuntimeError):
            b.generate("HANG")
        # 2. The child is actually dead, the thing the in-process engine cannot do.
        assert b._proc is not None
        assert b._proc.poll() is not None
        # 3. Recovery: the next generate respawns a fresh sidecar and succeeds.
        tensor = b.generate("ok")
        assert tensor.shape[1] == 24000
    finally:
        b.shutdown()


def test_mps_proxy_survives_fatal_child_exit_and_recovers(stub_sidecar, monkeypatch):
    _use_stub(monkeypatch, stub_sidecar)
    monkeypatch.setattr(
        "services.model_manager.make_room_before_generate", lambda: None,
    )
    b = OmniVoiceMPSSubprocessBackend()
    try:
        with pytest.raises(RuntimeError, match="backend is still running"):
            b.generate("CRASH")
        assert b._proc is not None and b._proc.poll() is not None
        assert b.generate("ok").shape[1] == 24000
    finally:
        b.shutdown()


def test_desktop_timeout_kills_engine_subtree_before_late_mutation(
    stub_sidecar, monkeypatch, tmp_path
):
    marker = tmp_path / "late-engine-mutation"
    monkeypatch.setenv("OMNIVOICE_DESKTOP_CONTAINED", "1")
    drain_read, drain_write = os.pipe()
    monkeypatch.setenv("OMNIVOICE_DESKTOP_DRAIN_FD", str(drain_write))
    monkeypatch.setenv("OMNIVOICE_TIMEOUT_MARKER", str(marker))
    _use_stub(monkeypatch, stub_sidecar)
    monkeypatch.setattr(
        OmniVoiceSubprocessBackend,
        "recv_timeout_s",
        property(lambda self: 0.3),
    )
    b = OmniVoiceSubprocessBackend()
    try:
        with pytest.raises(RuntimeError):
            b.generate("HANG_CHILD")
        time.sleep(1.2)
        assert not marker.exists()
        assert b.generate("ok").shape[1] == 24000
    finally:
        b.shutdown()
        os.close(drain_write)
        os.close(drain_read)


def test_generate_does_not_deadlock_when_called_on_gpu_pool_worker(stub_sidecar, monkeypatch):
    # Regression: /v1/audio/speech and /generate dispatch backend.generate() via
    # run_on_gpu_pool_guarded, i.e. ON a gpu-pool worker. generate() must NOT
    # acquire a second slot from the same 1-worker pool (self-deadlock on MPS):
    # before the fix, the inner pool.submit queued behind this very job and
    # slot_future.result(timeout=10) raised before the sidecar ever spawned.
    _use_stub(monkeypatch, stub_sidecar)
    from services.model_manager import _get_gpu_pool
    b = OmniVoiceSubprocessBackend()
    pool = _get_gpu_pool()
    try:
        # Mirror run_on_gpu_pool_guarded: run generate() on a pool worker thread.
        fut = pool.submit(lambda: b.generate("on-pool"))
        tensor = fut.result(timeout=30)  # pre-fix: raised ~10s slot timeout
        assert tensor.shape[1] == 24000
    finally:
        b.shutdown()


def test_sidecar_forwards_native_controls_and_applies_seed(monkeypatch):
    import torch
    from engines.omnivoice_subprocess import main as sidecar

    calls = []
    seeds = []
    frames = []

    class FakeModel:
        sampling_rate = 24000

        def generate(self, **kwargs):
            calls.append(kwargs)
            return [torch.zeros(1, 16)]

    monkeypatch.setattr(sidecar, "_load_model", lambda _stdout: FakeModel())
    monkeypatch.setattr(sidecar, "_send", lambda _stdout, frame: frames.append(frame))
    real_manual_seed = torch.manual_seed
    monkeypatch.setattr(
        torch, "manual_seed", lambda seed: (seeds.append(seed), real_manual_seed(seed))[1],
    )

    sidecar._handle_synthesize({
        "text": "hello",
        "seed": 123,
        "t_shift": 0.4,
        "layer_penalty_factor": 0.2,
        "position_temperature": 0.7,
        "class_temperature": 0.8,
        "audio_chunk_duration": 10,
        "audio_chunk_threshold": 0.6,
    }, object())

    assert seeds == [123]
    assert calls == [{
        "text": "hello",
        "ref_audio": None,
        "ref_text": None,
        "t_shift": 0.4,
        "layer_penalty_factor": 0.2,
        "position_temperature": 0.7,
        "class_temperature": 0.8,
        "audio_chunk_duration": 10,
        "audio_chunk_threshold": 0.6,
    }]
    assert frames[-1]["op"] == "audio"


def test_generation_proxy_forwards_native_controls_and_seed():
    import torch
    from api.routers.generation import _run_backend_inference

    calls = []

    class Proxy:
        id = "omnivoice"
        display_name = "OmniVoice"
        sample_rate = 24000
        applies_own_mastering = True
        supports_native_omnivoice_controls = True

        def generate(self, text, **kwargs):
            calls.append((text, kwargs))
            return torch.zeros(1, 240)

    _run_backend_inference(
        Proxy(), "hello", "en", None, None, None, None,
        16, 2.0, 1.0, False, False, 321,
        t_shift=0.4, layer_penalty_factor=0.2,
        position_temperature=0.7, class_temperature=0.8,
    )

    assert calls == [("hello", {
        "duration": None,
        "language": "en",
        "ref_audio": None,
        "ref_text": None,
        "instruct": None,
        "num_step": 16,
        "guidance_scale": 2.0,
        "speed": 1.0,
        "denoise": False,
        "postprocess_output": False,
        "t_shift": 0.4,
        "layer_penalty_factor": 0.2,
        "position_temperature": 0.7,
        "class_temperature": 0.8,
        "seed": 321,
    })]
