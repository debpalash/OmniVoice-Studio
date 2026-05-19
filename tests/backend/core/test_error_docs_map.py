"""Tests for backend/core/error_docs_map.py — error → docs URL taxonomy.

The 4-class taxonomy is the contract Phase 5's bug reporter consumes and
the TS-side `frontend/src/utils/errorDocsMap.ts` mirrors. These tests pin
both the keys and that every URL points back to the project repo.
"""
from __future__ import annotations


def test_known_class_returns_url():
    from core import error_docs_map
    url = error_docs_map.lookup("GATEKEEPER_QUARANTINE")
    assert "docs/install/macos.md#gatekeeper-quarantine" in url


def test_unknown_class_returns_default():
    from core import error_docs_map
    assert error_docs_map.lookup("NEVER_HEARD_OF_IT") == error_docs_map.DEFAULT_DOCS


def test_none_returns_default():
    from core import error_docs_map
    assert error_docs_map.lookup(None) == error_docs_map.DEFAULT_DOCS


def test_all_urls_resolve_to_repo():
    from core import error_docs_map
    from core import links
    base = links.PROJECT_REPO_BLOB_MAIN
    for cls, url in error_docs_map.ERROR_DOCS.items():
        assert url.startswith(base), f"{cls} URL not in repo blob: {url}"
    assert error_docs_map.DEFAULT_DOCS.startswith(base)


def test_all_keys_match_taxonomy():
    """The 4-class taxonomy is locked here. Adding a 5th class is a contract
    change — bump this set + the TS mirror's keys-sync test in lockstep."""
    from core import error_docs_map
    expected = {
        "GATEKEEPER_QUARANTINE",
        "APPIMAGE_WEBKIT_WHITESCREEN",
        "PKG_RESOURCES_MISSING",
        "HF_AUTH_FAILED",
    }
    assert set(error_docs_map.ERROR_DOCS.keys()) == expected
