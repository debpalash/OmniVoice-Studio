"""The dictation model picker must not lie about download size.

Every one of the seven `size_gb` values was wrong, and — unusually — in both
directions, which is worse than being uniformly optimistic:

  * the two 0.6B Parakeets under-reported by ~3.8x (0.18 -> 0.67 GB). The
    recommended default therefore downloaded four times what the picker
    promised, which matters on a metered connection or a small SSD.
  * the two small zipformers OVER-reported by ~3x (0.128 -> 0.044 GB). Those
    are the low-RAM fallbacks — the models a user drops to when the 0.6B one
    is too heavy for their machine — and they were advertised as bulkier than
    they are, discouraging exactly the choice that would have helped.

`test_declared_sizes_match_the_published_repos` is the real check: it sums the
pinned files from the HuggingFace tree API and compares. It needs the network,
so it is opt-in via RUN_NETWORK_TESTS=1 and skipped in ordinary CI. The offline
tests below hold the line without it — they encode the measurement taken on
2026-08-07 so a hand-edit or a stale copy-paste fails locally and in CI.

Re-measure with:

    RUN_NETWORK_TESTS=1 uv run pytest tests/test_sherpa_model_sizes.py -q
"""
import importlib
import json
import os
import sys
import urllib.request

import pytest

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"
))


@pytest.fixture
def sd():
    """Resolve `services.sherpa_dictation` per test, never at collection.

    Other suites stub `builtins.__import__` to exercise import fallbacks, which
    rebinds the module in `sys.modules`. A module-level import would leave this
    file holding a stale copy — monkeypatches would land on an object nothing
    under test consults, and the tests would pass alone while silently going
    vacuous in the full run (CodeRabbit, #1399).
    """
    return importlib.import_module("services.sherpa_dictation")

# Measured 2026-08-07 by summing each spec's pinned `files` from
# https://huggingface.co/api/models/<repo>/tree/main?recursive=1
MEASURED_GB = {
    "sherpa-parakeet-tdt-v3": 0.670,
    "sherpa-parakeet-tdt-v2": 0.661,
    "sherpa-zipformer-bilingual-zh-en": 0.198,
    "sherpa-paraformer-bilingual-zh-en": 0.237,
    "sherpa-zipformer-en-20m": 0.044,
    "sherpa-zipformer-zh-14m": 0.025,
    "sherpa-whisper-tiny": 0.104,
}

# How far a declared value may sit from the measurement. Generous enough to
# allow a rounded, human-readable number; tight enough that the 3-4x errors
# this test exists to prevent can never pass.
TOLERANCE = 0.15  # 15%


def test_every_model_is_covered(sd):
    """A new model must arrive with a measured size, not an estimate."""
    assert set(sd._MODELS) == set(MEASURED_GB), (
        "the model list and the measured-size table have drifted; measure the "
        "new repo from the HF tree API rather than estimating it"
    )


@pytest.mark.parametrize("model_id", sorted(MEASURED_GB))
def test_declared_size_is_within_tolerance_of_the_measurement(sd, model_id):
    declared = sd._MODELS[model_id].size_gb
    actual = MEASURED_GB[model_id]
    assert actual * (1 - TOLERANCE) <= declared <= actual * (1 + TOLERANCE), (
        f"{model_id} advertises {declared} GB but the pinned files measure "
        f"{actual} GB. The picker is what a user decides on before spending "
        f"their bandwidth and disk."
    )


def test_the_model_catalogue_carries_the_same_sizes(sd):
    """`backend/config/models.yaml` is a second copy of these numbers.

    The Model Catalogue's download accounting reads the yaml, the dictation
    picker reads `sd._MODELS` — the 2026-08 re-measure fixed only the latter
    and the catalogue kept advertising the old 3-4x-wrong figures (#1610
    review). Every yaml entry with a `dictation_id` must match the spec.
    """
    import yaml

    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "backend", "config", "models.yaml",
    )
    with open(path, encoding="utf-8") as fh:
        catalog = yaml.safe_load(fh)
    entries = {
        e["dictation_id"]: e for e in catalog["models"]
        if isinstance(e, dict) and e.get("dictation_id")
    }
    assert set(entries) == set(sd._MODELS), (
        "models.yaml and sherpa_dictation._MODELS list different models"
    )
    for model_id, entry in entries.items():
        assert entry["size_gb"] == pytest.approx(
            sd._MODELS[model_id].size_gb
        ), (
            f"models.yaml advertises {entry['size_gb']} GB for {model_id} but "
            f"the measured spec says {sd._MODELS[model_id].size_gb} GB — "
            f"update the catalogue in the same change as the spec"
        )


