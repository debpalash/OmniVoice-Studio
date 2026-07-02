"""Unit tests for dub_translate — no network, pure helpers + monkeypatched translator."""
import asyncio
import pytest


def test_translate_codes_cover_popular_iso():
    from api.routers.dub_translate import TRANSLATE_CODES
    popular = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko', 'ar', 'hi']
    for code in popular:
        assert code in TRANSLATE_CODES, f"{code} missing from TRANSLATE_CODES"


def test_flores_codes_cover_core_languages():
    from api.routers.dub_translate import FLORES_CODES
    for code in ('en', 'de', 'es', 'fr', 'hi', 'ja'):
        assert code in FLORES_CODES


def test_resolve_source_lang_priority(monkeypatch):
    from api.routers import dub_translate

    class Req:
        def __init__(self, src=None, jid=None):
            self.source_lang = src
            self.job_id = jid

    # Explicit source_lang wins
    assert dub_translate._resolve_source_lang(Req(src='fr')) == 'fr'

    # Fall through to job-detected source_lang
    monkeypatch.setattr(
        dub_translate, '_get_job',
        lambda jid: {'source_lang': 'de'} if jid == 'j1' else None,
    )
    assert dub_translate._resolve_source_lang(Req(jid='j1')) == 'de'

    # No job, no explicit → default en
    assert dub_translate._resolve_source_lang(Req()) == 'en'
    assert dub_translate._resolve_source_lang(Req(jid='missing')) == 'en'


class _FakeSeg:
    def __init__(self, sid, text, target_lang=None):
        self.id = sid
        self.text = text
        self.target_lang = target_lang


class _FakeReq:
    def __init__(self, segments, target_lang, provider='google', source_lang=None):
        self.segments = segments
        self.target_lang = target_lang
        self.provider = provider
        self.source_lang = source_lang
        self.job_id = None


@pytest.mark.asyncio
async def test_google_path_passes_correct_target_code(monkeypatch):
    """GoogleTranslator constructed with the expected src/tgt codes for German."""
    from api.routers import dub_translate

    calls = []

    class FakeTranslator:
        def __init__(self, source=None, target=None, **kwargs):
            calls.append({'source': source, 'target': target})
        def translate(self, text):
            return f"[{calls[-1]['target']}]{text}"

    class FakeModule:
        GoogleTranslator = FakeTranslator
        DeepL = FakeTranslator
        MyMemoryTranslator = FakeTranslator
        MicrosoftTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Hello'), _FakeSeg('s2', 'World')],
        target_lang='de',
        provider='google',
        source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    assert resp['target_lang'] == 'de'
    assert resp['source_lang'] == 'en'
    texts = {t['id']: t['text'] for t in resp['translated']}
    assert texts['s1'] == '[de]Hello'
    assert texts['s2'] == '[de]World'
    # Each segment built a translator with de as target
    assert all(c['target'] == 'de' for c in calls)
    # Source came through as "en"
    assert any(c['source'] == 'en' for c in calls)


@pytest.mark.asyncio
async def test_google_path_uses_seg_target_lang_override(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, source=None, target=None, **kwargs):
            self.target = target
        def translate(self, text):
            return f"[{self.target}]{text}"

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[
            _FakeSeg('s1', 'Hi', target_lang='bn'),  # per-segment override
            _FakeSeg('s2', 'Ok'),
        ],
        target_lang='de',
        provider='google',
        source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    texts = {t['id']: t['text'] for t in resp['translated']}
    assert texts['s1'] == '[bn]Hi'
    assert texts['s2'] == '[de]Ok'


@pytest.mark.asyncio
async def test_google_retries_then_falls_back_to_auto(monkeypatch):
    """Transient failure → retry → still fails → fall back to auto source."""
    from api.routers import dub_translate

    attempts = []

    class FakeTranslator:
        def __init__(self, source=None, target=None, **kwargs):
            self.source = source
            self.target = target
        def translate(self, text):
            attempts.append(self.source)
            if self.source != 'auto':
                raise RuntimeError('transient google error')
            return f"[auto:{self.target}]{text}"

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Hello')],
        target_lang='de', provider='google', source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    assert resp['translated'][0]['text'] == '[auto:de]Hello'
    assert 'error' not in resp['translated'][0]
    # explicit src tried at least once before auto
    assert attempts[0] == 'en'
    assert attempts[-1] == 'auto'


