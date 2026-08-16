"""Voice-clone prompts persist across restarts (upstream VoiceClonePrompt port).

The in-memory prompt cache (#427/#473) dies with the process, so the first
generation of every session re-encoded each voice — and re-ran ASR when the
profile had no stored transcript. Upstream k2-fsa added
``VoiceClonePrompt.save()/.load()`` for exactly this; we port the format
(version-tagged dict, ``torch.load(weights_only=True)``-safe) and put a disk
layer under the memory LRU, keyed identically (ref path + mtime + ref_text +
preprocess flag). Restart is simulated here by clearing the memory cache: a
second lookup must come from disk, not a re-encode.

The layer is best-effort by contract: disabled (env), unwritable, or corrupt
disk state must never fail a generation — worst case is the old re-encode.
"""
from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")


def _tb():
    """The *live* services.tts_backend (same rationale as
    test_clone_prompt_wiring._tb: other suites purge services.* modules)."""
    import services.tts_backend as m
    return m


def _VoiceClonePrompt():
    """Resolved at call time — a module-level binding could go stale when
    another suite purges omnivoice.* from sys.modules (CodeRabbit, #1565)."""
    from omnivoice.models.omnivoice import VoiceClonePrompt
    return VoiceClonePrompt


def _prompt():
    return _VoiceClonePrompt()(
        ref_audio_tokens=torch.arange(24, dtype=torch.long).reshape(8, 3),
        ref_text="Nice to meet you.",
        ref_rms=0.123,
    )


class _StubModel:
    def __init__(self):
        self.encodes = 0

    def create_voice_clone_prompt(self, ref_audio, ref_text=None, preprocess_prompt=True):
        self.encodes += 1
        return _prompt()


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """Point the disk layer at a per-test dir and start with empty caches."""
    monkeypatch.setattr("core.config.DATA_DIR", tmp_path / "data")
    monkeypatch.delenv("OMNIVOICE_PROMPT_DISK_CACHE", raising=False)
    _tb().clear_clone_prompt_cache()
    yield
    _tb().clear_clone_prompt_cache()


@pytest.fixture()
def ref_wav(tmp_path):
    p = tmp_path / "ref.wav"
    p.write_bytes(b"\x00" * 256)
    return str(p)


def _disk_files(tmp_path):
    d = tmp_path / "data" / "prompt_cache"
    return sorted(d.glob("*.pt")) if d.is_dir() else []


# ── the ported save/load format ─────────────────────────────────────────────


def test_prompt_save_load_roundtrip(tmp_path):
    p = _prompt()
    path = str(tmp_path / "voice.pt")
    p.save(path)
    loaded = _VoiceClonePrompt().load(path)
    assert torch.equal(loaded.ref_audio_tokens, p.ref_audio_tokens)
    assert loaded.ref_text == p.ref_text
    assert loaded.ref_rms == pytest.approx(p.ref_rms)
    # The file must stay loadable under torch's safe default (weights_only=True
    # since 2.6) — a pickled dataclass would not be.
    raw = torch.load(path, weights_only=True)
    assert raw["format_version"] == 1


def test_prompt_load_rejects_unknown_format_version(tmp_path):
    path = str(tmp_path / "future.pt")
    torch.save({"format_version": 999}, path)
    with pytest.raises(ValueError, match="format version"):
        _VoiceClonePrompt().load(path)


def test_saved_tokens_are_cpu_even_from_dataclass_on_another_device(tmp_path):
    # save() must detach+CPU the tokens so the file is portable. On CUDA hosts
    # this exercises the real device move; CI (CPU-only) still verifies the
    # detach and that the persisted payload is CPU-resident.
    device = "cuda" if torch.cuda.is_available() else "cpu"
    p = _VoiceClonePrompt()(
        ref_audio_tokens=torch.zeros(8, 3, requires_grad=True).to(device),
        ref_text="x",
        ref_rms=0.5,
    )
    path = str(tmp_path / "v.pt")
    p.save(path)
    loaded = _VoiceClonePrompt().load(path)
    assert not loaded.ref_audio_tokens.requires_grad
    assert loaded.ref_audio_tokens.device.type == "cpu"
    # The device move must happen at SAVE time (portability of the file
    # itself), not merely at load: the raw payload carries CPU tensors.
    assert torch.load(path, weights_only=True)["ref_audio_tokens"].device.type == "cpu"


