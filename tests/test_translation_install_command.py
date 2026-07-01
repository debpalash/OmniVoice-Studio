"""Single-source install command for translation engines.

The proactive Install affordance in the Dub Engine selector (fed by
``list_engines()['install_command']``) and the translate-time 400 error
(dub_translate.py) must both read the SAME command string, so a user is never
told two different things. These tests fail-before / pass-after the
``translation_engines.install_command`` extraction and its use in the 400s.
"""
import asyncio
import json
import os
import sys

os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

from services import translation_engines as te


def test_list_engines_emits_install_command():
    engines = {e["id"]: e for e in te.list_engines()}
    # deep_translator-backed online engines all share the same command.
    for eid in ("google", "deepl", "microsoft", "mymemory"):
        assert engines[eid]["install_command"] == "uv pip install deep_translator", eid
    assert engines["argos"]["install_command"] == "uv pip install argostranslate"
    assert engines["openai"]["install_command"] == "uv pip install openai"
    # NLLB rides on the core `transformers` dep — no separate install line.
    assert engines["nllb"]["install_command"] is None


def test_install_command_helper_matches_registry():
    assert te.install_command("google") == "uv pip install deep_translator"
    assert te.install_command("nllb") is None
    assert te.install_command("does-not-exist") is None
    # Accepts a registry entry dict too (used by list_engines).
    assert te.install_command(te.get_engine("openai")) == "uv pip install openai"


def _translate_400_body(monkeypatch, provider, missing_module):
    """Force the optional dep to be unimportable, run one translate, return the
    400 JSON body. ``sys.modules[name] = None`` makes ``import name`` raise
    ImportError even when the package is actually installed — deterministic on
    dev + CI regardless of what's in the venv."""
    from api.routers.dub_translate import dub_translate
    from schemas.requests import TranslateRequest, TranslateSegment

    monkeypatch.setitem(sys.modules, missing_module, None)
    req = TranslateRequest(
        segments=[TranslateSegment(id="1", text="hello world")],
        target_lang="es",
        provider=provider,
        source_lang="en",
    )
    resp = asyncio.run(dub_translate(req))
    assert resp.status_code == 400, resp
    return json.loads(resp.body)


def test_deep_translator_400_embeds_registry_install_command(monkeypatch):
    body = _translate_400_body(monkeypatch, "google", "deep_translator")
    cmd = te.install_command("google")
    assert cmd == "uv pip install deep_translator"
    # The exact command from list_engines appears verbatim in the 400 — they
    # cannot drift.
    assert cmd in body["error"], body


def test_argos_400_embeds_registry_install_command(monkeypatch):
    body = _translate_400_body(monkeypatch, "argos", "argostranslate")
    cmd = te.install_command("argos")
    assert cmd == "uv pip install argostranslate"
    assert cmd in body["error"], body
