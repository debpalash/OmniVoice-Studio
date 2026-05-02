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
        version="0.3.0",
        description=(
            "AI-agent interface for OmniVoice Studio — voice cloning, "
            "voice design, and video dubbing in 646 languages."
        ),
    )

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
            profile_id: ID of a saved voice profile to clone. Omit for voice design mode.
            instruct: Style instruction (e.g. 'whisper', 'excited', 'narrator').
            speed: Speech speed multiplier (0.5–2.0, default 1.0).
            steps: Diffusion steps (8=fast/draft, 16=balanced, 32=quality).

        Returns:
            JSON with audio_id, generation_time, audio_duration, and
            base64-encoded WAV data.
        """
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
