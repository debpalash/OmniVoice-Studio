"""Tests for scripts/validate-install-docs.py — checker B-5.

The validator is a CI gate that prevents docs/install/*.md from drifting out
of sync with scripts/desktop-prod.sh. The validator itself must not drift —
these tests pin the behaviours that matter:

  - Clean state passes (exit 0, no errors printed).
  - A drift line in a `<!-- validate -->` block fails (exit 1, line + file
    surfaced on stderr).
  - `<!-- validate: skip -->` opts a block out of the comparison, even when
    the block diverges from the canonical script.
  - `$ ` and `>>> ` prompt prefixes are stripped before comparison.
  - CRLF line endings normalise to LF.
  - Trailing whitespace doesn't cause spurious failures.
  - Pure-comment and blank lines are skipped.

Each test builds a tmp_path-rooted fixture with the minimum file layout
the validator needs (`docs/install/foo.md` + `scripts/desktop-prod.sh`) so
the tests don't depend on the real repo state.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "validate-install-docs.py"


@pytest.fixture
def validator_module():
    """Import scripts/validate-install-docs.py as a module so we can call
    `main(root=...)` directly without spawning a subprocess."""
    spec = importlib.util.spec_from_file_location("validate_install_docs", SCRIPT_PATH)
    assert spec and spec.loader, "spec_from_file_location returned None"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["validate_install_docs"] = mod
    spec.loader.exec_module(mod)
    return mod


def _make_root(tmp_path: Path, *, docs: dict[str, str], script: str) -> Path:
    """Lay out the minimum repo skeleton the validator scans."""
    (tmp_path / "docs" / "install").mkdir(parents=True)
    for name, body in docs.items():
        (tmp_path / "docs" / "install" / name).write_text(body, encoding="utf-8")
    (tmp_path / "scripts").mkdir(parents=True)
    (tmp_path / "scripts" / "desktop-prod.sh").write_text(script, encoding="utf-8")
    return tmp_path


def test_clean_state_passes(validator_module, tmp_path, capsys):
    root = _make_root(
        tmp_path,
        docs={
            "macos.md": (
                "# macOS\n\n"
                "<!-- validate -->\n"
                "```bash\n"
                'APP_NAME="OmniVoice Studio"\n'
                "```\n"
            ),
        },
        script='APP_NAME="OmniVoice Studio"\n',
    )
    code = validator_module.main(root=root)
    out = capsys.readouterr()
    assert code == 0, out.err
    assert "OK" in out.out


def test_drift_introduced_fails(validator_module, tmp_path, capsys):
    root = _make_root(
        tmp_path,
        docs={
            "macos.md": (
                "# macOS\n\n"
                "<!-- validate -->\n"
                "```bash\n"
                "this-line-does-not-exist-in-the-script\n"
                "```\n"
            ),
        },
        script='APP_NAME="OmniVoice Studio"\n',
    )
    code = validator_module.main(root=root)
    out = capsys.readouterr()
    assert code == 1
    assert "macos.md" in out.err
    assert "this-line-does-not-exist-in-the-script" in out.err


def test_skip_marker_allows_divergence(validator_module, tmp_path, capsys):
    root = _make_root(
        tmp_path,
        docs={
            "macos.md": (
                "# macOS\n\n"
                "<!-- validate: skip -->\n"
                "```bash\n"
                "this-block-can-diverge-from-script\n"
                "```\n"
            ),
        },
        script='APP_NAME="OmniVoice Studio"\n',
    )
    code = validator_module.main(root=root)
    out = capsys.readouterr()
    assert code == 0, out.err


def test_skip_marker_diverging_block_exit_zero(validator_module, tmp_path, capsys):
    """B-5 case (b): an explicit `validate: skip` block diverging from the
    canonical script must NOT cause a non-zero exit."""
    root = _make_root(
        tmp_path,
        docs={
            "win.md": (
                "<!-- validate: skip -->\n"
                "```bash\n"
                "setx HF_TOKEN hf_xxx\n"
                "```\n"
            ),
        },
        script="something-else-entirely\n",
    )
    assert validator_module.main(root=root) == 0


def test_prompt_prefix_stripped(validator_module, tmp_path, capsys):
    root = _make_root(
        tmp_path,
        docs={
            "macos.md": (
                "<!-- validate -->\n"
                "```bash\n"
                "$ bun install\n"
                "```\n"
            ),
        },
        script="bun install\n",
    )
    code = validator_module.main(root=root)
    assert code == 0, capsys.readouterr().err


def test_python_prompt_prefix_stripped(validator_module, tmp_path, capsys):
    root = _make_root(
        tmp_path,
        docs={
            "x.md": (
                "<!-- validate -->\n"
                "```python\n"
                ">>> bun install\n"
                "```\n"
            ),
        },
        script="bun install\n",
    )
    code = validator_module.main(root=root)
    assert code == 0, capsys.readouterr().err


def test_crlf_normalization(validator_module, tmp_path, capsys):
    """A docs file with CRLF line endings produces the same result as the LF
    version (exit 0 when the canonical content matches)."""
    crlf_doc = (
        "# macOS\r\n"
        "<!-- validate -->\r\n"
        "```bash\r\n"
        "bun install\r\n"
        "```\r\n"
    )
    root = _make_root(
        tmp_path,
        docs={"macos.md": crlf_doc},
        script="bun install\n",
    )
    code = validator_module.main(root=root)
    assert code == 0, capsys.readouterr().err


def test_trailing_whitespace_tolerated(validator_module, tmp_path, capsys):
    root = _make_root(
        tmp_path,
        docs={
            "macos.md": (
                "<!-- validate -->\n"
                "```bash\n"
                "bun install    \n"  # trailing spaces in docs
                "```\n"
            ),
        },
        script="bun install\n",  # canonical has no trailing spaces
    )
    code = validator_module.main(root=root)
    assert code == 0, capsys.readouterr().err


def test_blank_and_comment_only_lines_skipped(validator_module, tmp_path, capsys):
    root = _make_root(
        tmp_path,
        docs={
            "macos.md": (
                "<!-- validate -->\n"
                "```bash\n"
                "\n"
                "# A comment that explains the next step\n"
                "bun install\n"
                "# Another comment\n"
                "\n"
                "```\n"
            ),
        },
        script="bun install\n",
    )
    code = validator_module.main(root=root)
    assert code == 0, capsys.readouterr().err


def test_true_diff_distinguished_from_whitespace(validator_module, tmp_path, capsys):
    """B-5 case (e): a real semantic diff (different command) must fail; a
    whitespace-only diff (trailing spaces) must pass."""
    # Whitespace-only diff — passes:
    root_ws = _make_root(
        tmp_path / "ws",
        docs={"x.md": "<!-- validate -->\n```bash\nbun install   \n```\n"},
        script="bun install\n",
    )
    assert validator_module.main(root=root_ws) == 0

    # Real semantic diff — fails:
    root_real = _make_root(
        tmp_path / "real",
        docs={"x.md": "<!-- validate -->\n```bash\nbun install --force\n```\n"},
        script="bun install\n",
    )
    code = validator_module.main(root=root_real)
    err = capsys.readouterr().err
    assert code == 1
    assert "bun install --force" in err
