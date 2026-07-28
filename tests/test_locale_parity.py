"""Locale key parity — all 21 i18n files stay in lockstep with en.json.

Replaces the manual locale sweeps: CLAUDE.md's Localization rule routes every
UI string through ``frontend/src/i18n/locales/*.json``, which only works if
every file parses, carries no keys en.json doesn't have, and preserves en's
``{{placeholder}}`` tokens. Real bug classes this pins down:

* a translation that drops ``{{message}}`` shows users a bare error with the
  detail silently lost (six ``gallery.*`` keys drifted this way in all 20
  translations before this test existed);
* a machine-translation pass that mangles the token itself renders it
  literally in the UI (vi.json shipped 31 strings saying ``_V_0__``, and
  ar.json once translated ``{{n}}`` into Arabic);
* a key added to en.json only falls back to English for every other language.

Missing keys degrade gracefully (i18next falls back to en), so full key parity
is enforced as a RATCHET: each locale's missing-key count may only go down.
When en.json gains keys, add them to all 21 locales in the same change — that
is exactly the house rule this test automates.
"""

import json
import os
import re
import warnings

import pytest

_LOCALES_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "frontend", "src", "i18n", "locales",
)
_EN = "en"

_PLACEHOLDER = re.compile(r"\{\{\s*(\w+)\s*\}\}")

# Corruption tokens a broken machine-translation pass leaves behind in place
# of a real {{placeholder}} — seen in the wild: vi.json's `_V_0__` (31 keys)
# and ar.json's `__الخامس_0__` ("{{n}}" with the V literally translated).
_CORRUPTED_TOKEN = re.compile(r"_V_\d+__|__\w+_\d+__")

# Keys whose value may legitimately be nothing but placeholders + punctuation.
# Keep this list tiny: each entry is a string no translator can influence.
_PLACEHOLDER_ONLY_ALLOWLIST = {
    # en: "{{family}} → {{engine}}" — the engine-switch success toast is a bare
    # "TTS → omnivoice" confirmation by design. There is no sentence here to
    # translate, and inventing one would make a quiet confirmation shouty.
    "settings.engine_switched",
}

# Keys whose translations may deliberately omit en's placeholders.
_PLACEHOLDER_ALLOWLIST = {
    # en: "Switch to {{lang}}?" — each locale bakes its own language name into
    # the prompt (de: "Auf Deutsch umstellen?"), because the string is always
    # shown in the language it offers to switch to. Interpolating an English
    # language name there would be worse, not better.
    "bootstrap.suggest_lang",
}

# Missing-key ratchet: highest allowed number of en.json keys absent from each
# locale. Counts may only go DOWN — translate keys and tighten the number.
# Never raise one: if this fails after adding en.json keys, add the keys to
# every locale (translated) in the same change instead.
_MISSING_BASELINE = {
    "ar": 517, "de": 517, "es": 517, "fr": 517, "hi": 517, "id": 517,
    "it": 517, "ja": 517, "ko": 517, "nl": 517, "pl": 517, "pt": 517,
    "ru": 517, "sv": 517, "th": 517, "tr": 517, "uk": 517, "vi": 517,
    "zh-CN": 510, "zh-TW": 517,
}


def _locale_files():
    return sorted(f for f in os.listdir(_LOCALES_DIR) if f.endswith(".json"))


def _no_duplicates_hook(pairs):
    seen = {}
    for k, v in pairs:
        if k in seen:
            raise ValueError(f"duplicate key {k!r}")
        seen[k] = v
    return seen


def _load(name):
    path = os.path.join(_LOCALES_DIR, f"{name}.json")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh, object_pairs_hook=_no_duplicates_hook)


def _flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.update(_flatten(v, key))
        else:
            out[key] = v
    return out


_LOCALES = [f[:-5] for f in _locale_files()]
_OTHERS = [loc for loc in _LOCALES if loc != _EN]


def test_locale_inventory_matches_baseline():
    """Every locale is ratcheted; a new locale must be added to the baseline
    (and fully translated), a removed one must be dropped from it."""
    assert _EN in _LOCALES, f"en.json missing from {_LOCALES_DIR}"
    assert set(_OTHERS) == set(_MISSING_BASELINE), (
        "Locale files and _MISSING_BASELINE disagree: "
        f"unlisted={sorted(set(_OTHERS) - set(_MISSING_BASELINE))} "
        f"stale={sorted(set(_MISSING_BASELINE) - set(_OTHERS))}"
    )


@pytest.mark.parametrize("locale", _LOCALES)
def test_locale_parses_without_duplicate_keys(locale):
    data = _load(locale)  # raises on invalid JSON or duplicate keys
    assert isinstance(data, dict) and data, f"{locale}.json must be a non-empty object"


@pytest.mark.parametrize("locale", _OTHERS)
def test_no_keys_beyond_en(locale):
    """A key that only exists in a translation is dead weight (nothing renders
    it) and usually means a rename that missed en.json."""
    extra = sorted(set(_flatten(_load(locale))) - set(_flatten(_load(_EN))))
    assert not extra, (
        f"{locale}.json has {len(extra)} key(s) that do not exist in en.json "
        f"(en.json is the source of truth — rename or remove them): {extra[:20]}"
    )


