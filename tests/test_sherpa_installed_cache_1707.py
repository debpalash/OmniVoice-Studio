"""Sherpa installed-state must follow the catalogue's live cache roots (#1707)."""

from __future__ import annotations

from services import sherpa_dictation


def test_installed_probe_uses_live_hf_cache_root(tmp_path, monkeypatch):
    spec = sherpa_dictation.get_spec("sherpa-whisper-tiny")
    assert spec is not None
    snapshot = (
        tmp_path
        / ("models--" + spec.repo_id.replace("/", "--"))
        / "snapshots"
        / "reviewed-revision"
    )
    snapshot.mkdir(parents=True)
    for filename in spec.files.values():
        target = snapshot / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"model")

    # Simulate huggingface_hub having been imported before Settings restored a
    # different cache.  The old implementation asked snapshot_download(),
    # which could keep consulting its import-time constant instead of this
    # live value.
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr(
        sherpa_dictation,
        "_resolve_model_dir",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError(
            "installed-state must not call snapshot_download"
        )),
    )

    assert sherpa_dictation.is_installed(spec) is True


def test_installed_probe_requires_all_pinned_assets(tmp_path, monkeypatch):
    spec = sherpa_dictation.get_spec("sherpa-whisper-tiny")
    assert spec is not None
    snapshot = (
        tmp_path
        / ("models--" + spec.repo_id.replace("/", "--"))
        / "snapshots"
        / "partial"
    )
    snapshot.mkdir(parents=True)
    first = next(iter(spec.files.values()))
    target = snapshot / first
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"partial")
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))

    assert sherpa_dictation.is_installed(spec) is False
