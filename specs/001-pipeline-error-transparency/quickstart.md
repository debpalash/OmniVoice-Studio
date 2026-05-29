# Quickstart: Verifying Pipeline Error Transparency

How to confirm the three Test-matrix triggers from #131. Each must show a
specific cause in the UI **and** a full traceback in the backend log.

## Automated (the regression gate)

```bash
uv run pytest tests/test_dub_error_transparency.py -q
uv run pytest tests/backend/test_dub_pipeline_wav.py -q   # WAV-only failure path
```

These assert, for each trigger: the emitted SSE event is `type:"error"` with a
non-empty `reason` + `error_class` + `stage`, the backend log (captured via
`caplog`) contains a traceback, and `detail`/`diagnostic` contain no secret-like
values or absolute home paths. They are written to FAIL on `main` (where the
event is a bare/empty `str(e)`) and PASS after the fix.

## Manual (in-app)

1. **Extract fails (bad input)** — start a dub on a corrupt or audio-less file.
   - Expect: UI shows e.g. "extract — FileNotFoundError: … " + a hint (not
     "unknown error"); backend log (LogsFooter → System) shows the traceback.
2. **Remote ingest fails** — dub-by-URL with an unreachable/invalid URL.
   - Expect: specific cause (e.g. yt-dlp error) + hint; traceback in log.
3. **WAV-only input fails** — feed a malformed WAV (no ffmpeg/extract path).
   - Expect: specific cause; traceback in log.
4. **Copy diagnostic** — on any failure, click "Copy diagnostic"; paste it.
   - Expect: cause + stage + env summary; NO tokens/keys/secrets; home dir shown
     as `~`.

## Cross-platform check (Constitution III)

Run trigger 3 (WAV-only, no ffmpeg) on macOS, Windows, and Linux; the UI message
and log behavior must be identical. The `smoke-matrix` CI job exercises the
in-process path on all three.
