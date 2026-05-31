"""Designed-voice archetype engine for the Voice Gallery.

This module produces a large catalog of ready-to-use *designed* voices — no
real people, no cloning — built entirely from OmniVoice's own voice-design
taxonomy. Each archetype carries an ``instruct`` string (e.g.
``"female, middle-aged, low pitch, british accent"``) that flows straight into
``OmniVoice.generate(instruct=...)``.

Two tiers (the "hybrid" gallery model):

* **Featured** — ~24 hand-curated archetypes spanning the seven use-case
  categories. Pre-rendered preview WAVs are produced by
  ``scripts/render_demos_omnivoice.py``; until a WAV exists the API renders one
  on demand.
* **Generated** — the full combinatorial space of gender × age × pitch ×
  accent (English) and gender × age × pitch × dialect (Chinese), pruned of
  physically-implausible combinations (no "child + very low pitch"). This is
  several hundred voices — the "Browse all" explorer.

Single source of truth
=======================
The valid token vocabulary lives in ``omnivoice/utils/voice_design.py``. We load
it **by file path** rather than ``import omnivoice...`` because the ``omnivoice``
package ``__init__`` pulls heavy model deps (torch/torchaudio) that aren't
present in test/CI environments — whereas ``voice_design.py`` itself only needs
the stdlib. Building every ``instruct`` *from* that vocabulary guarantees the
engine never emits a token ``_resolve_instruct`` would reject (the issue-#89
crash mode). ``backend/tests/test_archetypes.py`` enforces this independently.

Localization note (CLAUDE.md): the only hardcoded CJK in this file is
``_ZH_SAMPLE`` — functional demo/eval text for previewing dialect voices. The
Chinese *dialect tokens themselves* are loaded dynamically from the taxonomy,
never hardcoded here. ``_ZH_SAMPLE`` is registered in the
``test_no_hardcoded_cjk.py`` allowlist with this justification.
"""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path

# ── Load the taxonomy vocabulary (single source of truth, no torch) ───────────
_VD_PATH = Path(__file__).resolve().parents[2] / "omnivoice" / "utils" / "voice_design.py"


