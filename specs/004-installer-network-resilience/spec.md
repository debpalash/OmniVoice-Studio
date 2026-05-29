# Feature Specification: Installer Bootstrap Network Resilience

**Feature Branch**: `004-installer-network-resilience` | **Created**: 2026-05-29
**Status**: Draft | **Input**: plan-03 (#130); children #60, #57, #127

## User Scenarios & Testing *(mandatory)*

### User Story 1 — First-run works on a GitHub-blocked network (Priority: P1)

A user on a network that blocks/can't resolve GitHub launches OmniVoice. Today
the Tauri bootstrap runs `uv venv --managed-python`, which downloads
python-build-standalone from GitHub with no mirror and a short retry budget, so
it dies with a DNS/tunnel error and the install is dead-on-arrival (#60). After
this change the bootstrap sets a mirror cascade + longer timeouts/retries and,
if all mirrors fail but a compatible system Python ≥3.11 is present, falls back
to `UV_PYTHON_PREFERENCE=only-system`. If everything fails, it shows exact
remediation steps, not a raw `uv` exit code.

**Why this priority**: A dead first-run is the worst possible outcome — the user
never gets to use the app. This is the core of the cluster.

**Acceptance Scenarios** (from #130 test matrix):
1. **Given** GitHub blocked + a mirror reachable + no system Python, **When**
   bootstrap runs, **Then** the managed Python installs via the mirror.
2. **Given** GitHub + mirrors blocked + system Python ≥3.11 present, **When**
   bootstrap runs, **Then** it falls back to the system Python and succeeds.
3. **Given** GitHub + mirrors blocked + no system Python, **When** bootstrap
   fails, **Then** the UI shows actionable remediation (install python.org
   Python ≥3.11; set the documented env vars) — not a raw stack trace.

### Edge Cases
- A mirror resolves but serves a corrupt/partial archive → uv's retry +
  next-mirror cascade covers it; total failure → remediation path.
- System Python present but <3.11 → not used; remediation names the version.

## Requirements *(mandatory)*

- **FR-001**: The bootstrap MUST set, on the `uv venv`/`uv sync` commands:
  `UV_PYTHON_INSTALL_MIRROR` (gh-proxy cascade), `UV_HTTP_TIMEOUT=120`,
  `UV_HTTP_CONNECT_TIMEOUT=30`, `UV_HTTP_RETRIES=5`.
- **FR-002**: When the managed-Python install fails AND a system Python ≥3.11 is
  detected, the bootstrap MUST retry with `UV_PYTHON_PREFERENCE=only-system`.
- **FR-003**: On total failure, the user-facing error MUST contain actionable
  remediation (install python.org Python ≥3.11; documented env vars), feeding
  the existing BootstrapSplash hint system.
- **FR-004**: The PyPI index mirror MUST be configurable per region (extend the
  existing China `UV_INDEX_URL` to a documented cascade); VPN documented for
  fully-blocked networks.
- **FR-005**: Behaviour on an unrestricted network MUST be unchanged (mirrors are
  fallbacks; the default GitHub path still works).

## Success Criteria *(mandatory)*

- **SC-001**: On a GitHub-blocked-but-mirror-reachable network, first-run install
  succeeds (manual/integration verification on a restricted network).
- **SC-002**: With mirrors blocked + system Python ≥3.11, install succeeds via
  the only-system fallback.
- **SC-003**: With everything blocked, the UI shows remediation steps, never a
  raw uv exit code.
- **SC-004**: No regression on an unrestricted network.

## Assumptions

- Bootstrap is Rust (`frontend/src-tauri/src/bootstrap.rs` spawns `uv`); the
  env-var cascade + system-Python detection are added there, plus actionable
  error strings consumed by `BootstrapSplash.jsx`.
- Windows venv dependency completeness (#129/plan-02) and HF cache (#128/plan-01)
  are out of scope (already shipped).

## Verification reality (important)

The failure paths depend on real network conditions and a Tauri build, which
**cannot be exercised in the dev test harness**. Unit-testable pieces (the
env-var builder, system-Python version parsing) get Rust `#[cfg(test)]` tests;
the end-to-end restricted-network behaviour needs **manual verification on a
GitHub-blocked network** (or a CI job that simulates it). This is called out so
the PR isn't merged on a false sense of automated coverage.
