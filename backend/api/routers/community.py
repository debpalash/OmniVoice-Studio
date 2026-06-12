"""Community gallery (marketplace) API.

Loads designed *presets* and recorded *voices* from configured content repos
(default: ``debpalash/omnivoice-gallery``) over the jsDelivr CDN, caches them
locally, validates strictly, and exposes them to the gallery.

Design / safety
===============
* **Local-first.** The network is touched only when the user opens the
  marketplace or hits refresh. Everything is cached under
  ``DATA_DIR/gallery_cache`` and served offline from cache; the app's built-in
  generated archetypes need no network, so the gallery is never empty.
* **Data only, never code.** Remote content is JSON + audio. Presets are
  validated against the engine's taxonomy and *dropped* if invalid (so a bad
  community entry can't reproduce issue #89). Audio URLs are restricted to an
  allow-list of hosts (jsDelivr / GitHub) — no arbitrary SSRF target.
* **Reuse.** "Use a preset" renders through the same path as archetypes
  (one TTS code path).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query

from core import archetypes
from core.config import DATA_DIR

logger = logging.getLogger("omnivoice.community")
router = APIRouter()

_CACHE_DIR = Path(DATA_DIR) / "gallery_cache"
_DEFAULT_SOURCES = ["debpalash/omnivoice-gallery"]
_ALLOWED_AUDIO_HOSTS = {
    "cdn.jsdelivr.net", "github.com", "raw.githubusercontent.com",
    "objects.githubusercontent.com", "release-assets.githubusercontent.com",
}
_VALID_TOKENS = set(archetypes._VD._INSTRUCT_ALL_VALID)
_USE_CASE_IDS = {c["id"] for c in archetypes.USE_CASES}
_SOURCE_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")  # owner/repo only


# ── Config: which content repos to load ───────────────────────────────────────
def configured_sources() -> list[str]:
    """Gallery sources, in priority order. Env var > config file > default."""
    env = os.environ.get("OMNIVOICE_GALLERY_SOURCES")
    if env:
        return [s.strip() for s in env.split(",") if s.strip()]
    cfg = Path(DATA_DIR) / "gallery_sources.json"
    if cfg.exists():
        try:
            data = json.loads(cfg.read_text(encoding="utf-8"))
            srcs = data.get("sources")
            if isinstance(srcs, list) and srcs:
                return [str(s) for s in srcs]
        except Exception:
            logger.warning("gallery_sources.json unreadable; using default")
    return list(_DEFAULT_SOURCES)


def _manifest_url(source: str) -> str:
    return f"https://cdn.jsdelivr.net/gh/{source}@main/manifest.json"


def _cache_path(source: str) -> Path:
    return _CACHE_DIR / source.replace("/", "__") / "manifest.json"


def _safe_audio_url(url: str) -> bool:
    try:
        u = urlparse(url or "")
        return u.scheme == "https" and (u.hostname in _ALLOWED_AUDIO_HOSTS)
    except Exception:
        return False


def is_valid_instruct(instruct: str) -> bool:
    toks = [t.strip() for t in (instruct or "").split(",") if t.strip()]
    return bool(toks) and all(t in _VALID_TOKENS for t in toks)


def validate_item(raw: dict) -> Optional[dict]:
    """Return a normalized item, or None if it must be dropped."""
    if not isinstance(raw, dict):
        return None
    it = dict(raw)
    if it.get("type") not in ("preset", "voice"):
        return None
    if not it.get("id") or not it.get("name"):
        return None
    if it.get("use_case") not in _USE_CASE_IDS:
        return None
    if it["type"] == "preset" and not is_valid_instruct(it.get("instruct", "")):
        return None  # would crash synthesis — drop it
    if it["type"] == "voice" and not _safe_audio_url((it.get("audio") or {}).get("url", "")):
        return None
    it.setdefault("facets", {})
    it.setdefault("icon", archetypes._USE_ICON.get(it["use_case"], "Sparkles"))
    it.setdefault("language", it.get("facets", {}).get("lang", "English"))
    it["is_community"] = it.get("source") != "starter"
    return it


def _merge(manifests: list[tuple[str, Optional[dict]]]) -> tuple[list, list]:
    items, packs, seen = [], [], set()
    for src, m in manifests:
        if not m:
            continue
        for raw in (m.get("items") or []):
            v = validate_item(raw)
            if v and v["id"] not in seen:
                v["_source_repo"] = src
                seen.add(v["id"])
                items.append(v)
        for p in (m.get("packs") or []):
            if isinstance(p, dict):
                packs.append({**p, "_source_repo": src})
    return items, packs


def _fetch_manifest(source: str, refresh: bool) -> Optional[dict]:
    """Return a source's manifest from cache, or fetch + cache it. None if both fail."""
    cache = _cache_path(source)
    if not refresh and cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except Exception:
            pass
    try:
        import httpx
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            resp = client.get(_manifest_url(source))
            resp.raise_for_status()
            data = resp.json()
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(data), encoding="utf-8")
        return data
    except Exception as e:  # offline / 404 / bad json
        logger.warning("manifest fetch failed for %s: %s", source, e)
        if cache.exists():
            try:
                return json.loads(cache.read_text(encoding="utf-8"))
            except Exception:
                pass
        return None


