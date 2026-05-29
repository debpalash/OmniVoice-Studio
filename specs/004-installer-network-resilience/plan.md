# Implementation Plan: Installer Bootstrap Network Resilience (plan-03)

**Branch**: `004-installer-network-resilience` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

## Summary

Make first-run survive a GitHub-blocked network. The bootstrap is **Rust**
(`frontend/src-tauri/src/bootstrap.rs` spawns `uv venv`/`uv sync`; `tools.rs`
installs uv). Add an env-var cascade (mirror + timeouts/retries) on those
commands, a system-Python ≥3.11 `only-system` fallback, and actionable error
strings for the BootstrapSplash UI.

## Change sites (Rust)

1. `bootstrap.rs` ~L427 (`uv venv`) and ~L439 (`uv sync`) — apply a shared
   `apply_uv_network_env(cmd, region)` helper: `UV_PYTHON_INSTALL_MIRROR`
   (gh-proxy cascade), `UV_HTTP_TIMEOUT=120`, `UV_HTTP_CONNECT_TIMEOUT=30`,
   `UV_HTTP_RETRIES=5`; keep/extend the region `UV_INDEX_URL`.
2. `bootstrap.rs` — on `uv venv` failure, detect a system Python ≥3.11
   (`detect_system_python()`); if present, retry the venv with
   `UV_PYTHON_PREFERENCE=only-system`.
3. `bootstrap.rs` `fail()` sites (L432/L458) — emit an actionable message
   (install python.org Python ≥3.11; documented env vars) that
   `BootstrapSplash.detectHints()` already surfaces.
4. `tools.rs` uv installer curl — add `--connect-timeout`/`--retry`.
5. `docs/install/*.md` — document the env vars + China index + VPN note (keeps
   the docs-drift validator honest).

## Testable slice (Rust `#[cfg(test)]`)

- `apply_uv_network_env` sets the expected vars (assert on a built Command's env).
- `detect_system_python` version parsing: "Python 3.11.x" → eligible;
  "Python 3.10.x"/garbage → not.
- Remediation-message builder contains the key steps.

## Verification gap (must flag on the PR)

The restricted-network end-to-end paths (mirror install, only-system fallback)
need a real Tauri build on a GitHub-blocked network — **not reproducible in the
dev harness**. `cargo check`/`cargo test` (the Tauri shell-check CI job) cover
compile + the unit slice only. CodeRabbit/Greptile + CodeQL give weaker coverage
on Rust than Python. So this PR carries a "manual verification required" note.

## Out of scope
Windows venv completeness (#129, shipped). HF cache (#128, shipped).
