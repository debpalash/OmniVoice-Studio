import os
import time
import asyncio
import logging
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from schemas.requests import TranslateRequest
from services.model_manager import _cpu_pool, _gpu_pool
from services.translator import cinematic_available, cinematic_refine_many
from api.routers.dub_core import _get_job

router = APIRouter()
logger = logging.getLogger("omnivoice.api")

TRANSLATE_CODES = {
    "en": "en", "es": "es", "fr": "fr", "de": "de", "it": "it", "pt": "pt",
    "ru": "ru", "ja": "ja", "ko": "ko", "zh": "zh-CN", "ar": "ar", "hi": "hi",
    "tr": "tr", "pl": "pl", "nl": "nl", "sv": "sv", "th": "th", "vi": "vi",
    "id": "id", "uk": "uk",
}

FLORES_CODES = {
    "en": "eng_Latn", "es": "spa_Latn", "fr": "fra_Latn", "de": "deu_Latn",
    "it": "ita_Latn", "pt": "por_Latn", "ru": "rus_Cyrl", "ja": "jpn_Jpan",
    "ko": "kor_Hang", "zh": "zho_Hans", "zh-CN": "zho_Hans", "ar": "arb_Arab", 
    "hi": "hin_Deva", "tr": "tur_Latn", "pl": "pol_Latn", "nl": "nld_Latn",
    "sv": "swe_Latn", "th": "tha_Thai", "vi": "vie_Latn", "id": "ind_Latn",
    "uk": "ukr_Cyrl",
}

_nllb_model = None
_nllb_tokenizer = None
_nllb_device = None


def _resolve_source_lang(req: TranslateRequest) -> str:
    """Pick source language: explicit request > job.source_lang > 'en' fallback."""
    if getattr(req, "source_lang", None):
        return req.source_lang
    if getattr(req, "job_id", None):
        job = _get_job(req.job_id)
        if job and job.get("source_lang"):
            return job["source_lang"]
    return "en"


def _unload_nllb():
    """Release NLLB VRAM so TTS model can reload."""
    global _nllb_model, _nllb_tokenizer
    import gc
    _nllb_model = None
    _nllb_tokenizer = None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass


