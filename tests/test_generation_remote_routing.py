"""Clicking Synthesize with a remote GPU selected must reach that GPU.

Before this, `/generate` had no idea remote workers existed: `routing.decide()`
only ever painted a header badge and every render ran on the control plane's
own device. These tests pin the four things that made "I picked gpu2" true:

  1. The render is dispatched through the GPU gateway with the REMOTE
     decision, and nothing local is loaded on the way — no `get_model()`, no
     engine instance, no host-capability gate that would refuse a CUDA-only
     engine on a Mac.
  2. The whole chunked render travels as ONE op. The assignment carries the
     seed, chunk size and crossfade so the worker can reproduce
     split → generate(seed + i) → crossfaded concat → effect chain; the
     control plane does not pre-split and does not dispatch per chunk.
  3. `stream=true` — what the desktop UI sends whenever auto-play is on, i.e.
     by default — keeps its NDJSON channel but stops previewing per chunk:
     coarse worker progress, then the finished take as one chunk. Answering
     with the classic WAV shape here would send the client back to a LOCAL
     re-render, which is the entire reported bug.
  4. The take is provenance-marked exactly once (the worker marks before it
     encodes) and the response says where the work ran.

The gateway itself (`services/gpu_gateway.py`) is stubbed: these are tests of
the CALL SITE, and the fake records exactly what the real gateway would be
handed.
"""
import base64
import importlib
import io
import json
import os
import sqlite3

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest
import soundfile as sf
import torch


LONG_TEXT = (
    "The first sentence sets the scene tonight. "
    "A second sentence carries the middle part. "
    "The third sentence wraps everything up now."
)


@pytest.fixture(autouse=True)
def _hermetic_store(tmp_path, monkeypatch):
    """Pin OUTPUTS_DIR (both module bindings) and the history DB per test.

    Same reasoning as tests/test_generate_streaming.py: the router saves
    through `api.routers.generation.OUTPUTS_DIR` while a read-back goes via
    `core.config.OUTPUTS_DIR`, and a full-suite run can split the two.
    """
    import api.routers.generation as gen
    import core.config as cfg

    outdir = tmp_path / "outputs"
    outdir.mkdir()
    monkeypatch.setattr(cfg, "OUTPUTS_DIR", str(outdir))
    monkeypatch.setattr(gen, "OUTPUTS_DIR", str(outdir))

    dbf = tmp_path / "history.db"

    def _get_db():
        conn = sqlite3.connect(str(dbf))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    monkeypatch.setitem(gen.ensure_schema.__globals__, "get_db", _get_db)
    gen.ensure_schema()


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from main import app

    return TestClient(app, client=("127.0.0.1", 50000))


@pytest.fixture(autouse=True)
def _no_local_gpu(monkeypatch):
    """Any local render attempt in a REMOTE test is the bug under test."""
    import api.routers.generation as gen

    async def _boom():
        raise AssertionError("get_model() ran for a remote render")

    monkeypatch.setattr(gen, "get_model", _boom)


def _remote_decision(label="gpu2"):
    from worker.routing import Decision

    return Decision(remote=True, worker_id="0123456789ab", label=label,
                    reason="chosen")


def _local_decision(reason="chosen"):
    from worker.routing import Decision

    return Decision(remote=False, label="Local", reason=reason)


