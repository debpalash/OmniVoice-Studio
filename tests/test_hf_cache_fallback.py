"""plan-01 (#128) — HF cache detection must survive scan_cache_dir failures.

On Windows, huggingface_hub's ``scan_cache_dir()`` can raise
``OSError WinError 448 'untrusted mount point'``. The old code caught that and
returned "not cached", so the app re-downloaded models it already had — looping
5× and giving up (#117/#118). These tests force ``scan_cache_dir`` to raise and
assert a direct-filesystem fallback still recognises a cached repo.
"""
from __future__ import annotations

from api.routers.setup import models


def _make_fake_cache(tmp_path, repo_id="k2-fsa/OmniVoice"):
    """Create the canonical HF cache layout for repo_id under tmp_path."""
    name = "models--" + repo_id.replace("/", "--")
    snap = tmp_path / name / "snapshots" / "abc123def456"
    snap.mkdir(parents=True)
    (snap / "model.bin").write_bytes(b"x" * 2048)
    return repo_id


def _raise_winerror(*a, **k):
    raise OSError(22, "[WinError 448] The specified network resource is no longer available")


def test_is_cached_falls_back_to_disk_when_scan_raises(tmp_path, monkeypatch):
    repo = _make_fake_cache(tmp_path)
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr("huggingface_hub.scan_cache_dir", _raise_winerror)
    models.invalidate_cache()
    assert models.is_cached(repo) is True


def test_is_cached_false_for_uncached_repo_when_scan_raises(tmp_path, monkeypatch):
    _make_fake_cache(tmp_path)  # a different repo is present
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr("huggingface_hub.scan_cache_dir", _raise_winerror)
    assert models.is_cached("not-here/model") is False


def test_disk_scan_reports_size_and_files(tmp_path, monkeypatch):
    repo = _make_fake_cache(tmp_path)
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    found = models._scan_cache_on_disk()
    assert repo in found
    assert found[repo]["nb_files"] >= 1
    assert found[repo]["size_on_disk"] >= 2048


def test_hf_home_only_finds_repo_under_hub_subdir(tmp_path, monkeypatch):
    # When only HF_HOME is set, HF stores repos under $HF_HOME/hub/models--…
    # The fallback must probe the /hub subdir, not just the root (CodeRabbit #137).
    repo_id = "k2-fsa/OmniVoice"
    name = "models--" + repo_id.replace("/", "--")
    snap = tmp_path / "hub" / name / "snapshots" / "rev1"
    snap.mkdir(parents=True)
    (snap / "model.bin").write_bytes(b"x" * 1024)
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_CACHE", raising=False)
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    monkeypatch.setattr("huggingface_hub.scan_cache_dir", _raise_winerror)
    models.invalidate_cache()
    assert models.is_cached(repo_id) is True
    assert repo_id in models._scan_cache_on_disk()


def test_empty_snapshot_dir_not_counted_as_cached(tmp_path, monkeypatch):
    # A repo dir with an empty snapshots/<rev>/ (interrupted download) is NOT cached.
    name = "models--org--half"
    (tmp_path / name / "snapshots" / "rev0").mkdir(parents=True)
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr("huggingface_hub.scan_cache_dir", _raise_winerror)
    assert models.is_cached("org/half") is False