@router.post("/dub/translate")
async def dub_translate(req: TranslateRequest):
    try:
        provider = (req.provider if req.provider else os.environ.get("TRANSLATE_PROVIDER", "google")).lower()
        lang_code = TRANSLATE_CODES.get(req.target_lang, req.target_lang)
        api_key = os.environ.get("TRANSLATE_API_KEY", "")
        loop = asyncio.get_event_loop()
        src_lang = _resolve_source_lang(req)

        # Offline NLLB Transformer Translation
        if provider == "nllb":
            flores_tgt = FLORES_CODES.get(req.target_lang, "eng_Latn")
            flores_src = FLORES_CODES.get(src_lang, "eng_Latn")

            def _translate_nllb():
                global _nllb_model, _nllb_tokenizer, _nllb_device
                import torch
                from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

                if torch.cuda.is_available():
                    target_device = "cuda"
                elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    target_device = "mps"
                else:
                    target_device = "cpu"

                try:
                    if _nllb_tokenizer is None:
                        _nllb_tokenizer = AutoTokenizer.from_pretrained("facebook/nllb-200-distilled-600M")
                    if _nllb_model is None:
                        _nllb_model = AutoModelForSeq2SeqLM.from_pretrained("facebook/nllb-200-distilled-600M")
                        if target_device != "cpu":
                            try:
                                _nllb_model = _nllb_model.to(target_device)
                                _nllb_device = target_device
                            except Exception as e:
                                logger.warning("NLLB %s placement failed, falling back to CPU: %s", target_device, e)
                                _nllb_device = "cpu"
                        else:
                            _nllb_device = "cpu"
                except Exception as e:
                    logger.exception("NLLB model load failed")
                    return [{"id": seg.id, "text": seg.text, "error": f"Model load error: {str(e)}"} for seg in req.segments]

                results = []
                for seg in req.segments:
                    try:
                        if not seg.text or not seg.text.strip():
                            results.append({"id": seg.id, "text": seg.text})
                            continue

                        tgt = FLORES_CODES.get(seg.target_lang, flores_tgt) if seg.target_lang else flores_tgt

                        _nllb_tokenizer.src_lang = flores_src
                        inputs = _nllb_tokenizer(seg.text, return_tensors="pt")
                        if _nllb_device and _nllb_device != "cpu":
                            inputs = {k: v.to(_nllb_device) for k, v in inputs.items()}

                        forced_bos_token_id = _nllb_tokenizer.convert_tokens_to_ids(tgt)
                        try:
                            translated_tokens = _nllb_model.generate(
                                **inputs, forced_bos_token_id=forced_bos_token_id, max_length=400
                            )
                        except (RuntimeError, NotImplementedError) as e:
                            if _nllb_device == "mps":
                                logger.warning("MPS generate failed, retrying on CPU: %s", e)
                                _nllb_model.to("cpu")
                                _nllb_device = "cpu"
                                inputs = {k: v.to("cpu") for k, v in inputs.items()}
                                translated_tokens = _nllb_model.generate(
                                    **inputs, forced_bos_token_id=forced_bos_token_id, max_length=400
                                )
                            else:
                                raise
                        translated_text = _nllb_tokenizer.batch_decode(translated_tokens, skip_special_tokens=True)[0]
                        results.append({"id": seg.id, "text": translated_text})
                    except Exception as e:
                        results.append({"id": seg.id, "text": seg.text, "error": str(e)})
                return results

            translated = await loop.run_in_executor(_gpu_pool, _translate_nllb)
            if os.environ.get("OMNIVOICE_UNLOAD_NLLB", "1") == "1":
                _unload_nllb()
            return {"translated": translated, "target_lang": req.target_lang, "source_lang": src_lang}

        # OpenAI / Ollama Local LLM Translation
        if provider == "openai":
            base_url = os.environ.get("TRANSLATE_BASE_URL")
            model_name = os.environ.get("TRANSLATE_MODEL", "gpt-3.5-turbo")
            from openai import OpenAI
            client = OpenAI(base_url=base_url, api_key=api_key or "local")

            def _translate_llm(seg):
                try:
                    if not seg.text or not seg.text.strip():
                        return {"id": seg.id, "text": seg.text}
                    tgt = seg.target_lang if seg.target_lang else req.target_lang
                    res = client.chat.completions.create(
                        model=model_name,
                        messages=[
                            {"role": "system", "content": f"You are a professional dubbing translator. Translate the user's text from {src_lang} into {tgt}. Reply ONLY with the translated text, do not add any quotes, notes, or explanations."},
                            {"role": "user", "content": seg.text}
                        ]
                    )
                    out_text = res.choices[0].message.content.strip()
                    return {"id": seg.id, "text": out_text}
                except Exception as e:
                    return {"id": seg.id, "text": seg.text, "error": str(e)}

            tasks = [loop.run_in_executor(_cpu_pool, _translate_llm, seg) for seg in req.segments]
            translated = await asyncio.gather(*tasks)
            translated.sort(key=lambda x: str(x["id"]))
            return {"translated": translated, "target_lang": req.target_lang, "source_lang": src_lang}

        # Offline Argos Translate
        if provider == "argos" or provider == "libretranslate":
            def _translate_argos():
                cache_dir = os.environ.get("OMNIVOICE_CACHE_DIR")
                if cache_dir:
                    argos_cache = os.path.join(cache_dir, "argos-translate")
                    os.makedirs(argos_cache, exist_ok=True)
                    os.environ.setdefault("ARGOS_PACKAGES_DIR", argos_cache)
                    os.environ.setdefault("ARGOS_DATA_DIR", argos_cache)
                import argostranslate.package
                import argostranslate.translate

                from_code = src_lang
                available_packages = argostranslate.package.get_installed_packages()

                results = []
                for seg in req.segments:
                    try:
                        if not seg.text or not seg.text.strip():
                            results.append({"id": seg.id, "text": seg.text})
                            continue
                        to_code = seg.target_lang if seg.target_lang else req.target_lang
                        installed_pkg = next(filter(lambda x: x.from_code == from_code and x.to_code == to_code, available_packages), None)

                        if installed_pkg is None:
                            argostranslate.package.update_package_index()
                            all_packages = argostranslate.package.get_available_packages()
                            package_to_install = next(filter(lambda x: x.from_code == from_code and x.to_code == to_code, all_packages), None)
                            if package_to_install:
                                argostranslate.package.install_from_path(package_to_install.download())
                                available_packages = argostranslate.package.get_installed_packages()
                            else:
                                raise Exception(f"No Argos package available for {from_code} -> {to_code}")

                        translated_text = argostranslate.translate.translate(seg.text, from_code, to_code)
                        results.append({"id": seg.id, "text": translated_text})
                    except Exception as e:
                        results.append({"id": seg.id, "text": seg.text, "error": str(e)})
                return results

            translated = await loop.run_in_executor(_cpu_pool, _translate_argos)
            return {"translated": translated, "target_lang": req.target_lang, "source_lang": src_lang}

        # Legacy / API Deep_Translator logic.
        # Preflight the optional `deep_translator` dep once so we fail with a
        # single actionable error instead of N identical per-segment
        # ModuleNotFoundErrors that flood the UI's error badge.
        try:
            import deep_translator  # noqa: F401
        except ImportError:
            friendly = (
                f"The '{provider}' translation engine needs the optional "
                f"`deep_translator` Python package, which isn't installed in "
                f"this backend. Install it with `uv pip install deep_translator` "
                f"(or `pip install deep_translator`) and restart the server, or "
                f"switch the Engine dropdown to Argos (local, bundled), NLLB "
                f"(local, heavier), or OpenAI (LLM)."
            )
            return JSONResponse(status_code=400, content={"error": friendly})

        src_arg = TRANSLATE_CODES.get(src_lang, src_lang) or "auto"

        def _build_translator(src, tgt):
            if provider == "deepl":
                from deep_translator import DeepL
                return DeepL(api_key=api_key, source=src, target=tgt)
            if provider == "mymemory":
                from deep_translator import MyMemoryTranslator
                return MyMemoryTranslator(source=src, target=tgt)
            if provider == "microsoft":
                from deep_translator import MicrosoftTranslator
                return MicrosoftTranslator(api_key=api_key, source=src, target=tgt)
            from deep_translator import GoogleTranslator
            return GoogleTranslator(source=src, target=tgt)

        def _translate_single(seg):
            seg_lc = (
                TRANSLATE_CODES.get(seg.target_lang, seg.target_lang)
                if seg.target_lang else lang_code
            )
            if not seg.text or not seg.text.strip():
                return {"id": seg.id, "text": seg.text}
            last_err = None
            # Try: (src_arg, tgt) → retry once → fall back to (auto, tgt).
            for attempt, src in enumerate([src_arg, src_arg, "auto"]):
                try:
                    out = _build_translator(src, seg_lc).translate(seg.text)
                    if out and out.strip():
                        return {"id": seg.id, "text": out}
                    last_err = "empty translation"
                except Exception as e:
                    last_err = f"{type(e).__name__}: {e}"
                    logger.warning(
                        "translate attempt %d %s->%s (provider=%s) failed: %s",
                        attempt + 1, src, seg_lc, provider, e,
                    )
                    time.sleep(0.25 * (attempt + 1))
            logger.error("translate %s -> %s gave up (provider=%s): %s", src_arg, seg_lc, provider, last_err)
            return {"id": seg.id, "text": seg.text, "error": last_err or "unknown"}

        tasks = [loop.run_in_executor(_cpu_pool, _translate_single, seg) for seg in req.segments]
        translated = await asyncio.gather(*tasks)
        translated.sort(key=lambda x: str(x["id"]))

        return await _maybe_cinematic(
            translated, req, src_lang, loop,
        )
    except Exception as e:
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


