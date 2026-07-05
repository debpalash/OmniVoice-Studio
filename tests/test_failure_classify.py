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


def test_classify_corrupted_transformers_file():
    # A missing transformers module file (interrupted uv sync / AV / partial
    # update) surfaces as FileNotFoundError, not ImportError — it must still
    # classify as TRANSFORMERS_IMPORT so the user gets "reinstall", not "restart".
    posix = (
        "[Errno 2] No such file or directory: "
        "'/Users/u/Library/Application Support/com.x/project/.venv/lib/python3.11/"
        "site-packages/transformers/models/qwen3/modeling_qwen3.py'"
    )
    win = (
        "[Errno 2] No such file or directory: "
        r"'C:\Users\u\AppData\Local\com.x\project\.venv\Lib\site-packages\transformers"
        r"\models\qwen3\modeling_qwen3.py'"
    )
    assert failure.classify(posix) == "TRANSFORMERS_IMPORT"
    assert failure.classify(win) == "TRANSFORMERS_IMPORT"
    f = failure.build_failure(FileNotFoundError(posix), stage="model-load", include_diagnostic=False)
    assert "reinstall" in f["hint"].lower()
    # A missing file from an UNRELATED package must NOT be mislabelled as transformers.
    assert failure.classify("[Errno 2] No such file or directory: '/x/site-packages/numpy/core/foo.py'") == ""


def test_classify_os_invalid_argument_einval():
    # #763: a per-chunk temp-WAV write failing with EINVAL surfaced as the
    # dead-end "produced no segments. [Errno 22] Invalid argument" toast. It must
    # now classify so build_failure attaches a temp-dir/disk/AV hint. This is the
    # exact string the streaming dub path aggregates and feeds build_failure.
    reason = "[Errno 22] Invalid argument"
    assert failure.classify(reason) == "OS_INVALID_ARGUMENT"
    evt = failure.build_failure(reason, stage="transcribe", include_diagnostic=False)
    assert evt["docs_topic"] == "OS_INVALID_ARGUMENT"
    assert evt["hint"], "an EINVAL transcribe failure must carry an actionable hint"
    assert "temp" in evt["hint"].lower()
    # The errno-22 rule must NOT swallow the errno-2 transformers class (its
    # markers still win) or fire on an unrelated errno.
    tf = (
        "[Errno 2] No such file or directory: "
        "'/x/site-packages/transformers/models/qwen3/modeling_qwen3.py'"
    )
    assert failure.classify(tf) == "TRANSFORMERS_IMPORT"
    assert failure.classify("[Errno 13] Permission denied") == ""


def test_classify_video_download_classes():
    # #554: a non-downloadable link shape → actionable "paste a direct video URL".
    assert failure.classify("Unsupported URL: https://www.douyin.com/discover") == (
        "UNSUPPORTED_VIDEO_URL"
    )
    # #536: a transient mid-download drop → "just retry".
    assert failure.classify("Unable to download video: [Errno 32] Broken pipe") == (
        "VIDEO_DOWNLOAD_NETWORK"
    )
    assert failure.classify("Connection reset by peer") == "VIDEO_DOWNLOAD_NETWORK"
    for cls, reason in (
        ("UNSUPPORTED_VIDEO_URL", "Unsupported URL: x"),
        ("VIDEO_DOWNLOAD_NETWORK", "Unable to download video: Broken pipe"),
    ):
        evt = failure.build_failure(reason, stage="download", include_diagnostic=False)
        assert evt["docs_topic"] == cls
        assert evt["hint"], f"{cls} must carry an actionable hint"


def test_classify_broken_venv_encodings():
    # The relocated/corrupted-venv stdlib-bootstrap failure → BROKEN_VENV (the
    # Rust self-heal rebuilds it; this names the class for the toast).
    assert failure.classify("ModuleNotFoundError: No module named 'encodings'") == (
        "BROKEN_VENV"
    )
    # ...but an app-level import of an 'encodings'-prefixed package must NOT.
    assert failure.classify("No module named 'encodings_helper'") == ""


def test_classify_broken_venv_missing_own_package():
    # #564: the interpreter starts but the backend can't import its own
    # 'omnivoice' package (editable install missing) → BROKEN_VENV so the toast
    # points at the self-heal / Clean & Retry instead of a bare import error.
    assert failure.classify("ModuleNotFoundError: No module named 'omnivoice'") == (
        "BROKEN_VENV"
    )
    # ...but a legitimately-named 'omnivoice_*' helper package must NOT match
    # (the trailing quote in the matcher is the guard).
    assert failure.classify("No module named 'omnivoice_helper'") == ""


def test_classify_socks_proxy_support_missing():
    # #959: the exact httpx message at client CONSTRUCTION under a socks5://
    # proxy env without socksio — it surfaced as a bare 500 from /generate
    # (huggingface_hub's get_session() builds the client inside model load).
    reason = (
        "Using SOCKS proxy, but the 'socksio' package is not installed. "
        "Make sure to install httpx using `pip install httpx[socks]`."
    )
    assert failure.classify(reason) == "SOCKS_PROXY_SUPPORT_MISSING"
    evt = failure.build_failure(
        ImportError(reason), stage="model-load", include_diagnostic=False
    )
    assert evt["docs_topic"] == "SOCKS_PROXY_SUPPORT_MISSING"
    assert evt["hint"], "the SOCKS-proxy class must carry an actionable hint"
    assert "ALL_PROXY" in evt["hint"]
    # append_hint is the raw-string surface (main.py's global 500 handler,
    # the model-install SSE) — the detail keeps the real error AND gains the
    # hint, and stays a pass-through for unknown reasons.
    out = failure.append_hint(reason)
    assert out.startswith(reason) and "ALL_PROXY" in out
    assert failure.append_hint("some unrelated failure") == "some unrelated failure"
    # A generic proxy connectivity error must NOT be mislabelled.
    assert failure.classify("ProxyError: connection refused by 10.0.0.1:8080") == ""


def test_classify_generic_still_empty():
    # A genuinely unknown reason must still classify to "" (no false hint).
    assert failure.classify("some totally unrelated failure") == ""
