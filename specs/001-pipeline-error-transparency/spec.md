# Feature Specification: Pipeline Error Transparency

**Feature Branch**: `001-pipeline-error-transparency`

**Created**: 2026-05-29

**Status**: Draft

**Input**: plan-04 (#131); children #122, #63. "No more silent 'unknown error'."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See why a job actually failed (Priority: P1)

A user runs a dubbing or extract job and it fails. Today they see only
"extract: unknown error" with no indication of cause. After this change, the
failure message names the real cause in plain language and tells them what to
do next (e.g., "Source media has no audio track — pick a file with audio", or a
link to the matching troubleshooting doc).

**Why this priority**: Until the failure reason is visible to the user, every
downstream bug is un-triageable and every job failure is a dead end. This is the
single highest-leverage slice — it delivers value on its own.

**Independent Test**: Trigger any pipeline failure (e.g., feed a corrupt or
audio-less file) and confirm the UI shows a specific, human-readable cause
instead of "unknown error".

**Acceptance Scenarios**:

1. **Given** a media file that fails to extract, **When** the user starts the
   job, **Then** the UI shows a specific cause (error type + one-line "what to
   do") and never a bare "unknown error".
2. **Given** a failure that maps to a known troubleshooting topic, **When** the
   error is shown, **Then** the user is offered the matching docs deeplink.
3. **Given** any failure, **When** it surfaces, **Then** the reason text is
   non-empty.

---

### User Story 2 - Full failure detail in the logs (Priority: P2)

A user (or the maintainer helping them) opens the backend logs after a failure
and finds the complete exception — type, message, and stack trace — with enough
context (which stage, which input) to diagnose it. Today the logs can be
completely silent: in #122 the instrumented code is never even reached.

**Why this priority**: Self-describing logs turn a low-information report into an
actionable one and make the maintainer's triage possible without a live repro.

**Independent Test**: Force a failure, then inspect the backend log and confirm
a full traceback with stage/context is present for that job.

**Acceptance Scenarios**:

1. **Given** a pipeline failure at any stage, **When** it occurs, **Then** the
   backend log contains the real exception with a full stack trace and the
   failing stage/context.
2. **Given** an exception thrown before the main ingest stage is reached,
   **When** it occurs, **Then** it is still logged (no swallowed/short-circuited
   failures).

---

### User Story 3 - Copyable diagnostic block (Priority: P3)

When a job fails, the user can copy a self-contained diagnostic block (cause,
stage, sanitized environment summary) to paste into a bug report, so even a
terse report is answerable.

**Why this priority**: A prevention net that shrinks low-information reports
(#63-style). Builds on US1/US2; valuable but not required for the core fix.

**Independent Test**: Trigger a failure, use the "copy diagnostic" affordance,
and confirm the copied text contains the cause, stage, and a sanitized
environment summary — and nothing sensitive.

**Acceptance Scenarios**:

1. **Given** a failed job, **When** the user copies the diagnostic block,
   **Then** it contains the failure cause, stage, and a sanitized environment
   summary.
2. **Given** the diagnostic block, **When** it is generated, **Then** it
   contains no secrets (no `*TOKEN*`/`*KEY*`/`*SECRET*` values) and no absolute
   home paths (home dir shown as `~`).

### Edge Cases

- **Failure before any stage runs** (setup/validation): still produces a
  specific reason and a log entry — this is the #122 case.
- **Non-exception failures** (a stage exits non-zero, a subprocess like ffmpeg
  fails, a None/empty result): surfaced as a specific reason, not "unknown".
- **WAV-only input** that fails without touching the ffmpeg/extract path: same
  transparency guarantees apply.
- **Failure cause has no matching docs topic**: show the specific cause without
  a deeplink rather than suppressing the message.
- **Very long or multi-line underlying error**: UI shows a concise summary;
  full detail remains in logs and the diagnostic block.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST surface a specific, human-readable failure reason
  for every pipeline failure (dub, extract, ingest). A bare "unknown error" MUST
  never be the only thing shown.
- **FR-002**: Every failure reason presented to the user MUST be non-empty and
  MUST include the underlying error type plus a one-line actionable hint.
- **FR-003**: The system MUST log the real exception — type, message, full stack
  trace — together with the failing stage and relevant input context, for every
  failure path, including failures that occur before the main ingest stage.
- **FR-004**: The system MUST NOT swallow or short-circuit pipeline exceptions
  without logging them.
- **FR-005**: When a failure maps to a known troubleshooting topic, the system
  MUST offer the corresponding docs deeplink (reusing the existing error→docs
  mechanism).
- **FR-006**: The system MUST emit a structured failure event to the frontend so
  the frontend always receives a non-empty machine-readable reason (not just a
  display string).
- **FR-007**: The system MUST provide a copyable diagnostic block containing the
  cause, failing stage, and a sanitized environment summary.
- **FR-008**: The diagnostic block and any logged context MUST redact secrets
  (values of env vars matching `*TOKEN*`/`*KEY*`/`*SECRET*`) and MUST strip
  absolute home paths (render the home directory as `~`).
- **FR-009**: Behavior MUST be identical by default on macOS, Windows, and Linux
  (no platform-divergent default error handling).
- **FR-010**: The change MUST be backward-compatible — no change to project data,
  no schema migration, and existing successful jobs behave exactly as before.

### Key Entities

- **Failure event**: a structured record of a pipeline failure — cause/error
  type, human-readable reason, actionable hint, optional docs topic, failing
  stage, and timestamp. Delivered to the frontend and used to render the message
  and the diagnostic block.
- **Diagnostic block**: a user-copyable, sanitized text rendering of a failure
  event plus environment summary, intended for pasting into a bug report.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of induced pipeline failures (bad input, failed remote
  ingest, WAV-only failure) display a specific cause in the UI — 0% show a bare
  "unknown error".
- **SC-002**: 100% of induced pipeline failures produce a backend log entry
  containing a full stack trace and the failing stage.
- **SC-003**: Every failure delivered to the frontend carries a non-empty reason
  (no empty/placeholder reason in any tested path).
- **SC-004**: A user can produce a copyable diagnostic block for a failed job in
  one action, and that block contains no secrets or absolute home paths in any
  tested case.
- **SC-005**: The three Test-matrix triggers from #131 (extract-fails,
  remote-ingest-fails, WAV-only-fails) all satisfy SC-001 and SC-002 under
  automated test.

## Assumptions

- An error→docs deeplink mechanism already exists (shipped on the onboarding /
  bug-report work) and can be reused for FR-005; this feature wires causes to it
  rather than building it anew.
- The frontend already has a place to render job failures (toast/status) that
  can be extended to show a specific reason and a "copy diagnostic" affordance.
- "Sanitized environment summary" reuses the redaction rules already defined for
  the opt-in bug reporter (OS/CPU/GPU/versions; no audio, no secrets, no home
  paths).
- Identifying and fixing the *root cause* of any specific failure once it is
  visible is out of scope here and routes to plan-01/02/03 (#128–130).
