# MCP server — let agents speak in your voice

OmniVoice ships an [MCP](https://modelcontextprotocol.io/) server so AI agents
(Claude Code, Cursor, …) can synthesize speech, transcribe audio, and list
your voices — locally, in a voice you choose per agent. The server is
**mounted on the running backend** at `/mcp`, so there's nothing extra to
start once OmniVoice is open.

## Tools

| Tool | What it does |
|---|---|
| `generate_speech` | text → WAV (base64). Uses the agent's bound voice unless a `profile_id` is passed. |
| `transcribe` | base64 audio → text (646 languages). |
| `list_voices` / `list_personalities` / `list_languages` | enumerate what's available. |
| `check_health` | backend status + active GPU device. |

## Connecting

### Streamable HTTP (modern clients)

Point your client at the mounted endpoint:

```
http://localhost:3900/mcp
```

To bind this agent to a specific voice, send an
`X-OmniVoice-Client-Id` header (e.g. `claude-code`). See
[per-agent voices](#per-agent-voices).

### stdio (clients that only speak stdio)

Use the bundled shim — it proxies stdio ↔ the mounted HTTP endpoint. Drop
this into your client's MCP config (`docs/mcp.json` is a template):

```json
{
  "mcpServers": {
    "omnivoice": {
      "command": "python",
      "args": ["-m", "backend.mcp_shim"],
      "cwd": "/path/to/OmniVoice-Studio",
      "env": { "OMNIVOICE_PORT": "3900", "OMNIVOICE_CLIENT_ID": "claude-code" }
    }
  }
}
```

The shim forwards `OMNIVOICE_CLIENT_ID` as the `X-OmniVoice-Client-Id` header,
so the per-agent voice binding works the same as the HTTP path. It waits for
the backend to be up, relays JSON-RPC, and exits cleanly when the client
closes.

## Per-agent voices

Each agent identifies itself with a **client id**. Bind a client id to a voice
profile so different agents speak differently — "Claude Code in Morgan, Cursor
in Scarlett". Voice resolution precedence on every `generate_speech` call:

1. an explicit `profile_id` argument, else
2. the calling agent's binding, else
3. the global default voice, else
4. OmniVoice's default voice.

Manage bindings over the loopback REST API (the Settings UI uses these):

```bash
# list
curl localhost:3900/api/mcp/bindings
# bind claude-code → a voice profile
curl -X PUT localhost:3900/api/mcp/bindings \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"claude-code","label":"Claude Code","profile_id":"<voice-profile-id>"}'
# remove
curl -X DELETE localhost:3900/api/mcp/bindings/claude-code
```

Prefer a [consent-verified](../docs/competitive-analysis.md) voice profile for
any agent that speaks as you.

## Disabling

Set `OMNIVOICE_MCP_DISABLE=1` to skip mounting `/mcp` entirely.