# ── the disk layer under the memory cache ───────────────────────────────────


def test_disk_hit_survives_restart(tmp_path, ref_wav):
    tb = _tb()
    model = _StubModel()

    first = tb._get_clone_prompt(model, ref_wav, "hello", True)
    assert model.encodes == 1
    assert len(_disk_files(tmp_path)) == 1

    tb.clear_clone_prompt_cache()  # "restart": memory gone, disk remains
    second = tb._get_clone_prompt(model, ref_wav, "hello", True)
    assert model.encodes == 1, "restart re-encoded despite a persisted prompt"
    assert torch.equal(second.ref_audio_tokens, first.ref_audio_tokens)
    assert second.ref_text == first.ref_text


def test_edited_reference_is_not_served_a_stale_prompt(tmp_path, ref_wav):
    import os

    tb = _tb()
    model = _StubModel()
    tb._get_clone_prompt(model, ref_wav, "hello", True)
    tb.clear_clone_prompt_cache()

    # Same path, new content+mtime → new key → the old file must not match.
    with open(ref_wav, "wb") as f:
        f.write(b"\x01" * 512)
    os.utime(ref_wav, (1, 1))
    tb._get_clone_prompt(model, ref_wav, "hello", True)
    assert model.encodes == 2


def test_single_use_refs_never_touch_disk(tmp_path, ref_wav):
    tb = _tb()
    tb._get_clone_prompt(_StubModel(), ref_wav, "hello", True, store=False)
    assert _disk_files(tmp_path) == [], (
        "store=False (dub per-segment clips) must not spray single-use "
        "prompts onto disk — same scan-resistance as the memory LRU"
    )


def test_env_kill_switch_disables_the_layer(tmp_path, ref_wav, monkeypatch):
    monkeypatch.setenv("OMNIVOICE_PROMPT_DISK_CACHE", "0")
    tb = _tb()
    model = _StubModel()
    tb._get_clone_prompt(model, ref_wav, "hello", True)
    assert _disk_files(tmp_path) == []
    tb.clear_clone_prompt_cache()
    tb._get_clone_prompt(model, ref_wav, "hello", True)
    assert model.encodes == 2  # no disk → honest re-encode


def test_corrupt_disk_entry_is_dropped_and_reencoded(tmp_path, ref_wav):
    tb = _tb()
    model = _StubModel()
    tb._get_clone_prompt(model, ref_wav, "hello", True)
    tb.clear_clone_prompt_cache()

    disk = _disk_files(tmp_path)
    assert len(disk) == 1
    disk[0].write_bytes(b"not a torch file")

    prompt = tb._get_clone_prompt(model, ref_wav, "hello", True)
    assert prompt is not None
    assert model.encodes == 2, "corrupt file must fall back to encoding"
    # ...and the corrupt file was removed, then replaced by the fresh save.
    fresh = _disk_files(tmp_path)
    assert len(fresh) == 1
    assert torch.load(str(fresh[0]), weights_only=True)["format_version"] == 1


def test_prune_keeps_only_the_newest(tmp_path, monkeypatch):
    import os
    import time

    tb = _tb()
    monkeypatch.setattr(tb, "_PROMPT_DISK_CACHE_MAX", 3)
    model = _StubModel()
    refs = []
    for i in range(5):
        p = tmp_path / f"ref{i}.wav"
        p.write_bytes(bytes([i]) * 64)
        os.utime(p, (i + 1, i + 1))
        refs.append(str(p))
    for i, r in enumerate(refs):
        tb._get_clone_prompt(model, r, f"text {i}", True)
        # mtime is the prune order; keep saves strictly ordered even on
        # filesystems with coarse timestamps.
        files = _disk_files(tmp_path)
        newest = max(files, key=lambda f: f.stat().st_mtime)
        os.utime(newest, (1000 + i, 1000 + i))
    assert len(_disk_files(tmp_path)) == 3


def test_unwritable_cache_dir_never_breaks_prompt_building(ref_wav, monkeypatch):
    # Simulate an unwritable data dir: the layer must vanish, not raise.
    monkeypatch.setattr(
        "core.config.DATA_DIR", "/proc/omnivoice-definitely-not-writable"
    )
    tb = _tb()
    model = _StubModel()
    assert tb._get_clone_prompt(model, ref_wav, "hello", True) is not None
    assert model.encodes == 1