def _worker_wav(seconds=0.4, sample_rate=24000, amplitude=0.31):
    """WAV bytes shaped like what a worker's `_encode` puts on the wire."""
    n = int(seconds * sample_rate)
    wave = (torch.linspace(-1.0, 1.0, n) * amplitude).numpy()
    buf = io.BytesIO()
    sf.write(buf, wave, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class FakeGateway:
    """Stands in for the scheduler half of `services/gpu_gateway.py`.

    Same signature and same return contract as the real `run` — a
    `(waveform, sample_rate)` pair for `tts`, from either branch — so a call
    site that works against this works against the real one. What it does NOT
    do is talk to a control plane; that is the gateway's own test surface.
    """

    def __init__(self, *, payload=None, states=(), raises=None):
        self.calls = []
        self._payload = payload if payload is not None else _worker_wav()
        self._states = list(states)
        self._raises = raises

    async def run(self, op, *, local, remote=None, decision=None, job=None,
                  admit=False, on_state=None, executor=None, control_plane=None):
        self.calls.append({
            "op": op, "local": local, "remote": remote, "decision": decision,
            "job": job, "admit": admit,
        })
        if self._raises is not None:
            raise self._raises
        for state in self._states:
            if on_state is not None:
                on_state(state)
        if getattr(decision, "remote", False) and remote is not None:
            import services.gpu_gateway as real

            return real.decode_audio_artifact(
                real.RemoteResult(task_id="t1", worker_id="w1",
                                  worker_label=getattr(decision, "label", "gpu2"),
                                  path=self._artifact())
            )
        # The real gateway hands `local.fn` to run_on_gpu_pool_guarded; the
        # pool is not what these tests are about, so call it directly.
        return local.fn()

    def _artifact(self):
        import tempfile

        handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        handle.write(self._payload)
        handle.close()
        return handle.name


def _install(monkeypatch, gateway, decision):
    """Point the route's gateway calls at the fake, with a fixed decision."""
    import services.gpu_gateway as real

    monkeypatch.setattr(real, "run", gateway.run)
    monkeypatch.setattr(real, "decide", lambda op, **k: decision)
    return real


def _post(client, **overrides):
    data = {"text": LONG_TEXT, "engine": "omnivoice", "seed": "4242",
            "max_chunk_chars": "40", "crossfade_ms": "70"}
    data.update(overrides)
    return client.post("/generate", data=data)


def _stream_events(client, **overrides):
    data = {"text": LONG_TEXT, "engine": "omnivoice", "seed": "4242",
            "stream": "true"}
    data.update(overrides)
    events = []
    with client.stream("POST", "/generate", data=data) as r:
        assert r.status_code == 200, r.read()
        assert r.headers["content-type"].startswith("application/x-ndjson")
        headers = dict(r.headers)
        for line in r.iter_lines():
            if line.strip():
                events.append(json.loads(line))
    return headers, events


# ── 1. The classic path actually leaves this machine ────────────────────────

def test_remote_target_dispatches_through_the_gateway(client, monkeypatch):
    """The render goes to the worker, and the WAV that comes back is served."""
    payload = _worker_wav(seconds=0.5, amplitude=0.27)
    gateway = FakeGateway(payload=payload)
    _install(monkeypatch, gateway, _remote_decision("gpu2"))

    r = _post(client)

    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "audio/wav"
    assert len(gateway.calls) == 1
    call = gateway.calls[0]
    assert call["op"] == "tts"
    assert call["decision"].remote is True
    # Audio identity: the served take is the worker's audio, not a local one.
    served, sr = sf.read(io.BytesIO(r.content), dtype="float32", always_2d=True)
    expected, expected_sr = sf.read(io.BytesIO(payload), dtype="float32",
                                    always_2d=True)
    assert sr == expected_sr
    assert served.shape == expected.shape
    assert abs(float(served.max()) - float(expected.max())) < 1e-3


def test_remote_render_says_where_it_ran(client, monkeypatch):
    """The existing #21 notice channel carries "this ran on gpu2"."""
    _install(monkeypatch, FakeGateway(), _remote_decision("gpu2"))

    r = _post(client)

    assert r.headers.get("X-OmniVoice-Routing") == "remote"
    assert "gpu2" in r.headers.get("X-OmniVoice-Routing-Reason", "")


def test_unavailable_worker_falls_back_quietly_and_names_the_machine(
    client, monkeypatch
):
    """Rule 1: pre-dispatch unavailability renders here, with the reason.

    The gateway still owns the call — the local branch runs through it — so
    the route keeps exactly one dispatch site.
    """
    import api.routers.generation as gen

    class _Model:
        sampling_rate = 24000

    async def _get_model():
        return _Model()

    decision = _local_decision("gpu2 is offline — running locally")
    gateway = FakeGateway()
    _install(monkeypatch, gateway, decision)
    monkeypatch.setattr(gen, "get_model", _get_model)
    monkeypatch.setattr(gen, "_run_inference",
                        lambda *a, **k: torch.zeros(1, 2400))

    r = _post(client)

    assert r.status_code == 200, r.text
    assert r.headers.get("X-OmniVoice-Routing") == "local_fallback"
    assert "gpu2 is offline" in r.headers.get("X-OmniVoice-Routing-Reason", "")
    assert gateway.calls[0]["local"] is not None
    assert gateway.calls[0]["decision"].remote is False


# ── 2. The whole chunked render travels as one op ───────────────────────────

def test_remote_assignment_carries_the_whole_chunked_render(client, monkeypatch):
    """Per-chunk dispatch is rejected, so every knob the chunk loop reads has
    to be on the wire — otherwise remote audio silently differs from local."""
    gateway = FakeGateway()
    _install(monkeypatch, gateway, _remote_decision())

    r = _post(client, max_chunk_chars="40", crossfade_ms="70", seed="4242",
              effect_preset="broadcast")
    assert r.status_code == 200, r.text

    assert len(gateway.calls) == 1, "one op per render, never one per chunk"
    call = gateway.calls[0]["remote"]
    params = call.params
    assert call.engine == "omnivoice"
    assert call.operation == "tts"
    assert params["seed"] == 4242
    assert params["max_chunk_chars"] == 40
    assert params["crossfade_ms"] == 70
    assert params["effect_preset"] == "broadcast"
    # The FULL text, unsplit: the split belongs to the worker.
    assert params["text"].startswith("The first sentence")
    assert params["text"].endswith("everything up now.")


def test_reference_audio_travels_with_the_assignment(client, monkeypatch, tmp_path):
    """A clone's reference lives only on this machine, so the assignment has
    to carry it — the transport is what stages it onto the worker."""
    gateway = FakeGateway()
    _install(monkeypatch, gateway, _remote_decision())

    ref = tmp_path / "ref.wav"
    sf.write(str(ref), torch.zeros(2400).numpy(), 24000, format="WAV")

    asr = importlib.import_module("services.asr_backend")
    monkeypatch.setattr(asr, "transcribe_reference", lambda *a, **k: None)
    with open(ref, "rb") as fh:
        r = client.post(
            "/generate",
            data={"text": "Hello there.", "engine": "omnivoice",
                  "ref_text": "hello"},
            files={"ref_audio": ("ref.wav", fh.read(), "audio/wav")},
        )
    assert r.status_code == 200, r.text

    call = gateway.calls[0]["remote"]
    assert call.params["ref_audio"]
    assert call.params["ref_text"] == "hello"


# ── 3. Streaming preview off, progress on ───────────────────────────────────

def test_remote_stream_reports_progress_then_one_chunk(client, monkeypatch):
    """stream=true stays NDJSON (the client asked for it) but stops previewing
    per chunk — coarse worker progress, then the finished take."""
    states = [
        {"phase": "queued", "progress": 0.0, "worker": "gpu2"},
        {"phase": "loading", "progress": 0.5, "worker": "gpu2"},
        {"phase": "running", "progress": 0.42, "worker": "gpu2"},
    ]
    gateway = FakeGateway(states=states)
    _install(monkeypatch, gateway, _remote_decision("gpu2"))

    headers, events = _stream_events(client)

    kinds = [e["type"] for e in events]
    assert kinds.count("chunk") == 1, "one op means one delivered chunk"
    assert kinds[-1] == "done"
    stages = [(e["stage"], e["detail"]) for e in events if e["type"] == "progress"]
    assert [s for s, _ in stages] == ["queued", "loading", "running"]
    assert stages[0][1] == "queued on gpu2"
    assert stages[1][1] == "loading model on gpu2"
    assert stages[2][1] == "generating on gpu2 (42%)"
    assert all(e["target"] == "gpu2"
               for e in events if e["type"] == "progress")
    # Progress lands BEFORE the audio, or it is not progress.
    assert kinds.index("progress") < kinds.index("start")
    assert headers.get("x-omnivoice-routing") == "remote"


def test_remote_stream_delivers_the_workers_audio(client, monkeypatch):
    """The single chunk is the worker's render, and the take is saved."""
    payload = _worker_wav(seconds=0.25, amplitude=0.4)
    _install(monkeypatch, FakeGateway(payload=payload), _remote_decision())

    _headers, events = _stream_events(client)

    chunk = next(e for e in events if e["type"] == "chunk")
    done = next(e for e in events if e["type"] == "done")
    pcm = base64.b64decode(chunk["pcm"])
    assert len(pcm) == 2 * int(0.25 * 24000)
    from core.config import OUTPUTS_DIR
    assert os.path.exists(os.path.join(OUTPUTS_DIR, done["audio_path"]))


def test_remote_stream_does_not_run_the_local_chunk_loop(client, monkeypatch):
    """The local streaming path must not run at all under a remote target —
    it is what made the user's click render on their laptop."""
    def _never(*a, **k):
        raise AssertionError("the local chunk splitter ran for a remote render")

    _install(monkeypatch, FakeGateway(), _remote_decision())
    chunked = importlib.import_module("services.chunked_tts")
    monkeypatch.setattr(chunked, "split_text_into_chunks", _never)

    _headers, events = _stream_events(client)
    assert events[-1]["type"] == "done"


# ── 4. Provenance and failure ───────────────────────────────────────────────

def test_remote_take_is_not_marked_twice(client, monkeypatch):
    """The worker marks before it encodes; a second AudioSeal payload over the
    first degrades detection of both."""
    import api.routers.generation as gen

    marked = []

    def _mark(*a, **k):
        marked.append(k.get("context"))
        return a[0]

    watermark = importlib.import_module("services.watermark")
    monkeypatch.setattr(watermark, "mark_synthetic", _mark)
    _install(monkeypatch, FakeGateway(), _remote_decision())

    assert _post(client).status_code == 200
    assert "generate.finalize" not in marked


def test_watermark_preference_travels_with_the_assignment(client, monkeypatch):
    """The requesting user's preference governs, not the GPU owner's."""
    watermark = importlib.import_module("services.watermark")
    monkeypatch.setattr(watermark, "is_enabled", lambda: False)
    gateway = FakeGateway()
    _install(monkeypatch, gateway, _remote_decision())

    assert _post(client).status_code == 200
    assert gateway.calls[0]["remote"].params["watermark"] is False


def test_midjob_remote_failure_is_reported_not_silently_redone(client, monkeypatch):
    """Rule 2: minutes already spent elsewhere are not silently respent here."""
    from services.gpu_gateway import RemoteJobFailed

    gateway = FakeGateway(raises=RemoteJobFailed(
        "gpu2 did not finish this job: the worker went away",
        worker_label="gpu2", hint="Run it on this machine instead.",
    ))
    _install(monkeypatch, gateway, _remote_decision("gpu2"))

    r = _post(client)

    assert r.status_code == 503, r.text
    assert "gpu2" in r.json()["detail"]
    assert "Run it on this machine instead." in r.json()["detail"]
    assert r.headers.get("X-OmniVoice-Retryable") == "true"
    assert r.headers.get("X-OmniVoice-Routing") == "remote_failed"


def test_remote_stream_preserves_missing_model_download_fields(client, monkeypatch):
    from services.gpu_gateway import ModelNotDownloaded

    gateway = FakeGateway(raises=ModelNotDownloaded(
        engine="cosyvoice",
        repo_ids=["FunAudioLLM/Fun-CosyVoice3-0.5B-2512"],
        target="gpu2",
        target_label="gpu2",
    ))
    _install(monkeypatch, gateway, _remote_decision("gpu2"))

    _headers, events = _stream_events(client)

    failure = events[-1]
    assert failure["type"] == "error"
    assert failure["engine"] == "cosyvoice"
    assert failure["repo_ids"] == ["FunAudioLLM/Fun-CosyVoice3-0.5B-2512"]
    assert failure["target"] == "gpu2"
    assert failure["target_label"] == "gpu2"
    assert failure["downloadable"] is True


def test_remote_stream_preserves_retryable_midjob_guidance(client, monkeypatch):
    from services.gpu_gateway import RemoteJobFailed

    gateway = FakeGateway(raises=RemoteJobFailed(
        "worker stopped", worker_label="gpu2", hint="Run it locally.",
    ))
    _install(monkeypatch, gateway, _remote_decision("gpu2"))

    _headers, events = _stream_events(client)

    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is True
    assert events[-1]["target_label"] == "gpu2"
    assert events[-1]["hint"] == "Run it locally."


def test_remote_stream_unexpected_failure_keeps_private_details_out_of_logs(
    client, monkeypatch, caplog
):
    """The remote catch-all journals privately but logs and returns constants."""
    from core import error_journal

    error_journal.clear()
    private = (
        "TOKEN=remote-secret /home/alice/private-reference.wav "
        r"C:\Users\alice\private-reference.wav"
    )
    gateway = FakeGateway(raises=RuntimeError(private))
    _install(monkeypatch, gateway, _remote_decision("gpu2"))

    _headers, events = _stream_events(client)

    failure = events[-1]
    assert failure["type"] == "error"
    assert failure["code"] == "generation_failed"
    exposed = f"{caplog.text}\n{failure!r}"
    assert "remote-secret" not in exposed
    assert "/home/alice" not in exposed
    assert r"C:\Users\alice" not in exposed
    assert "Traceback" not in caplog.text
    assert "RuntimeError" in caplog.text
    entries = [e for e in error_journal.recent() if e.get("route") == "/generate"]
    assert entries
    entry = entries[0]
    assert entry["type"] == "RuntimeError"
    for stored in (entry["message"], entry["trace"]):
        assert "remote-secret" not in stored
        assert "/home/alice" not in stored
        assert r"C:\Users\alice" not in stored


def test_legacy_worker_missing_weights_returns_typed_409_before_submit(
    client, monkeypatch
):
    """An older peer's positive absence still reaches the HTTP download offer."""
    import services.gpu_gateway as gateway

    class Worker:
        class Record:
            capabilities = [{
                "engine": "cosyvoice", "model_id": "cosyvoice:default",
                "supported": True, "installed": True, "downloaded": False,
                # Phase-4 wire payload: repo_ids did not exist yet.
                "operations": ["tts"],
            }]
        record = Record()

    class Pool:
        def get(self, _worker_id):
            return Worker()

    class Scheduler:
        submitted = []

        def submit(self, **kwargs):
            self.submitted.append(kwargs)
            raise AssertionError("scheduler.submit ran before model preflight")

    class Plane:
        running = True
        pool = Pool()
        scheduler = Scheduler()

    decision = _remote_decision("gpu2")
    monkeypatch.setattr(gateway, "decide", lambda op, **kwargs: decision)
    monkeypatch.setattr(gateway, "_plane", lambda control_plane=None: Plane())

    response = _post(client, text="Legacy capability probe.", engine="cosyvoice")

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "error": "model_not_downloaded",
        "message": "This model is not downloaded on gpu2.",
        "engine": "cosyvoice",
        "repo_ids": ["FunAudioLLM/Fun-CosyVoice3-0.5B-2512"],
        "size_bytes": int(9.8 * 1024**3),
        "target": decision.worker_id,
        "target_label": "gpu2",
        "downloadable": True,
    }
    assert Plane.scheduler.submitted == []


