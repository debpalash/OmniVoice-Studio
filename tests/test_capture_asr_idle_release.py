"""The warm capture/dictation ASR must be idle-released, like the TTS model.

Root cause behind the "Can't reach the local OmniVoice backend" deaths on 16 GB
Macs (#1076/#1092/#1093/#1101): the TTS model has always been unloaded after an
idle timeout (``model_manager.idle_worker``), but the capture-ASR singleton was
not — once a user dictated even once, its model stayed resident for the life of
the process.

Measured on a 16 GB M2: the backend sat at ~6.2 GB **idle** (TTS 3.8 GB + ~2 GB
of warm ASR) while an actual generate cost only ~116 MB on top. That baseline —
not any spike during generation — is what pushes the machine into memory
pressure until the OS kills the backend mid-generate. Freeing 3.8 GB of TTS
while silently holding 2 GB of ASR forever was the asymmetry.

Fail-before: ``release_idle_capture_backend`` did not exist and ``idle_worker``
never touched the ASR singleton.
"""
from __future__ import annotations

import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest

from services import asr_backend as ab


class _FakeBackend:
    """Stands in for a warm mlx-whisper / sherpa recognizer."""

    def __init__(self):
        self.unloaded = False

    def unload(self):
        self.unloaded = True


@pytest.fixture(autouse=True)
def _clean_singleton(monkeypatch):
    """Isolate the module-level capture singleton for every test."""
    monkeypatch.setattr(ab, "_capture_backend", None, raising=False)
    monkeypatch.setattr(ab, "_capture_backend_key", None, raising=False)
    monkeypatch.setattr(ab, "_capture_leases", 0, raising=False)
    monkeypatch.setattr(ab, "_capture_last_used", 0.0, raising=False)
    yield


def _install(backend, *, last_used=0.0):
    ab._capture_backend = backend
    ab._capture_backend_key = "fake"
    ab._capture_last_used = last_used


def test_releases_the_model_once_it_has_gone_idle():
    fake = _FakeBackend()
    _install(fake, last_used=0.0)

    # 900 s (the default idle timeout) later, with nothing holding it.
    assert ab.release_idle_capture_backend(900.0, now=1000.0) is True
    assert fake.unloaded is True
    # The singleton is dropped, so the next dictation rebuilds a fresh one.
    assert ab._capture_backend is None
    assert ab._capture_backend_key is None


def test_keeps_the_model_while_it_is_still_in_use():
    fake = _FakeBackend()
    _install(fake, last_used=990.0)  # used 10 s ago

    assert ab.release_idle_capture_backend(900.0, now=1000.0) is False
    assert fake.unloaded is False
    assert ab._capture_backend is fake


def test_never_unloads_underneath_a_live_dictation_session():
    """A live stream holds the backend for its whole life without re-resolving
    it — so an open-but-silent session must NOT have its model pulled away."""
    fake = _FakeBackend()
    _install(fake, last_used=0.0)  # long idle: would otherwise be reaped

    with ab.capture_lease():
        assert ab.release_idle_capture_backend(900.0, now=1_000_000.0) is False
        assert fake.unloaded is False
        assert ab._capture_backend is fake

    # Leaving the session restarts the idle clock (it is NOT instantly reapable).
    assert ab.release_idle_capture_backend(900.0) is False
    assert fake.unloaded is False


def test_lease_is_released_even_if_the_session_raises():
    fake = _FakeBackend()
    _install(fake, last_used=0.0)

    with pytest.raises(RuntimeError):
        with ab.capture_lease():
            raise RuntimeError("client disconnected mid-stream")

    assert ab._capture_leases == 0  # not leaked → the reaper isn't wedged forever


def test_nested_leases_refcount_correctly():
    fake = _FakeBackend()
    _install(fake, last_used=0.0)

    with ab.capture_lease():
        with ab.capture_lease():
            assert ab.release_idle_capture_backend(900.0, now=1_000_000.0) is False
        # Inner released, outer still holds it.
        assert ab._capture_leases == 1
        assert ab.release_idle_capture_backend(900.0, now=1_000_000.0) is False
    assert ab._capture_leases == 0


def test_no_op_when_nothing_is_loaded():
    assert ab.release_idle_capture_backend(900.0, now=1_000_000.0) is False


def test_a_failing_unload_still_drops_the_reference():
    """A stuck unload must not wedge the reaper or keep the model pinned —
    idle_worker calls this on a loop and must never die."""

    class _Boom(_FakeBackend):
        def unload(self):
            raise RuntimeError("metal context already torn down")

    _install(_Boom(), last_used=0.0)
    assert ab.release_idle_capture_backend(900.0, now=1000.0) is True
    assert ab._capture_backend is None


def test_getting_the_backend_resets_the_idle_clock(monkeypatch):
    """Any handout counts as use — otherwise a freshly-warmed model built at
    T=0 would be reaped on the very next idle tick."""
    fake = _FakeBackend()
    _install(fake, last_used=0.0)
    monkeypatch.setattr(ab, "dictation_model_id", lambda: None)
    monkeypatch.setattr(ab, "_pick_capture_whisper_backend", lambda: fake, raising=False)

    before = ab._capture_last_used
    ab._touch_capture()
    assert ab._capture_last_used > before