async def _maybe_cinematic(translated, req, src_lang, loop):
    """If quality=cinematic and a usable LLM is configured, run REFLECT+ADAPT.
    Otherwise return Fast-mode shape unchanged.
    """
    quality = (getattr(req, "quality", None) or "fast").lower()
    base = {"translated": translated, "target_lang": req.target_lang, "source_lang": src_lang, "quality_used": "fast"}

    if quality != "cinematic":
        return base

    if not cinematic_available():
        logger.warning("cinematic requested but no LLM configured — returning Fast result.")
        base["cinematic_skipped"] = "no-llm-configured"
        return base

    # Build a map from id → original segment (to fetch source text + direction).
    source_by_id: dict[str, str] = {str(s.id): s.text for s in req.segments}
    directions: dict[str, str] = {
        str(s.id): s.direction
        for s in req.segments
        if getattr(s, "direction", None)
    }
    pairs = []
    passthrough_index = {}
    for i, row in enumerate(translated):
        seg_id = str(row["id"])
        literal = row.get("text", "") or ""
        if row.get("error") or not literal.strip():
            passthrough_index[seg_id] = row  # keep as-is, LLM won't help
            continue
        pairs.append((seg_id, source_by_id.get(seg_id, ""), literal))

    if not pairs:
        return base

    refined = await cinematic_refine_many(
        pairs,
        source_lang=src_lang,
        target_lang=req.target_lang,
        glossary=req.glossary,
        directions=directions,
        executor=_cpu_pool,
    )
    refined_by_id = {r["id"]: r for r in refined}

    # Phase 4.4 — speech-rate fit pass. Segment boundaries aren't in the
    # translate request (by design — translator is boundary-agnostic), so we
    # only run it when the caller supplied `slot_seconds` on each segment.
    # The frontend populates this for Cinematic calls from the edit view.
    slots_by_id = {
        str(s.id): getattr(s, "slot_seconds", None)
        for s in req.segments
        if getattr(s, "slot_seconds", None)
    }

    merged = []
    for row in translated:
        seg_id = str(row["id"])
        if seg_id in passthrough_index:
            merged.append(row)
            continue
        r = refined_by_id.get(seg_id)
        if r is None:
            merged.append(row)
            continue
        out = {
            "id": row["id"],
            "text": r["text"],
            "literal": r["literal"],
            "critique": r.get("critique", ""),
        }
        if r.get("error"):
            out["error"] = r["error"]

        # Optional slot-fit pass — only when the caller asked for cinematic
        # *and* provided a slot. Runs best-effort; no-LLM or mid-loop failure
        # just leaves the cinematic text untouched.
        slot = slots_by_id.get(seg_id)
        if slot and out["text"]:
            try:
                from services.speech_rate import adjust_for_slot
                fit = await asyncio.to_thread(
                    adjust_for_slot,
                    out["text"],
                    slot_seconds=float(slot),
                    target_lang=req.target_lang,
                    source_text=source_by_id.get(seg_id),
                )
                if fit.get("text"):
                    out["text"] = fit["text"]
                out["rate_ratio"] = fit.get("rate_ratio")
                if fit.get("error"):
                    out["rate_error"] = fit["error"]
            except Exception as e:
                logger.warning("rate-fit skipped for %s: %s", seg_id, e)

        merged.append(out)

    return {
        "translated": merged,
        "target_lang": req.target_lang,
        "source_lang": src_lang,
        "quality_used": "cinematic",
    }