@pytest.mark.asyncio
async def test_google_reports_error_when_all_attempts_fail(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, **kwargs): pass
        def translate(self, text): raise RuntimeError('total failure')

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'Hello')],
        target_lang='de', provider='google', source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    seg = resp['translated'][0]
    assert seg['text'] == 'Hello', 'original text preserved on failure'
    assert 'error' in seg
    assert 'total failure' in seg['error']


@pytest.mark.asyncio
async def test_empty_text_skipped(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, **kwargs): pass
        def translate(self, text): return '[xx]' + text

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', '  '), _FakeSeg('s2', 'hi')],
        target_lang='de', provider='google', source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    texts = {t['id']: t['text'] for t in resp['translated']}
    assert texts['s1'].strip() == ''  # untouched
    assert texts['s2'] == '[xx]hi'


@pytest.mark.asyncio
async def test_empty_translation_preserves_original(monkeypatch):
    from api.routers import dub_translate

    class FakeTranslator:
        def __init__(self, **kwargs): pass
        def translate(self, text): return ''  # always empty

    class FakeModule:
        GoogleTranslator = FakeTranslator

    monkeypatch.setitem(__import__('sys').modules, 'deep_translator', FakeModule)

    req = _FakeReq(
        segments=[_FakeSeg('s1', 'hi')],
        target_lang='de', provider='google', source_lang='en',
    )
    resp = await dub_translate.dub_translate(req)
    seg = resp['translated'][0]
    assert seg['text'] == 'hi'
    assert 'error' in seg


# ── P0: Cinematic/Autofit must run on the non-deep_translator engines ────────
# Before this fix the argos/nllb/openai branches returned BEFORE
# _maybe_cinematic, so picking Cinematic/Autofit on the DEFAULT Argos engine
# silently produced plain Fast output (no quality_used/refine/rate badges).


def _install_fake_argos(monkeypatch):
    """Register a fake `argostranslate` package that translates en→es to
    `[es]<text>` with a pre-installed package, so the argos branch runs offline."""
    import sys
    import types

    class _Pkg:
        from_code = "en"
        to_code = "es"

    pkg = types.ModuleType("argostranslate.package")
    pkg.get_installed_packages = lambda: [_Pkg()]
    pkg.update_package_index = lambda: None
    pkg.get_available_packages = lambda: []
    pkg.install_from_path = lambda p: None
    tr = types.ModuleType("argostranslate.translate")
    tr.translate = lambda text, frm, to: f"[{to}]{text}"
    root = types.ModuleType("argostranslate")
    root.package = pkg
    root.translate = tr
    monkeypatch.setitem(sys.modules, "argostranslate", root)
    monkeypatch.setitem(sys.modules, "argostranslate.package", pkg)
    monkeypatch.setitem(sys.modules, "argostranslate.translate", tr)


@pytest.mark.asyncio
async def test_argos_cinematic_refines_with_llm(monkeypatch):
    """DEFAULT engine + Cinematic + a usable LLM → refine actually runs and the
    response carries quality_used=='cinematic' plus the literal/critique fields."""
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest, TranslateSegment
    _install_fake_argos(monkeypatch)

    async def fake_refine_many(pairs, **kw):
        return [
            {"id": sid, "text": f"CINE:{lit}", "literal": lit, "critique": "crit"}
            for sid, _src, lit in pairs
        ]

    monkeypatch.setattr(dub_translate, "cinematic_available", lambda: True)
    monkeypatch.setattr(dub_translate, "cinematic_refine_many", fake_refine_many)

    req = TranslateRequest(
        segments=[TranslateSegment(id="s1", text="Hello")],
        target_lang="es", provider="argos", source_lang="en", quality="cinematic",
    )
    resp = await dub_translate.dub_translate(req)
    assert resp["quality_used"] == "cinematic"
    row = resp["translated"][0]
    assert row["literal"] == "[es]Hello"      # the argos literal is preserved
    assert row["text"] == "CINE:[es]Hello"    # and it was actually refined
    assert row["critique"] == "crit"


@pytest.mark.asyncio
async def test_argos_cinematic_skipped_without_llm(monkeypatch):
    """DEFAULT engine + Cinematic + NO LLM → degrades to Fast with an explicit
    cinematic_skipped flag (not a silent success)."""
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest, TranslateSegment
    _install_fake_argos(monkeypatch)
    monkeypatch.setattr(dub_translate, "cinematic_available", lambda: False)

    req = TranslateRequest(
        segments=[TranslateSegment(id="s1", text="Hello")],
        target_lang="es", provider="argos", source_lang="en", quality="cinematic",
    )
    resp = await dub_translate.dub_translate(req)
    assert resp["cinematic_skipped"] == "no-llm-configured"
    assert resp["quality_used"] == "fast"
    assert resp["translated"][0]["text"] == "[es]Hello"  # literal kept


