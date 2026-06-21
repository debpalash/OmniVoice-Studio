"""Unit tests for the design-instruct sanitizer/healer (#550 #571 #594 #596).

These guard the forgiving path used for *stored* design-profile instructs:
unlike ``_resolve_instruct`` (which raises so the Generate tab can flag typos),
``sanitize_instruct`` / ``heal_design_instruct`` must never raise and must
strip poison ("[object Object]", freeform prose) down to whitelist tags,
recovering a design from ``vd_states`` when the stored value is unusable.
"""
import json

import pytest

from omnivoice.utils.voice_design import (
    sanitize_instruct,
    instruct_from_vd_states,
    heal_design_instruct,
)


def test_sanitize_drops_object_object_sentinel():
    assert sanitize_instruct("[object Object]") == ""


def test_sanitize_drops_freeform_prose():
    prose = "A gentle, quiet, and calm male voice is suitable for podcast content"
    # Comma-split phrases are never standalone whitelist tags, so the whole
    # prose is dropped — crucially, the "male" buried in a phrase does NOT leak
    # as a gender tag (that's what makes #594's female recover correctly).
    assert sanitize_instruct(prose) == ""


def test_sanitize_extracts_only_standalone_tags_from_mixed_input():
    # A real standalone tag among prose items survives; the prose item doesn't.
    assert sanitize_instruct("female, calm soothing narrator, high pitch") == (
        "female, high pitch"
    )


def test_sanitize_keeps_valid_tags_unchanged():
    assert sanitize_instruct("female, high pitch, british accent") == (
        "female, high pitch, british accent"
    )


def test_sanitize_dedupes_by_category():
    # male+female are the same (gender) category — first wins.
    assert sanitize_instruct("male, female") == "male"
    assert sanitize_instruct("high pitch, low pitch") == "high pitch"


def test_sanitize_normalises_case_and_blank_items():
    assert sanitize_instruct("  FEMALE , , british accent ") == "female, british accent"


@pytest.mark.parametrize("bad", [None, "", "   ", "[object Object]"])
def test_sanitize_handles_empty_and_poison(bad):
    assert sanitize_instruct(bad) == ""


def test_instruct_from_vd_states_dict_drops_auto():
    vd = {"gender": "female", "age": "Auto", "pitch": "high pitch", "accent": "british accent"}
    assert instruct_from_vd_states(vd) == "female, high pitch, british accent"


def test_instruct_from_vd_states_json_string():
    vd = json.dumps({"gender": "male", "pitch": "low pitch"})
    assert instruct_from_vd_states(vd) == "male, low pitch"


@pytest.mark.parametrize("bad", [None, "", "not json", "[1,2,3]"])
def test_instruct_from_vd_states_unparseable(bad):
    assert instruct_from_vd_states(bad) == ""


def test_heal_recovers_gender_from_vd_states_when_poisoned():
    # The #594 case: a designed FEMALE voice whose instruct got object-coerced
    # must render female again, not the engine's male default.
    vd = json.dumps({"gender": "female", "age": "young adult", "pitch": "high pitch"})
    assert heal_design_instruct("[object Object]", vd) == "female, young adult, high pitch"


def test_heal_recovers_from_vd_states_when_prose():
    vd = json.dumps({"gender": "female"})
    assert heal_design_instruct("A calm soothing narrator", vd) == "female"


def test_heal_prefers_valid_stored_tags_over_vd_states():
    # A hand-typed valid tag not present in vd_states must survive.
    vd = json.dumps({"gender": "female"})
    assert heal_design_instruct("male, british accent", vd) == "male, british accent"


def test_heal_clone_profile_without_vd_states_just_sanitizes():
    assert heal_design_instruct("[object Object]", None) == ""
    assert heal_design_instruct("female", None) == "female"
