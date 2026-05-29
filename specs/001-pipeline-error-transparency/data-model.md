# Phase 1 Data Model: Pipeline Error Transparency

No persisted entities — these are transient, in-flight shapes carried over SSE
and rendered in the frontend store. No DB, no migration.

## FailureEvent (SSE `error` payload)

Produced by `backend/core/failure.build_failure_event()`. Additive over the
current `{type:"error", error, stage?, detail?}` shape — old keys preserved.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string | yes | Always `"error"` (or `"warning"` for non-fatal degradations). |
| `reason` | string | yes | **Non-empty.** Human-readable cause. Fallback chain: `str(exc)` → `repr(exc)` → `type(exc).__name__`. |
| `error_class` | string | yes | Exception type name (e.g. `FileNotFoundError`) or `"Error"`. |
| `stage` | string | yes | Where it failed: `download`/`extract`/`demucs`/`scene`/`thumbnail`/`task`/`preflight`/`upload`. |
| `hint` | string | no | One-line "what to do". Empty string when none. |
| `docs_topic` | string | no | Taxonomy key (e.g. `PKG_RESOURCES_MISSING`) or empty. Frontend resolves to a URL. |
| `detail` | string | no | Sanitized fuller message (formerly the truncated `str(e)[:300]`). |
| `diagnostic` | string | no | Sanitized, copyable block: failure summary + env summary. |
| `error` | string | yes (compat) | Mirror of `reason` so older frontends keep working. |

### Validation / invariants

- `reason` MUST be non-empty (enforced + unit-tested).
- `detail` and `diagnostic` MUST be sanitized: no values for env vars matching
  `*TOKEN*|*KEY*|*SECRET*`, no `hf_…` tokens, home dir rendered as `~`.
- For `type:"warning"` (non-fatal degradation) the job continues; the event is
  informational and does not set the terminal job error.

## DiagnosticBlock (string content of `diagnostic`)

Composed by `failure.diagnostic(event)`. Plain text, copy-paste friendly:

```
OmniVoice diagnostic
--------------------
Stage:   extract
Error:   FileNotFoundError
Reason:  ffprobe could not open source: no such file
OS:      <platform.platform()>
Python:  <sys.version 1-line>
OmniVoice: <version>
CPU/RAM: <psutil summary>
GPU:     <cuda/mps/none + VRAM>
Engine:  <active TTS engine>
```

Reuses the opt-in bug-reporter environment capture. Excludes: audio content,
file paths under the home dir (shown relative to `~`), any secret-like env var.

## Frontend store delta (`dubSlice`)

`dubError: string` → extended so the renderer has the structured fields. Minimal
change: keep `dubError` (= `reason`) and add an optional
`dubFailure: { reason, errorClass, stage, hint, docsTopic, diagnostic } | null`.
`dubError` is never set to an empty string.
