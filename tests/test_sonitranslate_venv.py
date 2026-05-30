"""SoniTranslate venv binary paths must be cross-platform (#186)."""
from services import sonitranslate as s


def test_venv_bin_windows(monkeypatch):
    monkeypatch.setattr(s.sys, "platform", "win32")
    p = s._venv_bin("pip")
    assert p.name == "pip.exe"
    assert p.parent.name == "Scripts"


def test_venv_bin_posix(monkeypatch):
    monkeypatch.setattr(s.sys, "platform", "linux")
    p = s._venv_bin("python")
    assert p.name == "python"
    assert p.parent.name == "bin"
