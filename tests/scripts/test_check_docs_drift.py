"""Self-test for scripts/check-docs-drift.py (parity program Wave 0.1).

Mirrors the import pattern of tests/scripts/test_validate_install_docs.py:
the hyphenated script is loaded via importlib against a tmp-path repo fixture,
so no test depends on real repo state.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "check-docs-drift.py"


@pytest.fixture(scope="module")
def drift_module():
    spec = importlib.util.spec_from_file_location("check_docs_drift", SCRIPT_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["check_docs_drift"] = mod
    spec.loader.exec_module(mod)
    return mod


_TTS_SOURCE = '''
_LAZY_REGISTRY: dict[str, tuple[str, str]] = {
    "indextts2": ("engines.indextts", "IndexTTS2Backend"),
}

_REGISTRY: dict[str, type[TTSBackend]] = _LazyRegistry({
    "omnivoice":     OmniVoiceBackend,
    # "indextts2": resolved lazily
    "cosyvoice":     CosyVoiceBackend,
})
'''

_ASR_SOURCE = '''
_REGISTRY: dict[str, type[ASRBackend]] = {
    "whisperx": WhisperXBackend,
}
'''

_INVENTORY = """
features:
  - Voice Cloning
tts_engines:
  - id: omnivoice
    readme: OmniVoice (default)
  - id: cosyvoice
    doc: docs/engines/cosyvoice.md
  - id: indextts2
asr_engines:
  - id: whisperx
    readme: WhisperX (default)
docs:
  - docs/install/macos.md
"""

_README = """# App
## Features
Voice Cloning
## Engines
| OmniVoice (default) | ... |
| WhisperX (default) | ... |
"""


def _make_root(tmp_path: Path, *, inventory: str = _INVENTORY, readme: str = _README,
               tts: str = _TTS_SOURCE, asr: str = _ASR_SOURCE) -> Path:
    root = tmp_path / "repo"
    (root / "docs" / "engines").mkdir(parents=True)
    (root / "docs" / "install").mkdir(parents=True)
    (root / "backend" / "services").mkdir(parents=True)
    (root / "docs" / "features.yaml").write_text(inventory, encoding="utf-8")
    (root / "README.md").write_text(readme, encoding="utf-8")
    (root / "backend" / "services" / "tts_backend.py").write_text(tts, encoding="utf-8")
    (root / "backend" / "services" / "asr_backend.py").write_text(asr, encoding="utf-8")
    (root / "docs" / "engines" / "cosyvoice.md").write_text("# CosyVoice\n", encoding="utf-8")
    (root / "docs" / "install" / "macos.md").write_text("# macOS\n", encoding="utf-8")
    return root


def test_clean_state_passes(drift_module, tmp_path, capsys):
    root = _make_root(tmp_path)
    assert drift_module.main([], root=root) == 0
    assert "OK" in capsys.readouterr().out


def test_feature_missing_from_readme_fails(drift_module, tmp_path, capsys):
    root = _make_root(tmp_path, readme=_README.replace("Voice Cloning", "Something Else"))
    assert drift_module.main([], root=root) == 1
    assert "Voice Cloning" in capsys.readouterr().err


def test_engine_in_code_but_not_inventory_fails(drift_module, tmp_path, capsys):
    tts = _TTS_SOURCE.replace(
        '"cosyvoice":     CosyVoiceBackend,',
        '"cosyvoice":     CosyVoiceBackend,\n    "newengine":  NewBackend,',
    )
    root = _make_root(tmp_path, tts=tts)
    assert drift_module.main([], root=root) == 1
    assert "newengine" in capsys.readouterr().err


def test_engine_in_inventory_but_not_code_fails(drift_module, tmp_path, capsys):
    asr = _ASR_SOURCE.replace('"whisperx": WhisperXBackend,', "")
    root = _make_root(tmp_path, asr=asr)
    assert drift_module.main([], root=root) == 1
    assert "whisperx" in capsys.readouterr().err


def test_commented_registry_lines_ignored(drift_module, tmp_path):
    # `# "indextts2": resolved lazily` inside _REGISTRY must not count as a key
    # (it is also a real lazy key here, so a parser that read comments would
    # not fail — drop the lazy entry to make the assertion meaningful).
    tts = _TTS_SOURCE.replace('    "indextts2": ("engines.indextts", "IndexTTS2Backend"),\n', "")
    inventory = _INVENTORY.replace("  - id: indextts2\n", "")
    root = _make_root(tmp_path, tts=tts, inventory=inventory)
    assert drift_module.main([], root=root) == 0


def test_missing_engine_doc_fails(drift_module, tmp_path, capsys):
    root = _make_root(tmp_path)
    (root / "docs" / "engines" / "cosyvoice.md").unlink()
    assert drift_module.main([], root=root) == 1
    assert "cosyvoice" in capsys.readouterr().err


def test_missing_required_doc_fails(drift_module, tmp_path, capsys):
    root = _make_root(tmp_path)
    (root / "docs" / "install" / "macos.md").unlink()
    assert drift_module.main([], root=root) == 1
    assert "docs/install/macos.md" in capsys.readouterr().err


def test_readme_string_missing_fails(drift_module, tmp_path, capsys):
    root = _make_root(tmp_path, readme=_README.replace("WhisperX (default)", "WhisperX"))
    assert drift_module.main([], root=root) == 1
    assert "WhisperX (default)" in capsys.readouterr().err


def test_report_written_on_drift(drift_module, tmp_path):
    root = _make_root(tmp_path)
    (root / "docs" / "install" / "macos.md").unlink()
    out = tmp_path / "drift-report.md"
    assert drift_module.main(["--output", str(out)], root=root) == 1
    text = out.read_text(encoding="utf-8")
    assert "Docs drift report" in text and "docs/install/macos.md" in text


def test_report_written_on_clean(drift_module, tmp_path):
    root = _make_root(tmp_path)
    out = tmp_path / "drift-report.md"
    assert drift_module.main(["--output", str(out)], root=root) == 0
    assert "No drift" in out.read_text(encoding="utf-8")


def test_changed_registry_layout_is_loud(drift_module, tmp_path):
    root = _make_root(tmp_path, tts="_SOMETHING_ELSE = {}\n")
    with pytest.raises(SystemExit, match="marker not found"):
        drift_module.main([], root=root)


def test_real_repo_is_clean(drift_module):
    """The shipped inventory must match the shipped README/registries."""
    repo = Path(__file__).resolve().parents[2]
    assert drift_module.main([], root=repo) == 0