def _load(refresh: bool) -> tuple[list[str], list, list, bool]:
    srcs = configured_sources()
    manifests = [(s, _fetch_manifest(s, refresh)) for s in srcs]
    items, packs = _merge(manifests)
    offline = all(m is None for _, m in manifests)
    return srcs, items, packs, offline


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/community/sources")
def community_sources():
    """The content repos the gallery loads from (default: omnivoice-gallery)."""
    return {"sources": configured_sources()}


@router.get("/community/manifest")
def community_manifest(refresh: bool = Query(False)):
    srcs, items, packs, offline = _load(refresh)
    return {"sources": srcs, "packs": packs, "items": items, "count": len(items), "offline": offline}


@router.get("/community/items")
def community_items(
    use_case: Optional[str] = None,
    gender: Optional[str] = None,
    item_type: Optional[str] = Query(None, alias="type"),
    lang: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
    refresh: bool = Query(False),
):
    _, items, _, _ = _load(refresh)

    def keep(it: dict) -> bool:
        f = it.get("facets", {})
        if use_case and it.get("use_case") != use_case:
            return False
        if gender and f.get("gender") != gender:
            return False
        if item_type and it.get("type") != item_type:
            return False
        if lang and it.get("language") != lang:
            return False
        if q and q.lower() not in (it.get("name", "").lower()):
            return False
        return True

    items = [it for it in items if keep(it)]
    return {"total": len(items), "limit": limit, "offset": offset, "items": items[offset:offset + limit]}


@router.get("/community/submit-url")
def community_submit_url(item_type: str = Query("preset", alias="type"), source: Optional[str] = Query(None)):
    """Build the prefilled GitHub submission URL (server-free, local-first)."""
    src = source or configured_sources()[0]
    if not _SOURCE_RE.match(src or ""):
        src = configured_sources()[0]  # ignore a malformed/untrusted source override
    template = "preset-submission.yml" if item_type == "preset" else "voice-submission.yml"
    return {"url": f"https://github.com/{src}/issues/new?template={template}"}


@router.post("/community/items/{item_id}/use")
async def community_use(item_id: str, name: Optional[str] = Query(None)):
    """Materialize a community item into a reusable voice profile.

    Preset → render through the archetype engine. Voice → download the
    (host-allow-listed, SHA-256-verified) reference clip. Both create a
    ``voice_profiles`` row usable everywhere voices are picked.
    """
    _, items, _, _ = await asyncio.to_thread(_load, False)
    item = next((it for it in items if it["id"] == item_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found in the gallery.")

    import time
    import uuid
    from core import event_bus
    from core.db import db_conn
    from core.config import VOICES_DIR

    profile_id = str(uuid.uuid4())[:8]
    audio_filename = f"{profile_id}.wav"
    audio_path = Path(VOICES_DIR) / audio_filename
    profile_name = (name or item["name"]).strip() or item["name"]
    instruct = item.get("instruct", "") if item["type"] == "preset" else ""
    ref_text = item.get("sample_script") or (item.get("audio") or {}).get("ref_text", "")

    try:
        if item["type"] == "preset":
            from api.routers.archetypes import _render_archetype_wav
            pseudo = {
                "instruct": instruct,
                "language": item.get("language", "English"),
                "sample_script": ref_text or "Hello — this is a preview of this voice.",
            }
            await _render_archetype_wav(pseudo, audio_path)
        else:  # voice — download the reference clip (off the event loop)
            await asyncio.to_thread(_download_voice_audio, item, audio_path)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Community 'use' failed", exc_info=True)
        raise HTTPException(status_code=503, detail=f"Couldn't add this voice right now. Error: {e}")

    try:
        # A community "preset" is a synthetic designed voice (rendered from an
        # instruct string) → kind='design'; a "voice" carries a real reference
        # clip → kind='clone'. Setting kind makes the persona-gallery
        # synthetic-only gating work (§R3) instead of defaulting all imports to
        # 'clone'.
        kind = "design" if item["type"] == "preset" else "clone"
        with db_conn() as conn:
            conn.execute(
                "INSERT INTO voice_profiles "
                "(id, name, ref_audio_path, ref_text, instruct, language, seed, personality, created_at, kind) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (profile_id, profile_name, audio_filename, ref_text, instruct,
                 item.get("language", "Auto"), None, item["id"], time.time(), kind),
            )
    except Exception:
        with __import__("contextlib").suppress(OSError):
            os.remove(audio_path)
        raise
    event_bus.emit("profiles", {"action": "created", "id": profile_id})
    return {"profile_id": profile_id, "name": profile_name}


def _download_voice_audio(item: dict, out_path: Path) -> None:
    import hashlib
    audio = item.get("audio") or {}
    url = audio.get("url", "")
    if not _safe_audio_url(url):
        raise HTTPException(status_code=400, detail="Voice audio URL is not from an allowed host.")
    import httpx
    with httpx.Client(timeout=30.0, follow_redirects=True) as client:
        resp = client.get(url)
        resp.raise_for_status()
        data = resp.content
    expected = audio.get("sha256")
    if expected and hashlib.sha256(data).hexdigest() != expected:
        raise HTTPException(status_code=502, detail="Downloaded voice failed its integrity check.")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