@pytest.mark.asyncio
async def test_argos_fast_stamps_rate_ratio(monkeypatch):
    """Fast on the DEFAULT engine still reaches the rate-ratio stamping so the
    UI's seg-rate-badge has data (it used to return before _maybe_cinematic)."""
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest, TranslateSegment
    _install_fake_argos(monkeypatch)

    req = TranslateRequest(
        segments=[TranslateSegment(id="s1", text="Hello", slot_seconds=2.0)],
        target_lang="es", provider="argos", source_lang="en", quality="fast",
    )
    resp = await dub_translate.dub_translate(req)
    assert resp["quality_used"] == "fast"
    assert "rate_ratio" in resp["translated"][0]


def _install_fake_openai(monkeypatch, *, content="hola mundo", raises=None):
    """Register a fake `openai.OpenAI` whose chat.completions.create returns
    `content` (or raises `raises`). Accepts the max_retries kwarg the code adds."""
    import sys
    import types

    class _Completions:
        def create(self, **kw):
            if raises is not None:
                raise raises
            msg = type("M", (), {"content": content})
            choice = type("C", (), {"message": msg})
            return type("R", (), {"choices": [choice]})

    class _Chat:
        completions = _Completions()

    class _FakeClient:
        def __init__(self, **kw):
            pass
        chat = _Chat()

    mod = types.ModuleType("openai")
    mod.OpenAI = _FakeClient
    monkeypatch.setitem(sys.modules, "openai", mod)


# ── P1: the Autofit fit pass must be bounded by the cinematic wall-clock ─────


@pytest.mark.asyncio
async def test_openai_autofit_fit_pass_is_budget_bounded(monkeypatch):
    """A slow fit LLM must not spin one adjust_for_slot per segment unbounded:
    the whole translate returns within the budget and unfinished segments
    degrade to their literal (fit-budget) instead of hanging."""
    import time
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest, TranslateSegment
    from services import speech_rate
    _install_fake_openai(monkeypatch, content="hola mundo")

    monkeypatch.setenv("OMNIVOICE_CINEMATIC_BUDGET_S", "0.3")

    def _slow_fit(text, *, slot_seconds, target_lang, source_text=None, strict=False):
        time.sleep(3.0)  # far over the 0.3s budget
        return {"text": "FIT-SHOULD-NOT-WIN", "rate_ratio": 1.0}

    monkeypatch.setattr(speech_rate, "adjust_for_slot", _slow_fit)

    req = TranslateRequest(
        segments=[
            TranslateSegment(id="s1", text="Hello", slot_seconds=1.0),
            TranslateSegment(id="s2", text="World", slot_seconds=1.0),
        ],
        target_lang="es", provider="openai", source_lang="en", quality="autofit",
    )
    t0 = time.time()
    resp = await dub_translate.dub_translate(req)
    dt = time.time() - t0
    assert dt < 2.0, f"fit pass not budget-bounded (took {dt:.1f}s)"
    assert resp["quality_used"] == "autofit"
    for row in resp["translated"]:
        assert row["text"] == "hola mundo"          # degraded to literal, not the slow fit
        assert row.get("rate_error") == "fit-budget"


# ── P2: provider errors on the translate path must be scrubbed ──────────────


@pytest.mark.asyncio
async def test_openai_segment_error_is_scrubbed(monkeypatch):
    """An OpenAI-compatible provider that echoes a key / home path in its error
    body must not leak it into the per-segment error response."""
    from api.routers import dub_translate
    from schemas.requests import TranslateRequest, TranslateSegment
    boom = RuntimeError(
        "401 invalid key sk-LEAKLEAKLEAKLEAKLEAK12345 for user at /Users/bob/proj"
    )
    _install_fake_openai(monkeypatch, raises=boom)

    req = TranslateRequest(
        segments=[TranslateSegment(id="s1", text="Hello")],
        target_lang="es", provider="openai", source_lang="en",
    )
    resp = await dub_translate.dub_translate(req)
    seg = resp["translated"][0]
    assert seg["text"] == "Hello"                 # fell back to source text
    assert "sk-LEAKLEAKLEAKLEAKLEAK12345" not in seg["error"]
    assert "/Users/bob" not in seg["error"]
    assert "***REDACTED***" in seg["error"]
