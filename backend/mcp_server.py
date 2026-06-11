"""
OmniVoice MCP Server — expose voice synthesis as AI-agent tools.

Run standalone:
    python -m backend.mcp_server          # stdio transport (Claude Desktop)
    python -m backend.mcp_server --sse    # SSE transport (remote agents)

Tools exposed:
    generate_speech   — text → WAV audio (voice clone or design)
    list_voices       — enumerate saved voice profiles
    list_languages    — available TTS languages
    list_personalities — voice personality presets

Resources exposed:
    voice://{profile_id}  — voice profile metadata
    history://recent      — last 20 generated audio items
"""
from __future__ import annotations

import argparse
import base64
import logging
import os
import sys

logger = logging.getLogger("omnivoice.mcp")

# ── Lazy imports — keeps startup fast when not using MCP ────────────────


def _ensure_mcp():
    """Import `mcp` SDK lazily so the rest of the backend doesn't pay
    for the import unless the MCP server is actually started."""
    try:
        from mcp.server.fastmcp import FastMCP  # noqa: F811
        return FastMCP
    except ImportError:
        logger.error(
            "MCP SDK not installed. Install with:\n"
            "  pip install 'mcp[cli]'\n"
            "Then re-run this module."
        )
        sys.exit(1)


def create_mcp_server():
    """Build and return the FastMCP server instance."""
    FastMCP = _ensure_mcp()
    mcp = FastMCP(
        "OmniVoice Studio",
        instructions=(
            "AI-agent interface for OmniVoice Studio — voice cloning, "
            "voice design, and video dubbing in 646 languages."
        ),
    )
    # Serve the Streamable-HTTP transport at the app root so mounting the whole
    # app at "/mcp" on the main FastAPI yields the endpoint at "/mcp". FastMCP's
    # default path is "/mcp", which would double-prefix to "/mcp/mcp" when
    # sub-mounted. Harmless for the standalone CLI run() path.
    try:
        mcp.settings.streamable_http_path = "/"
    except Exception:
        pass

    # ── Helpers ─────────────────────────────────────────────────────────

    def _api_base() -> str:
        return os.environ.get("OMNIVOICE_API_URL", "http://localhost:3900")

    async def _api_get(path: str):
        import httpx
        async with httpx.AsyncClient(base_url=_api_base(), timeout=30) as c:
            r = await c.get(path)
            r.raise_for_status()
            return r.json()

    async def _api_post_form(path: str, data: dict, files: dict | None = None):
        import httpx
        async with httpx.AsyncClient(base_url=_api_base(), timeout=120) as c:
            r = await c.post(path, data=data, files=files or {})
            r.raise_for_status()
            return r

    # ── Tools ───────────────────────────────────────────────────────────

    def _current_client_id() -> str | None:
        """The X-OmniVoice-Client-Id of the calling MCP client, if any.

        FastMCP exposes the HTTP request via its request context on the
        Streamable-HTTP transport; stdio clients (and any version where the
        accessor differs) simply resolve to None and fall back to the
        global default voice."""
        try:
            req = mcp.get_context().request_context.request
            if req is not None:
                return req.headers.get("x-omnivoice-client-id")
        except Exception:
            pass
        return None

    @mcp.tool()
    async def generate_speech(
        text: str,
        language: str = "Auto",
        profile_id: str | None = None,
        instruct: str | None = None,
        speed: float = 1.0,
        steps: int = 16,
    ) -> str:
        """Generate speech audio from text.

        Args:
            text: The text to synthesize into speech.
            language: Target language (ISO code or 'Auto'). 646 languages supported.
            profile_id: ID of a saved voice profile to clone. Omit to use this
                agent's bound voice (Settings → MCP), else the global default.
            instruct: Style instruction (e.g. 'whisper', 'excited', 'narrator').
            speed: Speech speed multiplier (0.5–2.0, default 1.0).
            steps: Diffusion steps (8=fast/draft, 16=balanced, 32=quality).

        Returns:
            JSON with audio_id, generation_time, audio_duration, and
            base64-encoded WAV data.
        """
        # Per-agent voice binding (Wave 2.2): explicit arg wins; otherwise
        # resolve this client's bound profile, then the global default.
        client_id = _current_client_id()
        try:
            from services import mcp_bindings
            resolved = mcp_bindings.resolve_voice(client_id, profile_id)
            profile_id = resolved.get("profile_id")
            mcp_bindings.touch_last_seen(client_id) if client_id else None
        except Exception:
            pass  # binding layer unavailable — use whatever was passed

        form = {
            "text": text,
            "language": language,
            "speed": str(speed),
            "num_step": str(steps),
        }
        if profile_id:
            form["profile_id"] = profile_id
        if instruct:
            form["instruct"] = instruct

        r = await _api_post_form("/generate", data=form)

        audio_id = r.headers.get("X-Audio-Id", "unknown")
        gen_time = r.headers.get("X-Gen-Time", "?")
        duration = r.headers.get("X-Audio-Duration", "?")

        wav_b64 = base64.b64encode(r.content).decode("ascii")

        return (
            f'{{"audio_id":"{audio_id}",'
            f'"generation_time_s":{gen_time},'
            f'"audio_duration_s":{duration},'
            f'"format":"wav",'
            f'"wav_base64":"{wav_b64}"}}'
        )

    @mcp.tool()
    async def list_voices() -> str:
        """List all saved voice profiles.

        Returns a JSON array of voice profiles with id, name, type (clone/design),
        and personality.
        """
        profiles = await _api_get("/profiles")
        return str(profiles)

    @mcp.tool()
    async def list_personalities() -> str:
        """List available voice personality presets.

        Returns presets like Narrator, Casual, News Anchor, etc. with their
        instruct text. Use the instruct text with generate_speech.
        """
        presets = await _api_get("/personalities")
        return str(presets)

    @mcp.tool()
    async def list_languages() -> str:
        """List a sample of supported TTS languages.

        OmniVoice supports 646 languages. This returns the most popular ones
        plus a note about the full count.
        """
        return (
            '{"total":646,"popular":['
            '"en","es","fr","de","it","pt","ru","ja","ko","zh",'
            '"ar","hi","tr","nl","pl","sv","da","fi","no","el"'
            '],"note":"Pass any ISO 639 code or set language=Auto for detection."}'
        )

    @mcp.tool()
    async def transcribe(audio_base64: str, language: str | None = None) -> str:
        """Transcribe spoken audio to text.

        Args:
            audio_base64: Base64-encoded audio bytes (wav/mp3/webm/m4a).
            language: Optional language hint; omit for auto-detect.

        Returns:
            JSON with the recognized text, language, and duration.
        """
        try:
            raw = base64.b64decode(audio_base64, validate=True)
        except Exception:
            return '{"error":"audio_base64 is not valid base64"}'
        # 200 MB cap — same spirit as voicebox's transcribe gate. Keeps a
        # buggy/hostile agent from posting an unbounded blob.
        if len(raw) > 200 * 1024 * 1024:
            return '{"error":"audio exceeds 200 MB limit"}'
        data = {}
        if language:
            data["language"] = language
        r = await _api_post_form(
            "/transcribe", data=data,
            files={"audio": ("audio.wav", raw, "application/octet-stream")},
        )
        return str(r.json())

    @mcp.tool()
    async def check_health() -> str:
        """Check if the OmniVoice backend is running and what GPU device is active."""
        info = await _api_get("/health")
        return str(info)

    # ── Resources ───────────────────────────────────────────────────────

    @mcp.resource("voice://{profile_id}")
    async def get_voice(profile_id: str) -> str:
        """Get details of a specific voice profile."""
        profiles = await _api_get("/profiles")
        for p in profiles:
            if p.get("id") == profile_id:
                return str(p)
        return f'{{"error":"Voice profile {profile_id} not found"}}'

    @mcp.resource("history://recent")
    async def get_recent_history() -> str:
        """Get the 20 most recent generation history items."""
        history = await _api_get("/history")
        return str(history[:20])

    return mcp


# ── CLI entrypoint ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="OmniVoice MCP Server")
    parser.add_argument(
        "--sse", action="store_true",
        help="Use SSE transport instead of stdio (for remote agents)",
    )
    parser.add_argument(
        "--port", type=int, default=8765,
        help="Port for SSE transport (default: 8765)",
    )
    args = parser.parse_args()

    mcp = create_mcp_server()

    if args.sse:
        logger.info("Starting MCP server on SSE transport, port %d", args.port)
        mcp.run(transport="sse", port=args.port)
    else:
        logger.info("Starting MCP server on stdio transport")
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
