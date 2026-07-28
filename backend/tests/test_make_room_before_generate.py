"""A warm, heavy generate must free idle GPU memory first (#730/#1190).

The cold LOAD path already evicts via _make_room_before_tts_load (it runs inside
_load_model_with_timeout). The warm path (model already resident, get_model
returns early at the cache check) skipped it, so a long generate on a
VRAM-tight MPS box contended with capture-ASR and the clone-prompt side cache
until it exceeded the execution budget and was abandoned, which is exactly how
one slow synth cascaded into a stuck, device-holding backend.
make_room_before_generate closes that gap, behind a policy that is the one real
reliability-vs-latency knob.
"""
import services.model_manager as mm
from services.model_manager import make_room_before_generate


def _count(monkeypatch):
    """Patch the three eviction primitives and count how often each runs."""
    calls = {"free_vram": 0, "side_caches": 0, "capture_asr": 0}

    monkeypatch.setattr(mm, "free_vram", lambda: calls.__setitem__("free_vram", calls["free_vram"] + 1))
    monkeypatch.setattr(
        mm, "release_tts_side_caches",
        lambda: calls.__setitem__("side_caches", calls["side_caches"] + 1),
    )
    import services.asr_backend as ab
    monkeypatch.setattr(
        ab, "release_idle_capture_backend",
        lambda _idle_s: calls.__setitem__("capture_asr", calls["capture_asr"] + 1),
    )
    return calls


def _ram(monkeypatch, gb):
    import services.memory_budget as mb
    monkeypatch.setattr(mb, "available_memory", lambda: {"ram_available_gb": gb})


def test_never_mode_frees_nothing(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_FREE_VRAM_BEFORE_GENERATE", "never")
    calls = _count(monkeypatch)
    make_room_before_generate("a" * 5000)  # long text, but mode wins
    assert calls == {"free_vram": 0, "side_caches": 0, "capture_asr": 0}


def test_always_mode_frees_all(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_FREE_VRAM_BEFORE_GENERATE", "always")
    calls = _count(monkeypatch)
    make_room_before_generate("hi")
    assert calls == {"free_vram": 1, "side_caches": 1, "capture_asr": 1}


def test_auto_frees_on_long_text_when_ram_moderate(monkeypatch):
    # Long text RAISES the headroom (6 -> 12 GB). At 8 GB free, a short synth
    # would skip (8 >= 6) but a long one trips the raised bar (8 < 12).
    monkeypatch.delenv("OMNIVOICE_FREE_VRAM_BEFORE_GENERATE", raising=False)
    _ram(monkeypatch, 8.0)
    calls = _count(monkeypatch)
    make_room_before_generate("a" * 1000)  # >= default 800-char threshold
    assert calls["free_vram"] == 1 and calls["side_caches"] == 1


def test_auto_long_text_skips_on_roomy_machine(monkeypatch):
    # A genuinely roomy machine pays nothing even for long text (the docstring
    # promise): 999 GB free is above even the raised 12 GB bar.
    monkeypatch.delenv("OMNIVOICE_FREE_VRAM_BEFORE_GENERATE", raising=False)
    _ram(monkeypatch, 999.0)
    calls = _count(monkeypatch)
    make_room_before_generate("a" * 1000)
    assert calls == {"free_vram": 0, "side_caches": 0, "capture_asr": 0}


def test_auto_skips_on_short_text_with_ample_ram(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_FREE_VRAM_BEFORE_GENERATE", raising=False)
    _ram(monkeypatch, 999.0)
    calls = _count(monkeypatch)
    make_room_before_generate("short text")
    assert calls == {"free_vram": 0, "side_caches": 0, "capture_asr": 0}


def test_auto_frees_on_tight_ram(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_FREE_VRAM_BEFORE_GENERATE", raising=False)
    _ram(monkeypatch, 0.5)  # below the 6.0 GB unified headroom
    calls = _count(monkeypatch)
    make_room_before_generate("short text")
    assert calls["free_vram"] == 1


def test_malformed_long_text_env_does_not_disable_auto(monkeypatch):
    # A non-numeric OMNIVOICE_FREE_VRAM_LONG_TEXT_CHARS must fall back, not
    # silently disable the whole auto path (#730/#1190).
    monkeypatch.delenv("OMNIVOICE_FREE_VRAM_BEFORE_GENERATE", raising=False)
    monkeypatch.setenv("OMNIVOICE_FREE_VRAM_LONG_TEXT_CHARS", "not-a-number")
    _ram(monkeypatch, 0.5)  # tight RAM -> auto must still free despite the bad env
    calls = _count(monkeypatch)
    make_room_before_generate("short text")
    assert calls["free_vram"] == 1


def test_default_mode_is_auto(monkeypatch):
    # No env set at all must behave as auto: long text at moderate RAM triggers.
    monkeypatch.delenv("OMNIVOICE_FREE_VRAM_BEFORE_GENERATE", raising=False)
    _ram(monkeypatch, 8.0)
    calls = _count(monkeypatch)
    make_room_before_generate("a" * 1000)
    assert calls["free_vram"] == 1