def test_remote_render_is_not_refused_by_this_hosts_capabilities(
    client, monkeypatch
):
    """A CUDA-only engine sent to a 4090 must not be 400-ed because the
    control plane is a Mac — the gate describes a machine doing nothing."""
    def _unavailable(*a, **k):
        raise AssertionError("the local host-capability gate ran for a remote render")

    gateway = FakeGateway()
    _install(monkeypatch, gateway, _remote_decision())
    engine_routing = importlib.import_module("services.engine_routing")
    monkeypatch.setattr(engine_routing, "resolve_routing", _unavailable)

    r = _post(client)
    assert r.status_code == 200, r.text
    assert gateway.calls[0]["decision"].remote is True


# ── 5. The streaming socket says it stays here ──────────────────────────────

def test_ws_tts_says_it_runs_on_this_machine(client, monkeypatch):
    """/ws/tts has no remote form: latency is the whole point of the route.
    Staying silent would let the header badge imply the 4090 is doing it."""
    from worker import routing as worker_routing

    monkeypatch.setattr(
        worker_routing, "decide", lambda **k: _remote_decision("gpu2")
    )

    frames = []
    with client.websocket_connect("/ws/tts") as ws:
        ws.send_json({"text": "Hello.", "engine": "definitely-not-an-engine"})
        for _ in range(3):
            frame = ws.receive_json()
            frames.append(frame)
            if frame.get("type") in ("done", "error"):
                break

    routing_frames = [f for f in frames if f.get("type") == "routing"]
    assert any(f.get("status") == "local_stream" for f in routing_frames), frames
    local_only = next(f for f in routing_frames if f["status"] == "local_stream")
    assert "gpu2" in local_only["reason"]
    assert "this machine" in local_only["reason"]
