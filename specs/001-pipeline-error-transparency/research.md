# Phase 0 Research: Pipeline Error Transparency

The spec was seeded from #131 with a complete defect + fix-sequence, and the
codebase was mapped before planning. Few open unknowns; the decisions below
resolve them.

## Decision 1 — One shared failure-event builder vs. fixing each site inline

**Decision**: Add `backend/core/failure.py` with `build_failure_event()` and route
every emit site (tasks.py, dub_pipeline.py, dub_core.py, batch.py) through it.

**Rationale**: The defect is duplicated fallback logic — each site does its own
`str(e)` (some `[:300]`, some `[:500]`, some empty). Centralizing the non-empty
guarantee + redaction + classification means a single tested code path governs
"what a failure looks like," satisfying Constitution V's "errors MUST be visible"
globally rather than per-site.

**Alternatives considered**: Patch each `except` independently — rejected: leaves
the next new emit site free to reintroduce a bare `str(e)`.

## Decision 2 — Where error classification / docs mapping lives

**Decision**: Frontend `errorDocsMap.ts` stays the source of truth for the docs
URL (it already has the 5-class taxonomy + `classifyError`). Backend emits
`error_class` + `reason` + a backend-side `docs_topic` *key* (not URL) for the
log/diagnostic only.

**Rationale**: Avoids duplicating the URL table on two sides; the frontend
already renders deeplinks. Backend only needs the class *name* for its log line
and diagnostic block.

**Alternatives considered**: Full backend URL table — rejected (duplication,
drift risk). Pure-frontend classification with backend sending only `str(e)` —
rejected: the backend log/diagnostic should also name the class.

## Decision 3 — Non-fatal degradations (demucs/scene/thumbnail)

**Decision**: Keep them non-fatal (job continues with the fallback) but emit a
visible `prep_event("warning", stage, reason)` instead of a silent
`logger.warning`-only path.

**Rationale**: These are legitimate graceful degradations, not job failures, so
they must not fail the job (backward-compat with current behavior). But "silent"
violates the transparency principle — the user should see that demucs was
skipped. A non-fatal warning event threads that needle.

**Alternatives considered**: Promote them to fatal errors — rejected: changes
current successful-with-fallback behavior, would regress real jobs.

## Decision 4 — Diagnostic block delivery

**Decision**: Include a sanitized `diagnostic` string inside the SSE error event
payload; the frontend offers a "Copy diagnostic" button. No new endpoint.

**Rationale**: The failure event is already flowing to the client; attaching the
diagnostic avoids a second round-trip and a stateful "last failure" store. The
block is built and sanitized server-side where the env info lives.

**Alternatives considered**: A `/diag/last-failure` endpoint — rejected: adds
state + an extra call for no benefit; the SSE event is the natural carrier.

## Decision 5 — Redaction reuse

**Decision**: Reuse `backend/core/logging_filter.py`'s HF-token regex; add
`*TOKEN*|*KEY*|*SECRET*` env-value redaction and home-dir → `~` in
`failure.sanitize()`. Reuse the opt-in bug-reporter's environment capture for
the diagnostic summary.

**Rationale**: Single redaction definition; consistent with Constitution I and
the bug-reporter's existing privacy contract.

## Open risk — #122 "no logs at all"

The deepest symptom (#122: no backend log lines, instrumented code never
reached) may be a *logging-configuration* gap rather than a swallow. Mitigation
in-scope: (a) guard the pre-task handlers in `dub_core.py` so failures there are
caught + logged + surfaced; (b) verify `logger.exception` in tasks.py reaches the
in-app log buffer that `LogsFooter` reads. The specific root cause of #122's
underlying error, once visible, routes to plan-01/02/03 per spec scope.
