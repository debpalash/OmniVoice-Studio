# [plan-03] Installer Bootstrap Network Resilience — mirror cascade + system-Python fallback

## Defect
First-run bootstrap downloads a managed Python (python-build-standalone) directly from GitHub releases with no mirror fallback and short retry budget. On networks that block or can't resolve GitHub, `uv venv` dies with a DNS/tunnel error and the install is dead-on-arrival. (This is Capability 3 in the stack notes.)

## Children
- #60 — `uv venv failed`: `Failed to download .../python-build-standalone/...`, `dns error / Этот хост неизвестен` (host unknown). Workaround posted in PR #62.
- #57 — "Installation failed" (screenshot only) — tentatively a bootstrap failure; confirm against the image, else needs-info.
- #127 — Linux AppImage backend "exited (never started)", "Clean & Retry" loops, tried different mirrors with same result (Arch Linux, v0.2.7); adds a Linux AppImage test cell.

## Fix sequence
1. Set `UV_PYTHON_INSTALL_MIRROR` to a gh-proxy mirror cascade at bootstrap time.
2. Bump `UV_HTTP_TIMEOUT=120`, `UV_HTTP_CONNECT_TIMEOUT=30`, `UV_HTTP_RETRIES=5`.
3. Final fallback: `UV_PYTHON_PREFERENCE=only-system` when all mirrors fail and a compatible system Python ≥3.11 is present.
4. For PyPI access, document/optionally set `UV_DEFAULT_INDEX` (Tsinghua/Aliyun) for China; document VPN honestly for fully-blocked networks.
5. On total failure, the bootstrap surfaces the exact remediation (install python.org Python + the env vars) instead of a raw uv stack trace.

## Test matrix
| Network | System Python | Required behavior |
|---|---|---|
| GitHub blocked, mirror reachable | absent | installs via mirror |
| GitHub + mirrors blocked | py3.11 present | falls back to system Python |
| GitHub + mirrors blocked | absent | actionable error with remediation steps |

## Out of scope
Windows venv dependency completeness (→ plan-02).
