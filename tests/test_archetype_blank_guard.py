"""Archetype render must never serve/save a blank clip.

Two layers: every archetype carries a non-empty sample script (empty text
synthesizes to silence), and `_is_blank_audio` flags dead renders so the render
path can retry once and then fail loudly instead of caching/saving silence.
"""
import torch

from api.routers.archetypes import _is_blank_audio
from core import archetypes


def test_is_blank_flags_dead_renders():
    assert _is_blank_audio(torch.zeros(1, 16000)) is True
    assert _is_blank_audio(torch.full((1, 16000), 1e-4)) is True       # noise floor
    assert _is_blank_audio(torch.zeros(0)) is True                     # empty
    assert _is_blank_audio(torch.full((1, 100), float("nan"))) is True  # non-finite


def test_is_blank_passes_real_audio():
    sig = torch.zeros(1, 16000)
    sig[0, ::50] = 0.8  # a normalized clip peaks near -2 dBFS
    assert _is_blank_audio(sig) is False


def test_every_archetype_has_a_nonempty_script():
    items = archetypes.list_archetypes()
    assert items, "expected a non-empty archetype catalog"
    blank = [a["id"] for a in items if not (a.get("sample_script") or "").strip()]
    assert not blank, f"archetypes with empty sample_script: {blank[:10]}"
