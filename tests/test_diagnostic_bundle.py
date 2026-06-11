"""core.diagnostic_bundle — the drag-onto-a-GitHub-issue zip."""
import json
import os
import zipfile

import pytest

from core import diagnostic_bundle
from core.diagnostic_bundle import build_bundle

EXPECTED_MEMBERS = {
    "meta.json",
    "self_check.txt",
    "self_check.json",
    "errors.json",
    "logs/omnivoice.log.txt",
    "logs/crash_log.txt",
}


@pytest.fixture()
def bundle_env(monkeypatch, tmp_path):
    """Isolated log files + output dir, with a secret planted in the log."""
    log = tmp_path / "omnivoice.log"
    log.write_text(
        "2026-01-01 INFO startup ok\n"
        "2026-01-01 ERROR failed for /home/eve/voice.wav token=hf_"
        + "Z" * 34
        + "\n",
        encoding="utf-8",
    )
    crash = tmp_path / "crash_log.txt"
    crash.write_text("--- ts ---\nTraceback from /Users/eve/app\n", encoding="utf-8")
    out = tmp_path / "outputs"
    monkeypatch.setattr(diagnostic_bundle, "LOG_PATH", str(log))
    monkeypatch.setattr(diagnostic_bundle, "CRASH_LOG_PATH", str(crash))
    monkeypatch.setattr(diagnostic_bundle, "OUTPUTS_DIR", str(out))
    return tmp_path


def test_bundle_members_and_meta(bundle_env):
    path = build_bundle(include_network=False)
    assert os.path.exists(path)
    with zipfile.ZipFile(path) as zf:
        assert set(zf.namelist()) == EXPECTED_MEMBERS
        meta = json.loads(zf.read("meta.json"))
        assert meta["app_version"]
        report = json.loads(zf.read("self_check.json"))
        assert report["summary"]["passed"] >= 1


def test_bundle_log_tails_are_scrubbed(bundle_env):
    path = build_bundle(include_network=False)
    with zipfile.ZipFile(path) as zf:
        log_tail = zf.read("logs/omnivoice.log.txt").decode()
        crash_tail = zf.read("logs/crash_log.txt").decode()
    assert "/home/eve" not in log_tail
    assert "hf_" + "Z" * 34 not in log_tail
    assert "***REDACTED***" in log_tail
    assert "/Users/eve" not in crash_tail


def test_bundle_survives_missing_logs(bundle_env, monkeypatch, tmp_path):
    monkeypatch.setattr(diagnostic_bundle, "LOG_PATH", str(tmp_path / "missing.log"))
    monkeypatch.setattr(diagnostic_bundle, "CRASH_LOG_PATH", str(tmp_path / "missing_crash.txt"))
    path = build_bundle(include_network=False)
    with zipfile.ZipFile(path) as zf:
        assert "(no file at" in zf.read("logs/omnivoice.log.txt").decode()