@pytest.mark.parametrize("locale", _OTHERS)
def test_missing_keys_ratchet(locale):
    missing = sorted(set(_flatten(_load(_EN))) - set(_flatten(_load(locale))))
    allowed = _MISSING_BASELINE[locale]
    assert len(missing) <= allowed, (
        f"{locale}.json is missing {len(missing)} en.json keys — the ratchet "
        f"allows at most {allowed}. New en.json keys must land in all 21 "
        f"locales (translated) in the same change (CLAUDE.md, Localization). "
        f"Newly missing keys include: {missing[:20]}"
    )
    if len(missing) < allowed:
        # An improvement must never fail CI (CodeRabbit review, #1198) — but
        # the gain should be locked in, so nudge loudly without blocking.
        warnings.warn(
            f"{locale}.json now misses only {len(missing)} keys (baseline "
            f"{allowed}) — tighten _MISSING_BASELINE['{locale}'] to "
            f"{len(missing)} so the ratchet holds the gain.",
            stacklevel=1,
        )


@pytest.mark.parametrize("locale", _OTHERS)
def test_placeholders_match_en(locale):
    """For every shared key, the translation must use exactly en's
    {{placeholders}} — a dropped one loses runtime data on screen, an invented
    one renders literally."""
    en = _flatten(_load(_EN))
    loc = _flatten(_load(locale))
    problems = []
    for key in sorted(set(en) & set(loc)):
        if not (isinstance(en[key], str) and isinstance(loc[key], str)):
            continue
        want = set(_PLACEHOLDER.findall(en[key]))
        got = set(_PLACEHOLDER.findall(loc[key]))
        invented = got - want
        dropped = want - got
        if key in _PLACEHOLDER_ALLOWLIST:
            invented = set()
            dropped = set()
        # i18next plural forms: "one line" / singular phrasings idiomatically
        # omit the count in many languages — allow {{count}} to be dropped in
        # explicit singular/zero forms only.
        if key.rsplit(".", 1)[-1].endswith(("_one", "_zero")):
            dropped -= {"count"}
        if invented or dropped:
            problems.append(
                f"  {key}: en={en[key]!r} vs {locale}={loc[key]!r}"
                + (f" (missing {sorted(dropped)})" if dropped else "")
                + (f" (not in en: {sorted(invented)})" if invented else "")
            )
    assert not problems, (
        f"{locale}.json placeholder drift against en.json "
        f"({len(problems)} key(s)):\n" + "\n".join(problems[:25])
    )


@pytest.mark.parametrize("locale", _LOCALES)
def test_no_placeholder_only_values(locale):
    """A value made of nothing but {{placeholders}} and punctuation is not a
    translation — it is a missing string.

    #1280 shipped ``engines.selectWithCaveat`` as ``"{{engine}}: {{reason}}"``
    in all 21 files. The review read that as 20 untranslated locales, but
    en.json said the same thing: the English string had never been written, so
    every "translation" faithfully copied a non-sentence. Users in all 21
    languages would have seen a bare ``omnivoice: <English backend text>``.

    Parity tests cannot catch this — the key is present everywhere and the
    placeholders match perfectly. Only the absence of prose gives it away, and
    en.json is checked too because that is where this one started.
    """
    bad = []
    for key, value in sorted(_flatten(_load(locale)).items()):
        if not isinstance(value, str) or key in _PLACEHOLDER_ONLY_ALLOWLIST:
            continue
        if not _PLACEHOLDER.search(value):
            continue
        # \w is unicode-aware: CJK, Thai, Devanagari and Arabic all count as
        # prose, so a real translation never trips this.
        if not re.search(r"\w", _PLACEHOLDER.sub("", value)):
            bad.append(f"  {key}: {value!r}")
    assert not bad, (
        f"{locale}.json has {len(bad)} placeholder-only value(s) — write the "
        f"sentence around the placeholders (in en.json first, then translate "
        f"it), or allowlist the key in _PLACEHOLDER_ONLY_ALLOWLIST with a "
        f"reason:\n" + "\n".join(bad[:25])
    )


@pytest.mark.parametrize("locale", _LOCALES)
def test_no_corrupted_placeholder_tokens(locale):
    """Guard the whole class of the vi.json incident: a translation pass that
    rewrites `{{count}}` into `_V_0__` (or similar) ships the garbage token
    straight to the UI, even on keys whose en value has no placeholder."""
    bad = [
        f"  {key}: {value!r}"
        for key, value in sorted(_flatten(_load(locale)).items())
        if isinstance(value, str) and _CORRUPTED_TOKEN.search(value)
    ]
    assert not bad, (
        f"{locale}.json contains corrupted placeholder tokens "
        f"(restore the real {{{{name}}}} from en.json):\n" + "\n".join(bad[:25])
    )