def _load_vocab():
    """Load voice_design.py by file path, bypassing the heavy package __init__."""
    try:
        spec = importlib.util.spec_from_file_location("_ov_voice_design", _VD_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except FileNotFoundError:  # packaged layout — fall back to the real package
        from omnivoice.utils import voice_design as mod  # type: ignore
        return mod


_VD = _load_vocab()
_CAT = _VD._INSTRUCT_CATEGORIES  # [gender, age, pitch, whisper, accents, dialects]

# Position guards: a reordering of the upstream taxonomy should fail loudly here
# rather than silently producing garbage instruct strings.
assert "male" in _CAT[0] and "female" in _CAT[0], "gender category moved"
assert "child" in _CAT[1] and "elderly" in _CAT[1], "age category moved"
assert "moderate pitch" in _CAT[2], "pitch category moved"
assert "whisper" in _CAT[3], "style/whisper category moved"
assert "british accent" in _CAT[4], "accent category moved"

_ZH_RE = _VD._ZH_RE


def _is_en(token: str) -> bool:
    return not _ZH_RE.search(token)


# Ordered English token lists (dict insertion order is meaningful in py3.7+).
_GENDERS = [k for k in _CAT[0] if _is_en(k)]          # male, female
_AGES = [k for k in _CAT[1] if _is_en(k)]             # child … elderly
_PITCHES = [k for k in _CAT[2] if _is_en(k)]          # very low … very high pitch
_ACCENTS_SORTED = sorted(_CAT[4])                     # 10 English accents
_DIALECTS_SORTED = sorted(_CAT[5])                    # 12 Chinese dialects


# ── Use-case categories (replaces the named-real-person buckets) ──────────────
USE_CASES = [
    {"id": "narration", "name": "Narration & Story", "icon": "📖"},
    {"id": "conversational", "name": "Conversational", "icon": "💬"},
    {"id": "characters", "name": "Characters & Animation", "icon": "🎭"},
    {"id": "social", "name": "Social Media", "icon": "📱"},
    {"id": "entertainment", "name": "Entertainment & TV", "icon": "📺"},
    {"id": "advertisement", "name": "Advertisement", "icon": "📣"},
    {"id": "informative", "name": "Informative & Educational", "icon": "🎓"},
]
_USE_ICON = {c["id"]: c["icon"] for c in USE_CASES}


def categories():
    """Return the seven use-case categories (id, name, icon)."""
    return [dict(c) for c in USE_CASES]


# ── Sample preview scripts ────────────────────────────────────────────────────
_SCRIPTS = {
    "narration": (
        "The valley had been quiet for a hundred years, and tonight, for the "
        "first time, something stirred beneath the old stone bridge."
    ),
    "conversational": (
        "Oh hey, I didn't expect to run into you here! How have you been? "
        "We should really catch up properly one of these days."
    ),
    "characters": (
        "You think you can stop me? Ha! I have crossed oceans of time and "
        "bent whole kingdoms to my will."
    ),
    "social": (
        "What is up, everyone, welcome back to the channel! Today we are "
        "trying something I have honestly never done before."
    ),
    "entertainment": (
        "Good evening, and welcome. Tonight's top story is one you will not "
        "want to miss, so stay right there — we'll be back after this."
    ),
    "advertisement": (
        "Introducing a whole new way to get more done in less time. "
        "Available today. Your best work starts right now."
    ),
    "informative": (
        "Let's break this down simply. There are three things you need to "
        "know, and the very first one surprises most people."
    ),
}
# Functional demo/eval text for previewing Chinese-dialect voices (allowlisted).
_ZH_SAMPLE = "大家好，欢迎来到这个声音示范，希望你会喜欢这一段简单的朗读。"


# ── Plausibility pruning ──────────────────────────────────────────────────────
_PRUNE = {
    "child": {"very low pitch", "low pitch"},
    "teenager": {"very low pitch"},
    "elderly": {"very high pitch"},
}


def _pruned(age: str, pitch: str) -> bool:
    return pitch in _PRUNE.get(age, ())


def _whisper_ok(age: str, pitch: str) -> bool:
    return age in {"young adult", "middle-aged", "elderly"} and pitch in {"low pitch", "moderate pitch"}


# ── Heuristic use-case assignment from facets ─────────────────────────────────
def _use_case(age: str, pitch: str, accent, whisper: bool) -> str:
    if whisper:
        return "narration"
    if age in ("child", "teenager"):
        return "characters"
    if pitch == "very high pitch":
        return "characters"
    if pitch in ("very low pitch", "low pitch") and age in ("middle-aged", "elderly"):
        return "narration"
    if pitch in ("high pitch", "very high pitch") and age == "young adult":
        return "social"
    if accent is None and age == "middle-aged" and pitch == "moderate pitch":
        return "informative"
    if age == "young adult":
        return "conversational"
    if age == "elderly":
        return "entertainment"
    if age == "middle-aged":
        return "advertisement"
    return "conversational"


# ── Display-label helpers ─────────────────────────────────────────────────────
def _accent_label(accent: str) -> str:
    return accent.replace(" accent", "").title()


def _age_label(age) -> str | None:
    return age.title() if age else None


def _pitch_label(pitch) -> str | None:
    return pitch.replace(" pitch", "").title() if pitch else None


def _auto_name(gender, age, pitch, accent, dialect, whisper: bool) -> str:
    loc = _accent_label(accent) if accent else (dialect if dialect else "Neutral")
    parts = [loc, gender.title() if gender else None, _age_label(age), _pitch_label(pitch)]
    name = " · ".join(p for p in parts if p)
    if whisper:
        name += " · Whisper"
    return name


# ── Archetype builder ─────────────────────────────────────────────────────────
def _build(gender, age, pitch, *, accent=None, dialect=None, whisper=False,
           use_case, name, icon, language, script=None, featured=False,
           fid=None, preview_url=None):
    toks = []
    if gender:
        toks.append(gender)
    if age:
        toks.append(age)
    if pitch:
        toks.append(pitch)
    if whisper:
        toks.append("whisper")
    if accent:
        toks.append(accent)
    if dialect:
        toks.append(dialect)
    instruct = ", ".join(toks)

    if script is None:
        script = _ZH_SAMPLE if language == "Chinese" else _SCRIPTS.get(use_case, "")

    if featured:
        aid = fid
    else:
        # Deterministic archetype id, not a security digest. SHA-256 (not
        # SHA-1) to avoid the SAST weak-hash flag.
        aid = "a_" + hashlib.sha256(
            f"{instruct}|{language}".encode("utf-8")
        ).hexdigest()[:10]

    return {
        "id": aid,
        "name": name,
        "icon": icon,
        "use_case": use_case,
        "instruct": instruct,
        "attrs": {
            "Gender": gender or "Auto",
            "Age": age or "Auto",
            "Pitch": pitch or "Auto",
            "Style": "whisper" if whisper else "Auto",
            "EnglishAccent": accent or "Auto",
            "ChineseDialect": dialect or "Auto",
        },
        "facets": {
            "gender": gender,
            "age": age,
            "pitch": pitch,
            "accent": accent,
            "whisper": whisper,
            "lang": language,
        },
        "sample_script": script,
        "preview_url": preview_url,
        "is_featured": featured,
        "language": language,
    }


# ── Featured: ~24 curated archetypes across the seven use-cases ───────────────
# (gender, age, pitch, accent, whisper, use_case, name, icon)
_FEATURED_SPEC = [
    # Narration & Story
    ("female", "middle-aged", "low pitch", "british accent", False, "narration", "The Librarian", "📚"),
    ("male", "middle-aged", "low pitch", "american accent", False, "narration", "The Documentarian", "🎙️"),
    ("female", "middle-aged", "low pitch", None, True, "narration", "The Calm Guide", "🌙"),
    ("male", "elderly", "low pitch", "british accent", False, "narration", "The Storyteller", "🧙"),
    # Conversational
    ("female", "young adult", "moderate pitch", "american accent", False, "conversational", "The Neighbor", "😊"),
    ("female", "young adult", "moderate pitch", "indian accent", False, "conversational", "The Helpdesk", "🎧"),
    ("male", "young adult", "moderate pitch", "australian accent", False, "conversational", "The Mate", "🙂"),
    ("female", "middle-aged", "moderate pitch", "canadian accent", False, "conversational", "The Companion", "☕"),
    # Characters & Animation
    ("male", "elderly", "very low pitch", None, False, "characters", "Captain Crusty", "☠️"),
    (None, "teenager", "high pitch", None, False, "characters", "Junior Quacks", "🦆"),
    ("male", "young adult", "high pitch", "american accent", False, "characters", "The Champion", "🦸"),
    ("female", "child", "very high pitch", None, False, "characters", "The Pixie", "🧚"),
    ("male", "middle-aged", "very low pitch", None, False, "characters", "The Ogre", "👹"),
    # Social Media
    ("female", "young adult", "high pitch", "australian accent", False, "social", "The Podcaster", "🎤"),
    ("male", "young adult", "very high pitch", "american accent", False, "social", "The Hype Host", "⚡"),
    ("female", "young adult", "high pitch", None, False, "social", "The Vlogger", "📱"),
    # Entertainment & TV
    ("male", "middle-aged", "moderate pitch", "american accent", False, "entertainment", "The Anchor", "📺"),
    ("male", "middle-aged", "high pitch", "british accent", False, "entertainment", "The Commentator", "🏟️"),
    ("male", "middle-aged", "moderate pitch", None, False, "entertainment", "The Game Host", "🎬"),
    # Advertisement
    ("male", "middle-aged", "low pitch", None, False, "advertisement", "The Promo Voice", "📣"),
    ("female", "middle-aged", "moderate pitch", "british accent", False, "advertisement", "The Luxe", "💎"),
    ("female", "young adult", "high pitch", "american accent", False, "advertisement", "The Upbeat", "✨"),
    # Informative & Educational
    ("female", "middle-aged", "moderate pitch", "american accent", False, "informative", "The Teacher", "👩‍🏫"),
    ("male", "young adult", "moderate pitch", "british accent", False, "informative", "The Explainer", "💡"),
]


def _make_featured():
    out = []
    for i, (gender, age, pitch, accent, whisper, uc, name, icon) in enumerate(_FEATURED_SPEC):
        slug = name.lower().replace(" ", "_").replace("'", "")
        out.append(_build(
            gender, age, pitch, accent=accent, whisper=whisper,
            use_case=uc, name=name, icon=icon, language="English",
            featured=True, fid=f"feat_{i:02d}_{slug}",
        ))
    return out


_FEATURED = _make_featured()
_FEATURED_KEYS = {(a["instruct"], a["language"]) for a in _FEATURED}


# ── Generated: the full pruned combinatorial catalog ──────────────────────────
def generate_archetypes():
    """Return the deterministic, pruned set of generated (non-featured) archetypes."""
    out = []
    seen = set(_FEATURED_KEYS)

    # English: gender × age × pitch × {neutral + accents}, plus whisper variants.
    for gender in _GENDERS:
        for age in _AGES:
            for pitch in _PITCHES:
                if _pruned(age, pitch):
                    continue
                for accent in [None] + _ACCENTS_SORTED:
                    uc = _use_case(age, pitch, accent, False)
                    a = _build(
                        gender, age, pitch, accent=accent,
                        use_case=uc, icon=_USE_ICON[uc], language="English",
                        name=_auto_name(gender, age, pitch, accent, None, False),
                    )
                    key = (a["instruct"], "English")
                    if key not in seen:
                        seen.add(key)
                        out.append(a)
                    if _whisper_ok(age, pitch):
                        wa = _build(
                            gender, age, pitch, accent=accent, whisper=True,
                            use_case="narration", icon=_USE_ICON["narration"],
                            language="English",
                            name=_auto_name(gender, age, pitch, accent, None, True),
                        )
                        wkey = (wa["instruct"], "English")
                        if wkey not in seen:
                            seen.add(wkey)
                            out.append(wa)

    # Chinese: gender × age × pitch × dialect.
    for gender in _GENDERS:
        for age in _AGES:
            for pitch in _PITCHES:
                if _pruned(age, pitch):
                    continue
                for dialect in _DIALECTS_SORTED:
                    uc = _use_case(age, pitch, None, False)
                    a = _build(
                        gender, age, pitch, dialect=dialect,
                        use_case=uc, icon=_USE_ICON[uc], language="Chinese",
                        name=_auto_name(gender, age, pitch, None, dialect, False),
                    )
                    key = (a["instruct"], "Chinese")
                    if key not in seen:
                        seen.add(key)
                        out.append(a)

    return out


_GENERATED = generate_archetypes()
_ALL = _FEATURED + _GENERATED
_BY_ID = {a["id"]: a for a in _ALL}


# ── Public query API ──────────────────────────────────────────────────────────
def list_archetypes(use_case=None, gender=None, age=None, pitch=None, accent=None,
                    whisper=None, lang=None, featured=None, limit=None, offset=0):
    """Filtered view over the full catalog (featured + generated)."""
    items = _ALL
    if featured is not None:
        items = [a for a in items if a["is_featured"] is featured]
    if use_case:
        items = [a for a in items if a["use_case"] == use_case]
    if gender:
        items = [a for a in items if a["facets"]["gender"] == gender]
    if age:
        items = [a for a in items if a["facets"]["age"] == age]
    if pitch:
        items = [a for a in items if a["facets"]["pitch"] == pitch]
    if accent:
        items = [a for a in items if a["facets"]["accent"] == accent]
    if whisper is not None:
        items = [a for a in items if a["facets"]["whisper"] is whisper]
    if lang:
        items = [a for a in items if a["language"] == lang]
    if offset:
        items = items[offset:]
    if limit is not None:
        items = items[:limit]
    return items


def get_archetype(archetype_id: str):
    """Look up a single archetype by id, or None."""
    return _BY_ID.get(archetype_id)


def count() -> int:
    return len(_ALL)
