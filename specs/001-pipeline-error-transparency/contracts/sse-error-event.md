# Contract: SSE `error` / `warning` Event (additive)

**Channel**: `GET /tasks/stream/{task_id}` (Server-Sent Events) and the dub
generate/transcribe streams. Emitter: `backend/core/failure.build_failure_event`
via `backend/core/tasks.py` and `backend/services/dub_pipeline.py`.

## Backward compatibility

This is an **additive** change. The previous payload —
`{"type":"error","error":"<str>","stage?":"...","detail?":"..."}` — remains
valid: `error`, `stage`, and `detail` keys are still present. New keys are added.
An older frontend that reads only `error` continues to work.

## Event shape

```jsonc
// fatal failure
{
  "type": "error",
  "reason": "ffprobe could not open source: no such file",  // non-empty, required
  "error": "ffprobe could not open source: no such file",   // compat mirror of reason
  "error_class": "FileNotFoundError",
  "stage": "extract",
  "hint": "Pick a media file that exists and has an audio track.",
  "docs_topic": "",                 // taxonomy key or "" — frontend resolves URL
  "detail": "Traceback summary (sanitized) …",
  "diagnostic": "OmniVoice diagnostic\n----…"   // sanitized, copyable
}

// non-fatal degradation (job continues)
{
  "type": "warning",
  "reason": "Demucs unavailable — using mixed audio.",
  "error_class": "RuntimeError",
  "stage": "demucs",
  "hint": "Install demucs for vocal isolation; dubbing proceeds without it."
}
```

## Guarantees (tested)

1. `type:"error"` events ALWAYS carry a non-empty `reason`.
2. The same failure produces a backend log line with a full traceback and the
   `stage` (via `logger.exception`).
3. `detail` and `diagnostic` are sanitized: no `*TOKEN*/*KEY*/*SECRET*` values,
   no `hf_…` tokens, home dir rendered as `~`.
4. `type:"warning"` does NOT set the terminal job error; the job continues.

## Consumer (frontend)

`frontend/src/api/dub.ts` parses the event; `store/dubSlice.ts` stores it
(`dubError` = `reason`, plus structured `dubFailure`). The renderer shows
`reason` + `hint`, resolves `docs_topic`/`reason` via
`errorDocsMap.classifyError` to a deeplink, and binds "Copy diagnostic" to
`diagnostic`.
