"""Run the AppImage AppRun launcher's shell unit tests under pytest.

AppRun.test.sh existed but was wired into NO CI job — the launcher's
workaround auto-detection (which decides whether shipped Linux builds get
WEBKIT_DISABLE_COMPOSITING_MODE) could regress silently. This wrapper rides
the standard "Tests (backend + frontend)" gate instead of needing its own
workflow step. Covers the #961 follow-up too: the build-time
.bundled-webkitgtk-version marker must beat the host's pkg-config answer.
"""
import os
import shutil
import subprocess

import pytest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPT = os.path.join(_REPO, "frontend", "src-tauri", "appimage", "AppRun.test.sh")


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
def test_apprun_shell_suite_passes():
    proc = subprocess.run(
        ["bash", _SCRIPT], capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, (
        f"AppRun.test.sh failed (exit {proc.returncode}):\n"
        f"{proc.stdout}\n{proc.stderr}"
    )
    assert "0 fail" in proc.stdout
