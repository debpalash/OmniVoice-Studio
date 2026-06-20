"""ASR-robustness failure classification (#551 / #549).

The dub/transcribe "no segments" toast is only actionable if `classify()` names
the failure class so `build_failure()` can attach a hint. These assert the two
new taxonomy classes added for the ASR-robustness fix map to a non-empty hint.
"""
from core import failure


def test_classify_compute_type_unsupported():
    # The exact CTranslate2 message on a GPU without efficient fp16 (#551).
    reason = (
        "Requested float16 compute type, but the target device or backend do "
        "not support efficient float16 computation"
    )
    assert failure.classify(reason) == "COMPUTE_TYPE_UNSUPPORTED"
    evt = failure.build_failure(reason, stage="transcribe", include_diagnostic=False)
    assert evt["docs_topic"] == "COMPUTE_TYPE_UNSUPPORTED"
    assert evt["hint"], "compute-type failure must carry an actionable hint"


def test_classify_transformers_import():
    # The transformers ASR-pipeline import failure (#549).
    assert failure.classify("Could not import module 'AutoFeatureExtractor'") == (
        "TRANSFORMERS_IMPORT"
    )
    # Substring match on the bare class name too (case-insensitive).
    assert failure.classify("AutoFeatureExtractor failed to load") == "TRANSFORMERS_IMPORT"
    evt = failure.build_failure(
        "Could not import module 'AutoFeatureExtractor'",
        stage="transcribe",
        include_diagnostic=False,
    )
    assert evt["hint"], "transformers-import failure must carry an actionable hint"


def test_classify_generic_still_empty():
    # A genuinely unknown reason must still classify to "" (no false hint).
    assert failure.classify("some totally unrelated failure") == ""
