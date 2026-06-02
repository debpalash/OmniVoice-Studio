"""L3 desktop judges — deterministic checks on the Tauri configuration.

Per the architecture decision, desktop E2E is substituted by backend-over-HTTP +
browser testing (Tauri has no official macOS WebDriver). What remains genuinely
desktop-specific — and what these judges guard — is the *packaging/shell
contract*: things a browser test can't see but that break the shipped app:

  - version parity between tauri.conf.json and pyproject (release integrity)
  - dev/build wiring (devUrl, frontendDist, before* commands)
  - the bundled binaries first-run depends on (uv / ffmpeg / ffprobe)
  - the CSP actually permitting the local backend origin (a desktop-only failure
    mode — get it wrong and the packaged app can't reach :3900, while the browser
    build works fine)

All operate on a parsed config dict from the run context, so they run for real
on every platform with no Tauri toolchain.
"""

from __future__ import annotations

from typing import Any

from ..spec import JudgeResult

_MISSING = object()


def _dig(config: Any, path: str) -> Any:
    """Resolve a dotted key path (``build.devUrl``) into a nested dict."""
    cur = config
    for key in path.split("."):
        if not isinstance(cur, dict) or key not in cur:
            return _MISSING
        cur = cur[key]
    return cur


def config_present(config: dict, path: str) -> JudgeResult:
    val = _dig(config, path)
    ok = val is not _MISSING and val not in (None, "", [], {})
    return JudgeResult(
        name="config_present",
        passed=ok,
        measured=path,
        detail=f"{path} present" if ok else f"{path} missing/empty",
    )


def config_eq(config: dict, path: str, value: Any) -> JudgeResult:
    got = _dig(config, path)
    shown = None if got is _MISSING else got
    ok = got == value
    return JudgeResult(
        name="config_eq",
        passed=ok,
        measured=shown,
        detail=f"{path}={shown!r} (expected {value!r})",
    )


def config_contains(config: dict, path: str, items: list) -> JudgeResult:
    got = _dig(config, path)
    if not isinstance(got, (list, tuple)):
        return JudgeResult(name="config_contains", passed=False, measured=None,
                           detail=f"{path} is not a list ({got!r})")
    missing = [i for i in items if i not in got]
    return JudgeResult(
        name="config_contains",
        passed=not missing,
        measured=list(got),
        detail=f"{path} contains {items}" if not missing else f"{path} missing {missing}",
    )


def csp_allows(config: dict, origins: list, csp_path: str = "app.security.csp") -> JudgeResult:
    """The packaged app's CSP must permit the local backend origins, or invoke()/
    fetch to :3900 is blocked in the bundle (but not in a plain browser)."""
    csp = _dig(config, csp_path)
    if not isinstance(csp, str):
        return JudgeResult(name="csp_allows", passed=False, detail=f"no CSP at {csp_path}")
    missing = [o for o in origins if o not in csp]
    return JudgeResult(
        name="csp_allows",
        passed=not missing,
        measured=None if not missing else missing,
        detail="CSP permits local backend origins" if not missing else f"CSP missing {missing}",
    )
