# Tasks: Installer Bootstrap Network Resilience (plan-03)

**Branch**: `004-installer-network-resilience` | Closes #60. Addresses #130/#57/#127.
**Note:** ~90% Rust; network-failure E2E needs manual verification on a restricted network.

## Phase 1: Bootstrap resilience (Rust)
- [x] T001 `bootstrap.rs` helpers: `apply_uv_http_env` (timeout/connect/retries),
  `parse_py_version`, `system_python_ge_311`, `PY_INSTALL_MIRROR`,
  `BOOTSTRAP_REMEDIATION`.
- [x] T002 `uv venv` cascade: default → gh-proxy mirror → system-Python
  (only-system, if ≥3.11), each with the http env. Actionable failure message.
- [x] T003 `uv sync`: apply http env; actionable failure message (mirror hint).
- [x] T004 Rust `#[cfg(test)]`: parse_py_version (real + garbage), apply_uv_http_env
  sets the three vars. `cargo test` → 2 passed; crate compiles.

## Phase 2: User-facing remediation + docs
- [x] T005 `BootstrapSplash.detectHints`: GitHub-blocked / can't-download-Python
  hint pointing at python.org + UV_PYTHON_INSTALL_MIRROR + docs.
- [x] T006 `docs/install/troubleshooting.md`: restricted-network section
  (mirror env vars, China index, VPN note) — referenced by the remediation text.

## Phase 3: Verify
- [x] T007 `cargo test` green; `bun run build` clean; docs-drift validator passes.
- [ ] T008 **Manual**: verify mirror install + only-system fallback on a real
  GitHub-blocked network (cannot be reproduced in the dev/CI harness).

## Out of scope
- uv installer curl timeout in tools.rs (smaller follow-up).
- Per-region mirror cascade beyond gh-proxy + China index (follow-up).