def test_the_small_fallbacks_are_smaller_than_the_heavy_models(sd):
    """The property that made the old numbers actively misleading.

    The low-RAM zipformers exist to rescue users whose machine cannot carry a
    0.6B model. While they over-reported, the picker showed the 20M fallback
    (0.128) as comparable to nothing it was smaller than — the ordering that
    users actually reason about was broken, not just the absolute figures.
    """
    heavy = [m.size_gb for m in sd._MODELS.values() if m.heavy]
    fallbacks = [
        sd._MODELS["sherpa-zipformer-en-20m"].size_gb,
        sd._MODELS["sherpa-zipformer-zh-14m"].size_gb,
    ]
    assert heavy, "no model is marked heavy"
    assert max(fallbacks) < min(heavy), (
        "a low-RAM fallback is advertised as larger than a 0.6B model"
    )


# ── thread policy ──────────────────────────────────────────────────────────


def test_only_the_large_models_ask_for_extra_threads(sd):
    for spec in sd._MODELS.values():
        threads = sd._threads_for(spec)
        if spec.heavy:
            assert threads >= sd._NUM_THREADS
        else:
            assert threads == sd._NUM_THREADS, (
                f"{spec.id} is not a 0.6B model but asks for {threads} threads; "
                f"the small models are the fallback for machines where spending "
                f"cores is the wrong trade"
            )


def test_a_heavy_model_actually_reaches_the_larger_thread_count(monkeypatch, sd):
    """The branch every other thread test only implies.

    `test_only_the_large_models_ask_for_extra_threads` asserts `>= _NUM_THREADS`
    for heavy models, which is satisfied by equality — so a regression that
    quietly returned the base default for everything would pass the whole file
    and the 0.6B models would silently lose their threads again. Pin the actual
    value on a host with cores to spare (CodeRabbit, #1399).
    """
    monkeypatch.delenv("OMNIVOICE_SHERPA_ASR_THREADS", raising=False)
    monkeypatch.setattr(os, "cpu_count", lambda: 8)
    heavy = [m for m in sd._MODELS.values() if m.heavy]
    assert heavy, "no model is marked heavy"
    for spec in heavy:
        assert sd._threads_for(spec) == sd._LARGE_MODEL_THREADS


def test_the_thread_bump_never_exceeds_the_host_core_count(monkeypatch, sd):
    monkeypatch.setattr(os, "cpu_count", lambda: 2)
    heavy = next(m for m in sd._MODELS.values() if m.heavy)
    assert sd._threads_for(heavy) <= 2


def test_a_single_core_host_still_gets_the_base_default(monkeypatch, sd):
    # min() alone would hand back 1 thread; the floor keeps behaviour no worse
    # than it was before this policy existed.
    monkeypatch.setattr(os, "cpu_count", lambda: 1)
    heavy = next(m for m in sd._MODELS.values() if m.heavy)
    assert sd._threads_for(heavy) == sd._NUM_THREADS


def test_the_env_override_still_wins_for_every_model(monkeypatch, sd):
    """`OMNIVOICE_SHERPA_ASR_THREADS` is a documented power-user override; the
    per-model policy must not quietly outrank what the user asked for."""
    monkeypatch.setenv("OMNIVOICE_SHERPA_ASR_THREADS", "1")
    for spec in sd._MODELS.values():
        assert sd._threads_for(spec) == sd._NUM_THREADS


def test_the_large_model_target_is_above_the_base_default(sd):
    assert sd._LARGE_MODEL_THREADS > sd._NUM_THREADS


# ── the live check ─────────────────────────────────────────────────────────


@pytest.mark.skipif(
    os.environ.get("RUN_NETWORK_TESTS") != "1",
    reason="hits huggingface.co; set RUN_NETWORK_TESTS=1 to re-measure",
)
@pytest.mark.parametrize("model_id", sorted(MEASURED_GB))
def test_declared_sizes_match_the_published_repos(sd, model_id):
    spec = sd._MODELS[model_id]
    url = (
        f"https://huggingface.co/api/models/{spec.repo_id}"
        f"/tree/main?recursive=1"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "voicestudio-tests"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        entries = {e["path"]: e for e in json.load(resp) if e["type"] == "file"}

    total = 0
    for role, fname in spec.files.items():
        entry = entries.get(fname)
        assert entry is not None, (
            f"{spec.repo_id} no longer publishes {fname} (role {role}) — the "
            f"pinned filename is stale, which breaks the download itself"
        )
        total += entry.get("size") or entry.get("lfs", {}).get("size") or 0

    actual = total / 1e9
    assert abs(actual - MEASURED_GB[model_id]) < 0.02, (
        f"{model_id} now measures {actual:.3f} GB upstream; MEASURED_GB says "
        f"{MEASURED_GB[model_id]}. Update both it and the spec's size_gb."
    )
