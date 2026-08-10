"""Regression evidence for reviewed GHAS false positives.

These tests intentionally inspect the narrow security invariants at the
reported sinks.  They keep future refactors from making a dismissed alert
silently become exploitable while avoiding heavyweight model imports.
"""

from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def _function(path: str, name: str) -> tuple[ast.FunctionDef | ast.AsyncFunctionDef, str]:
    source = _source(path)
    tree = ast.parse(source)
    node = next(
        item
        for item in ast.walk(tree)
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == name
    )
    return node, ast.get_source_segment(source, node) or ""


def test_dynamic_updates_only_interpolate_allowlisted_columns_and_placeholders():
    cases = (
        (
            "backend/api/routers/glossary.py",
            "update_term",
            '("source", "target", "note")',
            "UPDATE glossary_terms",
        ),
        (
            "backend/api/routers/profiles.py",
            "update_profile",
            '("name", "ref_text", "instruct", "language", "personality")',
            "UPDATE voice_profiles",
        ),
    )
    for path, function, allowlist, table in cases:
        _, body = _function(path, function)
        assert allowlist in body
        assert 'fields.append(f"{col} = ?")' in body
        assert table in body
        assert "params" in body
        # User values and IDs are never formatted into the statement.
        assert "{val}" not in body
        assert "{profile_id}" not in body
        assert "{term_id}" not in body
        assert "{project_id}" not in body


def test_history_reference_query_varies_only_placeholder_arity():
    _, body = _function(
        "backend/api/routers/generation.py", "_remove_wav_if_unreferenced"
    )
    assert 'placeholders = ",".join("?" for _ in exclude_ids)' in body
    assert 'f" AND id NOT IN ({placeholders})"' in body
    assert "(audio_path, *exclude_ids)" in body
    assert "{audio_path}" not in body
    assert "{exclude_ids}" not in body


def test_media_download_sink_requires_https_size_and_sha256():
    _, body = _function("backend/services/media_tools.py", "_download")
    assert 'if not url.startswith("https://")' in body
    assert "done != expected_size" in body
    assert "digest != expected_sha256" in body
    assert body.index('url.startswith("https://")') < body.index("urlopen(")


def test_pypi_metadata_and_wheel_digest_reach_the_verified_download_sink():
    source = _source("backend/services/media_tools.py")
    assert '_PYPI_YTDLP_URL = "https://pypi.org/pypi/yt-dlp/json"' in source
    _, fetch = _function("backend/services/media_tools.py", "_fetch_pypi_ytdlp")
    assert 'artifact["url"]' in fetch
    assert 'artifact["digests"]["sha256"]' in fetch
    _, update = _function("backend/services/media_tools.py", "_do_update_ytdlp")
    assert "version, url, sha = _fetch_pypi_ytdlp()" in update
    assert '_download(url, whl, sha, None, op="ytdlp_update")' in update


def test_diagnostic_probe_is_a_guarded_constant_https_head_request():
    source = _source("backend/core/diagnose.py")
    assert '_HUB_URL = "https://huggingface.co"' in source
    _, body = _function("backend/core/diagnose.py", "_check_network")
    assert 'if not _HUB_URL.startswith("https://")' in body
    assert 'Request(_HUB_URL, method="HEAD")' in body
    assert body.index('_HUB_URL.startswith("https://")') < body.index("urlopen(")


def test_health_check_url_and_server_are_both_pinned_to_loopback():
    source = _source("backend/main.py")
    assert 'HEALTH_URL = f"http://127.0.0.1:{_port}/health"' in source
    assert 'uvicorn.run(app, host="127.0.0.1", port=_port' in source
    assert "_port = network_share.backend_port()" in source


def test_huggingface_cache_probe_is_forced_offline():
    _, body = _function("backend/services/model_manager.py", "_checkpoint_in_local_cache")
    assert "snapshot_download(checkpoint, local_files_only=True)" in body
    assert "local_files_only=False" not in body


def test_pep562_exports_are_backed_by_lazy_attribute_resolvers():
    package = _source("omnivoice/__init__.py")
    assert '__all__ = ["OmniVoice", "OmniVoiceConfig", "OmniVoiceGenerationConfig"]' in package
    assert "def __getattr__(name):" in package
    assert "if name in __all__:" in package
    assert "return getattr(_m, name)" in package

    backend = _source("backend/engines/omnivoice_gguf/backend.py")
    assert '"OmniVoiceGGUFBackend",' in backend
    assert 'if name == "OmniVoiceGGUFBackend":' in backend
    assert "return _make_backend_class()" in backend


def test_secret_error_logs_never_include_plaintext_or_ciphertext_variables():
    _, body = _function("backend/services/settings_store.py", "get_secret")
    tree = ast.parse(body)
    log_calls = [
        call
        for call in ast.walk(tree)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Attribute)
        and call.func.attr in {"error", "warning", "exception"}
    ]
    assert len(log_calls) == 3
    for call in log_calls:
        argument_names = {
            node.id for arg in call.args[1:] for node in ast.walk(arg) if isinstance(node, ast.Name)
        }
        assert argument_names <= {"name"}
        rendered = ast.unparse(call)
        assert "row" not in rendered
        assert "key" not in rendered


def test_dataset_script_handles_are_closed_by_outer_finally_blocks():
    cases = (
        ("omnivoice/scripts/denoise_audio.py", "main"),
        ("omnivoice/scripts/extract_audio_tokens.py", "main"),
        ("omnivoice/scripts/extract_audio_tokens_add_noise.py", "main"),
    )
    for path, function in cases:
        _, body = _function(path, function)
        assert "tar_writer = None" in body
        assert "jsonl_file = None" in body
        assert "finally:" in body
        finally_body = body.rsplit("finally:", 1)[1]
        assert "if tar_writer is not None:" in finally_body
        assert "tar_writer.close()" in finally_body
        assert "if jsonl_file is not None:" in finally_body
        assert "jsonl_file.close()" in finally_body
