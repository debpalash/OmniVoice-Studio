# Frontend Responsiveness: Persistence Write-Amplification Remediation Plan

| Field | Decision |
| --- | --- |
| Status | Historical coalescer plan; storage and hydration ownership superseded by PR #1636 |
| Target | One focused frontend PR |
| Priority | P1 responsiveness and data-safety hardening |
| Risk | Medium: persistence timing changes, persisted formats do not |
| Dependencies | None |
| Rollback | Revert the PR; the existing keys and schemas remain readable |

> **Successor amendment (2026-08-24, PR #1636):** the body below is retained as
> the historical PR #1541 coalescer design. Its uses of “current”, `{version: 7}`,
> and synchronous hydration describe that 2026-08-13 baseline, not today's
> runtime. PR #1636 retains the coalescer for bounded browser state, moves
> unbounded long-form data to IndexedDB, and makes store hydration explicitly
> asynchronous after window ownership is known.

### Persisted-version ownership after PR #1636

| Version/era | Owner | Data and migration contract |
| --- | --- | --- |
| Historical Zustand v4 → v5 | `frontend/src/store/index.ts` → `migrateAppStore` | The retained `version < 5` migration normalizes legacy v4 project records into the unified long-form shape. This is an old-envelope migration, not the current storage version. |
| Historical coalescer baseline v7 | PR #1541 and this plan | The complete persisted Zustand projection lived in synchronous `localStorage` as `{ state, version: 7 }`. References to v7 and synchronous `getItem` below are historical acceptance criteria. |
| Current Zustand envelope v9 | `frontend/src/store/index.ts` plus `frontend/src/utils/longformPersistence.ts` | `omnivoice.app` remains the Zustand key, but its normal localStorage copy is a bounded v9 envelope. During upgrade, the split adapter commits any legacy full long-form payload before compacting that envelope. |
| Current IndexedDB schema 1 | `frontend/src/utils/indexedDbLongformStore.ts` | `omnivoice.longform` owns the unbounded workspace payload and its writer revision. Bootstrap uses `skipHydration`, resolves main/widget ownership, and awaits the async split-store rehydrate before rendering. |

The Zustand envelope version (`9`) and IndexedDB database schema (`1`) are independent counters with separate owners; “schema v9” must not be used as a name for the IndexedDB format.

## Executive decision

The first optimization PR should remove synchronous JSON serialization and `localStorage` writes from high-frequency interaction paths. It should preserve the existing `omnivoice.app` and `omni_ui` contracts, coalesce each burst to the latest value, flush within a bounded window, and prevent deferred writes from undoing Factory Reset.

This is the best first change because it addresses a measured, cross-workspace bottleneck without combining it with a storage migration, backend change, or `App.jsx` rewrite. Incremental-dub scheduling, transactional undo, and workspace decomposition remain separate follow-ups with their own evidence and rollback boundaries.

## Evidence and diagnosis

### Static path

Two independent persistence paths run on the browser main thread:

1. Every Zustand `set` invokes the persist middleware. The middleware runs `partialize`, serializes the complete persisted projection, and calls synchronous `localStorage.setItem('omnivoice.app', ...)`, even when the mutation only changes transient state.
2. `useAppData` has a broad effect that serializes and writes `omni_ui` whenever text, dub segments, transcript, tracks, history, or a related preference changes.

The resulting hot path is:

`input -> store update -> render/effects -> full projection -> JSON.stringify -> localStorage.setItem`

The cost scales with document size rather than with the small field the user changed. `localStorage` is synchronous, so both serialization and the physical write compete with the next frame.

### Local runtime baseline

The following measurements are diagnostic baselines from commit `3e3189d04d2d6dba69b4dd07fefc8725b9c94af6`, not portable CI thresholds. Each scenario performs 20 UI-scale interactions; raw storage timing excludes `JSON.stringify`, so it is a lower bound. Two unrelated contact-key writes were excluded from the target-key counts but included in the aggregate raw timing.

| Fixture | Writes to target keys | Input-to-next-frame | Raw `setItem` time |
| --- | ---: | ---: | ---: |
| Small local state | 40 `omnivoice.app` + 20 `omni_ui` | 13.9 ms average, 18.9 ms max | 1.9 ms |
| 1,800 dub segments + 400 story tracks | 40 + 20 | 23.6 ms average, 39.0 ms max | 50.7 ms |
| 3,000 dub segments + 3,000 story tracks | 40 + 20 | Repeated 56-114 ms long tasks | 809 ms |

Representative serialized sizes were approximately 156 KB for `omnivoice.app` and 1.5 MB for `omni_ui`. A direct text-edit probe also produced one write to each key for each change.

### Baseline verification

- Baseline commit: `3e3189d04d2d6dba69b4dd07fefc8725b9c94af6`.
- `bun run test -- src/utils/prefKeys.test.js src/test/omniUiSchema.test.js src/test/dubStepRestoreClamp.test.js src/store/uiScaleMigration.test.ts src/test/dubPerLangTranslations.test.jsx src/test/dubVoiceMatchRequest.test.jsx` passes: 6 files, 35 tests.
- The production build passes. The main application chunk is approximately 381.82 KB minified / 116.27 KB gzip.
- `backend/api/routers/mcp_bindings.py` is not implicated: its list handler is a thin delegation, and the bindings panel already loads bindings and profiles concurrently.
- The large Settings/OpenAPI chunk is lazy and is not the interaction-time bottleneck targeted here.

## Goal

At the PR #1541 baseline, perform no JSON serialization or physical storage write in the originating interaction task and persist only the newest value after the burst, while retaining that baseline's synchronous hydration and recovery formats. The successor matrix above records the later hydration and format changes.

## Scope

### In scope

- One shared, typed, coalescing JSON writer for browser `localStorage`.
- A Zustand-compatible structured storage adapter that defers serialization itself.
- Deferred `omni_ui` persistence with its exact current field set.
- Trailing flush, maximum-wait flush, and page-lifecycle flush.
- Single-writer protection for the standalone Tauri capture widget.
- Factory Reset cancellation so pending values cannot recreate deleted keys.
- Deterministic unit/integration tests, a before/after browser trace, and an Unreleased changelog entry.

### Explicitly out of scope

- IndexedDB, workers, new storage keys, schema changes, or a Zustand version bump.
- Removing duplicated fields from `omni_ui` or changing restore precedence.
- Backend/API/database changes, including MCP bindings.
- Debouncing `/tools/incremental` in this PR.
- Changing undo/redo semantics or snapshot representation.
- Splitting stores, decomposing `App.jsx`, or moving workspace imports.
- New dependencies, user-visible strings, locale files, or an app version bump.
- Hardware-sensitive timing assertions in CI.

## Historical PR #1541 compatibility and safety invariants

The implementation must preserve all of the following:

| Contract | Required invariant |
| --- | --- |
| Zustand key | `omnivoice.app` |
| Zustand envelope at the #1541 baseline | `{ state, version: 7 }`, serialized with normal `JSON.stringify` semantics |
| Zustand projection | Existing `partialize` fields and transient-field stripping remain semantically unchanged |
| Zustand migration at the #1541 baseline | Existing v1-v7 migration behavior remains unchanged |
| Legacy recovery key | `omni_ui` |
| Legacy recovery shape | Exact current field names, omission behavior, and `sanitizeOmniUi` restore path |
| Hydration at the #1541 baseline | Synchronous; no loading gate or async race is introduced |
| Durability | When serialization/storage succeeds and the browser runs timers, a dirty key is attempted within 1,000 ms of its first unflushed change |
| Lifecycle | `pagehide` and hidden-document events attempt pending values; both events together cause at most one physical write per unchanged generation |
| Reset | A removed preference key cannot be recreated by old or newly queued work before the reset reload |
| Desktop windows | Persistence starts in an unknown/read-only role; the resolved main webview is activated as the only writer and the standalone widget stays read-only |
| Privacy | Logs may contain a key and error name, never persisted user content |
| Platform parity | Same default behavior on macOS, Windows, Linux, browser, and Docker |

For PR #1541, direct consumers such as `utils/donationMoments.js`, E2E state seeding, long-form recovery, and the preference-key registry had to continue parsing the then-existing envelope without changes. The donation opt-out's primary `omnivoice.donate.optOut` flag remained an immediate, separate write; its immediate behavior and flushed legacy-envelope fallback required compatibility coverage.

Concurrent browser/Docker tabs are explicitly not promoted to a coordinated multi-writer system in this PR. They retain unsupported last-physical-writer-wins behavior. The PR description must state that boundary; adding cross-tab revisions or `BroadcastChannel` arbitration would be a separate data-consistency design.

## Proposed design

### 1. Shared coalescing writer

Create `frontend/src/utils/coalescedJsonStorage.ts` with an injectable core and one application singleton. The public contract should be small:

| API | Contract |
| --- | --- |
| `queueJsonWrite(key, readLatestValue)` | Mark `key` dirty and replace its lazy provider; return a generation-bound disposer that can cancel only this registration |
| `createZustandJsonStorage()` | Return a `PersistStorage` adapter whose `getItem` is synchronous and whose `setItem` queues the structured `StorageValue` |
| `flushPendingWrites()` | Synchronously serialize and attempt every pending write; return a summary for tests/diagnostics |
| `discardPendingWrites(predicate?)` | Cancel timers and pending values matching a key predicate |
| `suspendJsonWrites(predicate)` | Discard matching work and reject later matching queues until the returned resume callback is used |
| `configurePersistenceRole(role)` | Resolve the singleton from initial `unknown` to `main` or `readonly`; activate staged main work or discard all staged widget work |
| Adapter `removeItem(key)` | Cancel/stage-remove that key before raw removal; propagate main-window removal errors; remain inert in a read-only widget |
| `installPersistenceLifecycleFlush()` | Install the singleton listener pair once for the main bootstrap owner; cleanup is idempotent and reserved for tests/HMR teardown |

Required scheduling semantics:

- Quiet delay: 250 ms after the latest value for a key.
- Hard maximum: 1,000 ms from the first unflushed value for that key; continuous input must not starve persistence.
- Last scheduled value wins.
- The queued provider is evaluated on the JavaScript thread only at flush, so the value serialized is the latest application value at flush time rather than a deep-cloned event-time object.
- The quiet timer resets on replacement; the maximum timer does not.
- A successful maximum flush starts a new window for later updates.
- Use standard timers. Do not make `requestIdleCallback` part of the correctness path; availability differs across the supported webviews.
- Do not wrap `createJSONStorage`. It stringifies before calling the adapter and would leave the main cost inside the interaction path.

Flush behavior:

1. Read the latest provider and serialize only at flush time.
2. Compare the serialized value with the currently durable raw value and skip an identical physical write.
3. Call `setItem` once at most for each dirty key in that flush.
4. Mark the entry clean only after a successful write or confirmed identical value.
5. Ensure an old timer cannot commit after a newer value, cancellation, or removal.

`getItem` must evaluate and return the latest pending structured value when one exists; otherwise it must synchronously parse the durable raw value. This keeps explicit Zustand `rehydrate()` calls internally consistent without changing cold-start hydration.

The lazy-provider contract avoids copying a 1.5 MB document on every input. Task 0 must audit every persisted nested container for in-place mutation. React/Zustand setters are expected to publish replacements; any isolated violation must be fixed or explicitly converted to a safe value provider before wiring this scheduler. If the audit reveals a broad mutable-data convention, stop and redesign this PR rather than hiding a state-model refactor inside it. A deterministic test must pin current-at-flush semantics: mutate/replace the provider's source without serializing, then flush and verify the current value is written.

### 2. Failure semantics

- `JSON.stringify` or storage failures must not escape through a Zustand setter, React effect, or lifecycle event.
- A serialization failure discards that invalid value after a warning; a later valid update can proceed.
- Every flush attempt clears both timers first.
- A quota/security/write failure leaves the previous durable blob untouched and keeps the newest value dirty, but disarms automatic retry. A later queue starts a fresh 250/1,000 ms window; an explicit/lifecycle flush attempts it once. Advancing timers alone must not create a retry loop.
- A multi-key flush is isolated per key: successful keys become clean; a failed key remains dirty; retrying the failed key must not rewrite successful siblings.
- Warn once per key/operation/error class to avoid console floods.
- Never log the value, text, segment data, or serialized payload.
- Adapter `removeItem` and Factory Reset remain truthful: cancel pending work first, then allow a main-window raw removal failure to reach the caller.
- The 1,000 ms durability statement applies only when the browser schedules the timer and storage succeeds. Timer throttling, quota denial, a crashed process, or a failed lifecycle write cannot be promised durable; these cases are observable and non-crashing.

### 3. Main-window ownership

The Tauri widget imports the same Zustand store in a separate webview and calls setters for runtime dictation state. Today those transient setters can persist an older projection over the main window's current preferences.

Do not duplicate widget detection inside the storage utility. `detectIsWidget()` already resolves the initialization marker, Tauri `getCurrentWindow().label`, and legacy development URL. `bootstrapApp()` must pass that exact resolved result to `configurePersistenceRole()` before React renders.

The singleton begins in `unknown`: hydration reads work, but writes/removals can only be staged and no timer, serialization, or raw mutation may run. Resolving `main` replays only the latest staged operation per key and starts its 250/1,000 ms clocks at activation; time spent awaiting role detection does not count against a window in which writing was forbidden. Resolving `readonly` discards staged work and makes both `setItem` and `removeItem` inert. This is necessary because the store is statically imported before asynchronous window detection completes. The in-page browser capture pill shares the main document and remains writable.

Tests that import the store without `bootstrapApp()` must use an isolated writer or explicitly configure `main` in setup and reset role, staged work, suspensions, timers, and listeners in teardown. Existing migration tests must clear scheduler state before seeding raw fixtures; otherwise a staged pending value can mask the fixture during `persist.rehydrate()`.

### 4. Lifecycle ownership

After `detectIsWidget()` resolves, `bootstrapApp()` should configure the role and install lifecycle flushing before rendering only for the main window. Bootstrap is the sole production owner; an isolated writer instance or explicit teardown resets listeners in tests.

- Flush on `pagehide`.
- Flush on `visibilitychange` only when `document.visibilityState === 'hidden'`.
- Do not add `beforeunload`; it is unnecessary and can interfere with back/forward caching.
- Lifecycle flush uses the same generation/cancellation checks as timer flushes. If hidden visibility and `pagehide` both fire, the second invocation observes a clean generation and performs no second serialization/write.
- Treat page lifecycle events as best-effort only for asynchronous IndexedDB work. On desktop, prevent the first native exit request, ask the main webview to await the long-form commit and then drain the compact local envelope, and acknowledge exit afterward; a three-second native timeout must still close or relaunch if the webview cannot respond. Intentional frontend reload/relaunch actions await the same ordered helper before navigating.

### 5. Zustand integration

In `frontend/src/store/index.ts`:

- Replace `createJSONStorage(() => localStorage)` with the structured coalescing adapter.
- Preserve `name`, `partialize`, `version: 7`, and `migrate` semantically unchanged.
- Keep the long-form projection and removal of `generating`/`audioUrl` intact.
- Do not add `text`, dub segments, or other legacy recovery fields to this key.

This PR deliberately leaves `partialize` synchronous. If post-change profiling shows its `storyTracks.map(...)` is still material, optimize projection scheduling in a separate change rather than replacing hydration and migration machinery here.

### 6. `omni_ui` integration

In `frontend/src/hooks/useAppData.js`:

- Build the same recovery object with the same property order and values.
- Replace direct `JSON.stringify` + `localStorage.setItem` with a lazy `queueJsonWrite('omni_ui', readLatestOmniUi)` provider.
- Keep synchronous parsing, `sanitizeOmniUi`, legacy `clone`/`design` handling, and dub-step clamping unchanged.
- Add an explicit `omniUiRestoreComplete` readiness state. The initial persistence effect must queue nothing; the restore effect sets all recovered values and flips readiness in the same batch, and the subsequent render supplies the first writable value.
- Prove an immediate lifecycle event between the initial effects and the restored render cannot persist defaults.
- Feed a lazy latest-value provider to the writer and invoke its generation-bound disposer in effect cleanup. An obsolete StrictMode/unmounted effect may cancel only its own registration, never a newer mount's provider. Do not deep-clone at queue time; the immutability audit and current-at-flush contract above define ownership.

### 7. Factory Reset integration

In `clearLocalPreferences`:

1. Suspend and discard every pending key for which `isPrefKey(key)` is true.
2. Enumerate and remove durable preference keys exactly as today.
3. Preserve connection credentials and user-data keys exactly as today.

The suspension lasts for the remainder of the successful reset session, because background store activity can occur during the 400 ms before reload. Wrap the entire enumerate-and-remove transaction, including `length`, `key()`, and key filtering/access, so any failure resumes writes before rethrowing. This prevents the existing reset error path from leaving persistence silently disabled. This ordering is mandatory: a stale timer, a new post-reset store update, or the later `pagehide` could otherwise resurrect `omnivoice.app` or `omni_ui` after deletion. Tests that simulate a successful reset without a real reload must explicitly reset the isolated writer afterward.

## File-level change budget

| File | Change |
| --- | --- |
| `frontend/src/utils/coalescedJsonStorage.ts` | New lazy scheduler, Zustand adapter, role configuration, suspension, and lifecycle ownership |
| `frontend/src/utils/coalescedJsonStorage.test.ts` | New deterministic scheduler/failure/lifecycle/widget tests |
| `frontend/src/store/index.ts` | Swap storage adapter only; preserve projection and migrations |
| `frontend/src/store/persistenceScheduling.test.ts` | New Zustand envelope, coalescing, hydration, and long-form projection tests |
| `frontend/src/hooks/useAppData.js` | Gate restore readiness and queue the existing `omni_ui` value provider |
| `frontend/src/hooks/useAppData.persistence.test.jsx` | New restore and burst-write integration tests |
| `frontend/src/main-app.jsx` | Configure the resolved window role, then install main-only lifecycle flushing |
| `frontend/src/main-app.test.jsx` | Extend label/marker/URL role-order coverage |
| `frontend/src/utils/prefKeys.js` | Suspend pending and future preference writes across successful reset |
| `frontend/src/utils/prefKeys.test.js` | Add no-resurrection coverage |
| `frontend/src/utils/donationMoments.test.js` | Preserve immediate primary opt-out and flushed legacy fallback behavior |
| `frontend/e2e-perf/responsiveness.spec.ts` | Add opt-in production-bundle fixture, route mocks, instrumentation, and JSON artifact; no wall-clock CI assertions |
| `frontend/playwright.perf.config.ts` | Add cross-platform production-preview benchmark config derived from the existing prod smoke config |
| `CHANGELOG.md` | One Unreleased performance/fix line once the PR number exists |

No backend, locale, package manifest, lockfile, or persisted-schema file should change.

## Implementation sequence

### Task 0: Freeze the current contracts

- [ ] Record the parent commit SHA and rerun the browser baseline with identical fixtures.
- [ ] Add characterization assertions for the exact Zustand envelope, version, legacy snapshot keys, direct readers, and reset key registry; these must pass before production changes.
- [ ] Add integration assertions for burst write counts and initial-default overwrite behavior; these must fail on the current immediate writer for the expected reason.
- [ ] Confirm existing direct readers (`donationMoments`, E2E helpers) against the frozen fixture.
- [ ] Audit the persisted Zustand projection and every `omni_ui` nested value for in-place mutation. Record the search paths in the PR; resolve any hit before adopting lazy providers.
- [ ] Keep the current 35 targeted tests green while adding fail-before cases.

Exit condition: characterization tests pass; behavioral integration tests fail only because writes are immediate/repeated or startup persistence is ungated. Scheduler-specific unit tests are introduced with the new utility rather than pretending to fail before their seam exists.

### Task 1: Implement the storage primitive

- [ ] Implement per-key quiet and maximum timers with injected clock/storage/serializer dependencies.
- [ ] Make value materialization and serialization lazy and deduplicate against the durable raw string.
- [ ] Implement synchronous pending/durable reads.
- [ ] Implement generation-bound provider disposers plus flush, discard, and removal guards.
- [ ] Implement predicate-based suspension for destructive reset windows.
- [ ] Define failed attempts as timer-disarmed; a later queue starts a new maximum window.
- [ ] Isolate partial failures across multiple dirty keys.
- [ ] Recover from throwing providers, durable reads, malformed JSON, and raw writes without poisoning later valid operations.
- [ ] Deduplicate warnings and prove no value, serialized payload, or error message containing user content is logged.
- [ ] Contain and deduplicate errors without logging payloads.
- [ ] Add `unknown -> main|readonly` role configuration; unknown work cannot reach raw storage.
- [ ] Make adapter removal obey cancellation, role, and error-propagation contracts.
- [ ] Add single-owner lifecycle installation and idempotent teardown.
- [ ] Add a full isolated-writer reset hook for tests: role, staged operations, suspensions, timers, listeners, and warning registry.

Exit condition: all utility tests pass without importing React or the application store.

### Task 2: Wire Zustand without changing its contract

- [ ] Replace `createJSONStorage` with the structured adapter.
- [ ] Keep `partialize`, `version`, and `migrate` unchanged except for any mechanical key constant extraction needed by tests.
- [ ] Prove that 100 rapid transient updates cause zero synchronous serializations/writes and at most one trailing write.
- [ ] Prove the final JSON contains the latest persisted update and `{ version: 7 }`.
- [ ] Prove `persist.clearStorage()` cannot be undone by timers/lifecycle and is inert in the widget role.
- [ ] Update raw-seeded migration tests to reset pending/staged writer state before `rehydrate()`.
- [ ] Prove long-form fields round-trip while `generating` and `audioUrl` remain excluded.
- [ ] Prove v6-to-v7 and older accepted fixtures still hydrate synchronously.

Exit condition: existing store migration tests plus the new scheduling suite pass.

### Task 3: Wire `omni_ui`

- [ ] Extract snapshot construction only if needed for a precise shape test; do not redesign ownership.
- [ ] Add the restore-complete state gate, then queue a latest-value provider rather than serializing in the effect.
- [ ] Add a seeded-restore test proving the initial defaults never become the durable winner.
- [ ] Dispatch lifecycle flush before the post-restore render and prove it writes no defaults.
- [ ] Add a burst test proving the latest text and dub segment data win after one write.
- [ ] Cover StrictMode double effects plus unmount/remount before the quiet timer; no obsolete provider may win.
- [ ] Re-run schema, legacy-mode, and restored-dub-step tests unchanged.

Exit condition: a reload after explicit flush restores a deep-equal latest snapshot through `sanitizeOmniUi`.

### Task 4: Close lifecycle and reset races

- [ ] Configure the exact `detectIsWidget()` result before render, then install main-window lifecycle flushing.
- [ ] Prove marker, Tauri-label-only, and legacy-URL detection; pre-role setters cannot leak from a widget.
- [ ] Prove unknown-role set→remove ends removed, remove→set activates the set, and the 1-second clock starts at main-role activation.
- [ ] Prove duplicate installation does not duplicate listeners and teardown removes the exact callbacks.
- [ ] Prove hidden visibility plus `pagehide` produce at most one serialization/write for an unchanged pending generation.
- [ ] Suspend pending and future preference values before Factory Reset removal.
- [ ] Queue another store update, advance every fake timer, and dispatch lifecycle events after reset; both target keys must remain absent.
- [ ] Prove raw removal and enumeration/access failures resume normal persistence before propagating the error.
- [ ] Prove preserved connection/data keys remain untouched.
- [ ] Prove standalone-widget setters and `persist.clearStorage()` cannot mutate durable state, while main-window operations still work.

Exit condition: neither stale timers, lifecycle events, StrictMode, nor the widget can overwrite newer or deliberately removed durable state.

### Task 5: Verify and document

- [ ] Run targeted tests during iteration.
- [ ] Run frontend typecheck, lint, format check, full Vitest, build, and production-bundle smoke.
- [ ] Run the repository's backend suites offline before landing, despite no backend diff, because they are merge gates.
- [ ] Check in the opt-in Playwright benchmark with deterministic fixture generation and JSON output.
- [ ] Run an alternating parent/implementation/parent (A/B/A) benchmark sequence with five repeats per leg; repeat if same-commit variance exceeds 5%.
- [ ] Attach counts, payload sizes, p50/p95/max interaction latency, and long-task evidence to the PR.
- [ ] Open the draft PR to obtain its number, then add/amend the Unreleased changelog line before requesting review.

Exit condition: deterministic acceptance criteria pass; build/merge gates are green; browser timing is attached as reproducible decision evidence rather than a hardware-sensitive CI gate.

## Required deterministic tests

| Scenario | Required result |
| --- | --- |
| 100 replacements in one burst | 0 synchronous provider/serializer/write calls; 1 trailing write with value 100 |
| Lazy provider source changes before flush | Current-at-flush value is written; no deep clone or serialization occurred while queueing |
| Obsolete provider disposer | Cancels only its generation; it cannot cancel a newer provider for the same key |
| Continuous updates beyond 1 second | A maximum-wait flush occurs; later updates start a new window |
| Identical durable value | Serialization may occur at flush; physical `setItem` is skipped |
| Explicit `getItem` before flush | Latest pending structured value is returned synchronously |
| Hidden document followed by `pagehide` | At most one serialization/write for the unchanged pending generation |
| Cancel/remove followed by all timers | Deleted key stays absent |
| Zustand `persist.clearStorage()` | Pending/staged key is cancelled; timer/lifecycle cannot resurrect it |
| Successful reset followed by a new store update | Matching writes remain suspended and deleted keys stay absent until reload |
| Failed reset removal | Error propagates and write suspension is released |
| Reset enumeration/access failure | Error propagates and write suspension is released |
| Serialization error | Caller does not throw; invalid entry does not poison a later valid update |
| Provider throws | Caller/lifecycle does not crash; invalid entry is discarded and a later valid provider succeeds |
| Durable `getItem` throws | Hydration falls back to defaults without crashing; a later valid queue can persist |
| Malformed durable JSON | Hydration follows the current safe fallback/migration behavior and later persistence repairs it |
| Quota/security error | Caller does not throw; old durable value remains; timers do not retry; one later queue starts one new window |
| Two-key partial failure | Successful key stays clean; failed key alone retries later |
| Unknown staged set→remove / remove→set | Only the final operation activates on `main`; its clocks start at activation |
| Unknown/standalone-widget update and removal | Reads work; no raw mutation before role resolution or after read-only resolution |
| Duplicate lifecycle installation/teardown | One listener set; exact callbacks are removed once |
| Zustand transient burst | At most one `omnivoice.app` write and unchanged v7 envelope |
| Legacy recovery burst | At most one `omni_ui` write with latest text/segments |
| Seeded initial recovery | Defaults never overwrite restored state, including immediate lifecycle and StrictMode/unmount races |
| Factory Reset race | Both pending target keys remain absent after timers and lifecycle events |
| Donation opt-out compatibility | Primary opt-out remains immediately visible; flushed v7 legacy fallback remains readable |
| Repeated warning | One warning per key/operation/error class; no value, serialized payload, or content-bearing error message appears |

Do not use elapsed milliseconds as Vitest pass/fail assertions. Use fake timers and call counts for CI; use browser traces for performance evidence.

## Verification commands

Run targeted tests while iterating:

```powershell
cd frontend
bun run test -- src/utils/coalescedJsonStorage.test.ts src/store/persistenceScheduling.test.ts src/hooks/useAppData.persistence.test.jsx src/main-app.test.jsx src/utils/prefKeys.test.js src/utils/donationMoments.test.js src/test/omniUiSchema.test.js src/test/dubStepRestoreClamp.test.js src/store/uiScaleMigration.test.ts
```

Run the frontend landing gate:

```powershell
cd frontend
bun run typecheck:ci
bun run lint
bun run format:check
bun run test
bun run test:prod-bundle
bun run test:legacy
```

`test:prod-bundle` already performs the production build before its smoke test, so a separate `bun run build` would only duplicate work. Run it separately only when build output is needed during iteration.

Run the backend CI-equivalent suites from the repository root with a genuinely empty Hugging Face cache:

```powershell
$previousOffline = $env:HF_HUB_OFFLINE
$previousCache = $env:HF_HUB_CACHE
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$emptyHfCache = [IO.Path]::GetFullPath((Join-Path $tempRoot ("omnivoice-hf-empty-" + [guid]::NewGuid())))
if (-not $emptyHfCache.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cache path' }
New-Item -ItemType Directory -Path $emptyHfCache | Out-Null
try {
  if (@(Get-ChildItem -LiteralPath $emptyHfCache -Force).Count -ne 0) { throw 'HF cache is not empty' }
  $env:HF_HUB_OFFLINE = '1'
  $env:HF_HUB_CACHE = $emptyHfCache
  uv run --no-sync pytest tests/ -q --tb=short
  if ($LASTEXITCODE -ne 0) { throw "tests/ failed with exit code $LASTEXITCODE" }
  uv run --no-sync pytest backend/tests/ -q --tb=short
  if ($LASTEXITCODE -ne 0) { throw "backend/tests/ failed with exit code $LASTEXITCODE" }
} finally {
  $env:HF_HUB_OFFLINE = $previousOffline
  $env:HF_HUB_CACHE = $previousCache
  Remove-Item -LiteralPath $emptyHfCache -Recurse -Force
}
```

These are repository landing gates, not evidence that the frontend optimization itself works. The unique cache and restored environment prevent a populated developer cache or leaked shell state from masking failures.

## Browser validation protocol

Check in `frontend/e2e-perf/responsiveness.spec.ts` and `frontend/playwright.perf.config.ts` as a non-CI production-bundle benchmark harness. Keeping it outside `e2e-prod/` ensures the existing production-smoke CI command cannot discover this manual benchmark. The config must mirror `playwright.prod.config.ts`: build the real `dist/`, serve it with `vite preview` on a dedicated strict port, honor `PLAYWRIGHT_CHROMIUM`, use `/usr/bin/chromium` only when it exists, and otherwise fall back to Playwright's bundled browser. It must not use the dev-server E2E config.

The spec must generate fixtures from fixed seeds, install all required API/WebSocket route mocks or a deterministic bootstrap bypass before navigation, and make no assumption that a backend is running on port 3900. It must use `page.addInitScript` before application code to wrap target-key storage writes and `PerformanceObserver`, drive selectors rather than arbitrary sleeps, and emit machine-readable JSON under Playwright's `test-results` directory. It asserts final state and observable deterministic write counts, but it does not assert elapsed milliseconds or claim to observe serializer task identity. The injected Vitest scheduler tests own the stronger “no provider/serializer execution in the originating task” assertion.

Run it with:

```powershell
cd frontend
node ./node_modules/@playwright/test/cli.js test --config=playwright.perf.config.ts responsiveness.spec.ts --repeat-each=5 --reporter=line
```

Run `bun install --frozen-lockfile` first. The command above is verified from `frontend/` to resolve the installed Playwright 1.61.0 CLI by exact package path; do not replace it with `bun x playwright` or a global `bun run` shim, which can select another Playwright version, fetch a package, or even resolve a stale Windows shim. If `PLAYWRIGHT_CHROMIUM` is unset and no supported system Chromium exists, install the pinned browser once with `node ./node_modules/@playwright/test/cli.js install chromium`. This adds no project dependency, and the dedicated config provides the cross-platform executable fallback. The config owns port 4174 and never reuses an existing listener, so a stale preview fails loudly and every successful run tears down the exact server it started.

Use the same browser version, build mode, machine power state, and fixture on both commits.

1. Instrument target-key `setItem` count, serialized byte length, and call duration before the app loads.
2. Observe long tasks and event-to-next-`requestAnimationFrame` latency.
3. Seed 1,800 dub segments and 400 story tracks using the current v7/legacy formats.
4. Run 20 UI-scale updates 25 ms apart, keeping the complete burst below the hard maximum.
5. Run 20 Studio text updates under the same cadence.
6. End each burst, wait 1,250 ms, and verify the durable latest values by parsing both keys.
7. Run A/B/A (parent, implementation, parent), five repeats per leg; compare median p95 and retain every JSON artifact.
8. Run the 3,000/3,000 fixture once as a diagnostic stress case, not as a product limit.

Deterministic merge gates:

- A sub-1-second 20-event burst produces no more than one physical write per target key after the burst: at least a 96% reduction from the measured 60 target writes.
- Injected utility/integration tests prove no target-key provider, serialization, or write executes in the originating input task; the browser harness independently verifies observable physical writes.
- Both parsed durable values contain the final interaction's state.

Manual decision thresholds, not CI merge gates:

- Target at least 20% lower median p95 input-to-frame latency on the representative fixture.
- Target no more than 5% median-p95 regression on the small fixture.
- Expect no greater-than-50-ms task during the interaction burst with persistence work in its trace stack.
- If either target is missed or same-commit A/A variance exceeds 5%, treat the timing as inconclusive, attach the raw artifacts, and re-profile. Do not widen this PR merely to manufacture a favorable number.

## Acceptance criteria

The PR is ready for review only when all are true:

- [ ] Existing keys, field sets, JSON envelope, version, migrations, and restore behavior are unchanged.
- [ ] One burst yields at most one trailing write per dirty key and the newest value wins.
- [ ] Normal continuous input schedules an attempt within 1 second; failure and timer-throttling limits are documented accurately.
- [ ] With healthy storage, orderly hide/navigation flushes synchronously and a hard process termination can lose at most the scheduled unflushed window; failure/throttling exceptions are documented.
- [ ] Factory Reset cannot be undone by pending work.
- [ ] Unknown-role work cannot reach raw storage, and the standalone widget cannot write or remove main-window preferences.
- [ ] Storage failures cannot crash input handling and never leak user content to logs.
- [ ] Deterministic tests meet merge gates; the checked-in A/B/A benchmark and raw timing artifacts are attached as non-CI decision evidence.
- [ ] Frontend and backend merge gates pass.
- [ ] No dependency, lockfile, locale, backend, persisted-version, or package-version change is present.
- [ ] The PR remains reviewable as one persistence concern; no opportunistic refactor is included.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Up to the scheduled window of edits lost on a hard process kill | 250 ms quiet flush, 1,000 ms maximum attempt, hidden/pagehide flush; disclose timer/storage limitations |
| Pending or newly queued write recreates reset data | Suspend by `isPrefKey` before raw removal; post-reset update + timer + lifecycle regression test |
| Widget flushes stale main-window state | Resolve the existing detector before render; unknown cannot write; widget set/remove operations stay read-only |
| Older timer overwrites a newer value | Per-key generation token and last-value-wins tests |
| Mutable data changes before deferred serialization | Lazy current-value provider plus a documented mutation audit; never claim event-time snapshot semantics |
| Quota or disabled storage breaks the UI | Contain write errors, preserve the previous durable blob, disarm timers, retry only on later activity/explicit flush |
| Concurrent browser tabs overwrite each other | Keep the unsupported last-physical-writer boundary explicit; do not add an incomplete conflict protocol here |
| Trailing flush is still expensive for pathological documents | Measure it; do not hide it. Escalate to document storage/worker design in a separate PR if representative flush exceeds the budget |
| Middleware contract accidentally changes | Exact envelope/fixture tests plus existing migration and direct-reader suites |
| Lifecycle listeners duplicate in development/tests | One production owner, isolated test instances, idempotent teardown, and duplicate-install test |
| Timing benchmark flakes in CI | Keep wall-clock evidence informational/manual; gate deterministic operation counts |

## Rollback plan

This was PR #1541's rollback plan: no data migration was then required because both builds read the same v7 envelope. It is not a current rollback instruction after PR #1636; reverting the split v9/IndexedDB storage requires its migration and downgrade guarantees rather than assuming a v7-only localStorage layout.

## Follow-up queue

These are intentionally not part of the first PR:

1. **Incremental dub scheduling.** Add a 300 ms debounce, pass `AbortController.signal` through `apiPost`, use a monotonic request revision, cancel outside Dub, and prove one request per burst plus stale-response rejection.
2. **Transactional dub undo.** Profile `pushUndo`, which currently stringifies the complete segment array per edit and retains up to 50 snapshots. If material, group edits by segment/field and focus or idle boundary while preserving one-step undo behavior.
3. **Workspace isolation.** Profile React commits after persistence remediation; then extract one workspace at a time, moving heavy hooks/imports behind lazy boundaries. Source length and selector count alone are not success metrics.
4. **Document storage migration — completed by successor PR #1636.** The Zustand envelope is now v9, while IndexedDB schema 1 stores unbounded long-form documents with migration, downgrade, reset, quota, and async-hydration coverage. No second migration is pending from this historical plan.

Each follow-up must begin from a fresh trace. None should be pulled into this PR merely because it is nearby.
