"""Contract tests for the designed-voice archetype engine (``core.archetypes``).

The archetype engine generates hundreds of ready-to-use *designed* voices for
the Voice Gallery. Every archetype carries an ``instruct`` string that flows
into ``OmniVoice.generate(instruct=...)``. That call runs the string through
``_resolve_instruct``, which rejects any token outside the fixed taxonomy
vocabulary with ``ValueError`` — the exact failure mode that made issue #89
crash synthesis when a personality shipped prose instead of valid tokens.

So the load-bearing guarantee these tests enforce is: **every instruct the
engine emits is composed only of valid taxonomy tokens, with at most one token
per mutually-exclusive category, and never mixes an English accent with a
Chinese dialect.** If a future change reintroduces an invalid token, these
tests fail before it can crash a user's synthesize call.

The vocabulary is loaded *independently* here — directly from
``omnivoice/utils/voice_design.py`` by file path (bypassing the heavy
``omnivoice`` package ``__init__`` that pulls torch) — so the test validates
against the real source of truth rather than the engine's own copy.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from core import archetypes  # noqa: E402


# ── Load the canonical taxonomy vocabulary independently ──────────────────────
_VD_PATH = Path(__file__).resolve().parents[2] / "omnivoice" / "utils" / "voice_design.py"


def _load_vocab():
    spec = importlib.util.spec_from_file_location("_ov_voice_design_test", _VD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_VD = _load_vocab()
_VALID_TOKENS = set(_VD._INSTRUCT_ALL_VALID)
_CATEGORIES = _VD._INSTRUCT_MUTUALLY_EXCLUSIVE  # list[set] — one set per exclusive category
_ACCENTS = _CATEGORIES[-2]
_DIALECTS = _CATEGORIES[-1]


def _tokens(instruct: str) -> list[str]:
    return [t.strip() for t in instruct.split(",") if t.strip()]


# ── Fixtures: the full generated catalog ──────────────────────────────────────
ALL = archetypes.list_archetypes()  # featured + generated, no filter


# ── (a) Every instruct uses only valid tokens, one per exclusive category ─────
def test_every_instruct_token_is_valid_taxonomy():
    for a in ALL:
        for tok in _tokens(a["instruct"]):
            assert tok in _VALID_TOKENS, (
                f"archetype {a['id']!r} emits invalid instruct token {tok!r} "
                f"(instruct={a['instruct']!r}) — would crash synthesis"
            )


def test_instruct_has_at_most_one_token_per_exclusive_category():
    for a in ALL:
        toks = set(_tokens(a["instruct"]))
        for cat in _CATEGORIES:
            picked = toks & cat
            assert len(picked) <= 1, (
                f"archetype {a['id']!r} picks {picked} from one mutually-exclusive "
                f"category — instruct={a['instruct']!r}"
            )


# ── (b) Accent (EN-only) and dialect (ZH-only) never co-occur ─────────────────
def test_accent_and_dialect_never_combined():
    for a in ALL:
        toks = set(_tokens(a["instruct"]))
        assert not (toks & _ACCENTS and toks & _DIALECTS), (
            f"archetype {a['id']!r} mixes an English accent with a Chinese "
            f"dialect — instruct={a['instruct']!r}"
        )


# ── (c) The catalog is genuinely in the hundreds ──────────────────────────────
def test_catalog_reaches_hundreds():
    generated = archetypes.generate_archetypes()
    assert len(generated) >= 250, (
        f"expected hundreds of generated archetypes, got {len(generated)}"
    )


# ── (d) Implausible demographic/pitch combos are pruned ───────────────────────
def test_implausible_combos_are_pruned():
    for a in ALL:
        toks = set(_tokens(a["instruct"]))
        assert not ({"child", "very low pitch"} <= toks), (
            f"{a['id']!r}: child + very low pitch is implausible"
        )
        assert not ({"elderly", "very high pitch"} <= toks), (
            f"{a['id']!r}: elderly + very high pitch is implausible"
        )


# ── (e) IDs are unique and stable across runs ─────────────────────────────────
def test_ids_unique():
    ids = [a["id"] for a in ALL]
    assert len(ids) == len(set(ids)), "archetype ids must be unique"


def test_ids_stable_across_calls():
    first = [a["id"] for a in archetypes.generate_archetypes()]
    second = [a["id"] for a in archetypes.generate_archetypes()]
    assert first == second, "generated archetype ids must be deterministic"


# ── (f) Featured archetypes are curated, valid, and complete ──────────────────
def test_featured_are_valid_and_complete():
    featured = archetypes.list_archetypes(featured=True)
    assert len(featured) >= 12, "expected a curated featured set of ~24"
    use_case_ids = {c["id"] for c in archetypes.categories()}
    for a in featured:
        assert a["is_featured"] is True
        assert a["use_case"] in use_case_ids, f"{a['id']} has unknown use_case {a['use_case']!r}"
        assert a["sample_script"].strip(), f"{a['id']} missing sample_script"
        for tok in _tokens(a["instruct"]):
            assert tok in _VALID_TOKENS, f"featured {a['id']} invalid token {tok!r}"


# ── (g) Categories are the seven use-cases ────────────────────────────────────
def test_categories_are_the_seven_use_cases():
    ids = {c["id"] for c in archetypes.categories()}
    assert ids == {
        "narration", "conversational", "characters",
        "social", "entertainment", "advertisement", "informative",
    }
    for c in archetypes.categories():
        assert c["name"] and c["icon"], f"category {c['id']} missing name/icon"


# ── (h) Filters work ──────────────────────────────────────────────────────────
def test_filter_by_gender():
    res = archetypes.list_archetypes(gender="female")
    assert res, "expected female archetypes"
    assert all(a["facets"]["gender"] == "female" for a in res)


def test_filter_by_use_case():
    res = archetypes.list_archetypes(use_case="narration")
    assert res, "expected narration archetypes"
    assert all(a["use_case"] == "narration" for a in res)


def test_filter_by_language_chinese():
    res = archetypes.list_archetypes(lang="Chinese")
    assert res, "expected Chinese-dialect archetypes"
    assert all(a["language"] == "Chinese" for a in res)
    # Chinese archetypes carry a dialect token, never an English accent
    for a in res:
        toks = set(_tokens(a["instruct"]))
        assert not (toks & _ACCENTS)


def test_filter_by_accent():
    res = archetypes.list_archetypes(accent="british accent")
    assert res, "expected british-accent archetypes"
    assert all("british accent" in a["instruct"] for a in res)


# ── (h2) Multilingual designed voices ship beyond English + Chinese ───────────
_ML_LANGS = {
    "Spanish", "French", "German", "Italian", "Portuguese",
    "Russian", "Hindi", "Japanese", "Korean",
}


def test_multilingual_featured_languages_present():
    featured_langs = {a["language"] for a in archetypes.list_archetypes(featured=True)}
    missing = _ML_LANGS - featured_langs
    assert not missing, f"missing curated multilingual languages: {missing}"


def test_multilingual_archetypes_are_neutral_timbre_with_valid_tokens():
    # A designed voice's spoken language is the preview text, not the instruct —
    # so these carry no English-accent / Chinese-dialect token, only the
    # universal gender/age/pitch axes that exist in every language.
    for lang in _ML_LANGS:
        res = archetypes.list_archetypes(lang=lang)
        assert res, f"no archetypes for language {lang!r}"
        for a in res:
            assert a["language"] == lang
            assert a["sample_script"].strip(), f"{a['id']} missing sample_script"
            toks = set(_tokens(a["instruct"]))
            assert toks, f"{a['id']} has empty instruct"
            assert all(t in _VALID_TOKENS for t in toks), (
                f"{a['id']} emits invalid token (instruct={a['instruct']!r})"
            )
            assert not (toks & _ACCENTS), f"{a['id']} should carry no English accent"
            assert not (toks & _DIALECTS), f"{a['id']} should carry no Chinese dialect"


# ── (i) Lookup by id ──────────────────────────────────────────────────────────
def test_get_archetype_roundtrip():
    sample = ALL[0]
    assert archetypes.get_archetype(sample["id"]) == sample


def test_get_archetype_missing_returns_none():
    assert archetypes.get_archetype("does-not-exist-xyz") is None
