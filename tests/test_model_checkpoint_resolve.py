"""Regression tests for #693 — a leaked engine id ("omnivoice") in
OMNIVOICE_MODEL must not be passed to OmniVoice.from_pretrained() (which 500s
with "omnivoice is not a local folder and is not a valid model identifier").

The resolver self-heals: only a HF repo id (org/repo) or an existing local dir
is honored; anything else falls back to the default.
"""
import pytest

from services.model_manager import (
    resolve_omnivoice_checkpoint,
    _DEFAULT_OMNIVOICE_CHECKPOINT,
)


def _set(monkeypatch, val):
    if val is None:
        monkeypatch.delenv("OMNIVOICE_MODEL", raising=False)
    else:
        monkeypatch.setenv("OMNIVOICE_MODEL", val)


def test_default_when_unset(monkeypatch):
    _set(monkeypatch, None)
    assert resolve_omnivoice_checkpoint() == _DEFAULT_OMNIVOICE_CHECKPOINT


@pytest.mark.parametrize("leaked", ["omnivoice", "voxcpm2", "cosyvoice", "kittentts"])
def test_bare_engine_id_falls_back(monkeypatch, leaked):
    """#693: an engine id (no '/', not a path) must self-heal to the default."""
    _set(monkeypatch, leaked)
    assert resolve_omnivoice_checkpoint() == _DEFAULT_OMNIVOICE_CHECKPOINT


@pytest.mark.parametrize("repo", ["k2-fsa/OmniVoice", "some-org/some-model"])
def test_valid_hf_repo_id_is_kept(monkeypatch, repo):
    _set(monkeypatch, repo)
    assert resolve_omnivoice_checkpoint() == repo


def test_existing_local_dir_is_kept(monkeypatch, tmp_path):
    d = tmp_path / "mymodel"
    d.mkdir()
    _set(monkeypatch, str(d))
    assert resolve_omnivoice_checkpoint() == str(d)


def test_blank_or_whitespace_falls_back(monkeypatch):
    _set(monkeypatch, "   ")
    assert resolve_omnivoice_checkpoint() == _DEFAULT_OMNIVOICE_CHECKPOINT
