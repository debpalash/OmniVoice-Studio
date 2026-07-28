"""The macOS preview updater cleanup step must fail loud, not fail blind.

#1281 added a step that deletes this arch's stale `*.app.tar.gz` from the
rolling `preview` release before Tauri uploads the new one. The first cut
treated *every* `gh` failure as "nothing to clear" — including 401/403/429 and
network errors. That reintroduces the original outage with the evidence
removed: the stale asset survives, the upload dies with `already_exists`, and
the one step that could have explained why is green.

Only an ABSENT release/asset is benign. These tests run the step's real shell
body (extracted from release.yml, so it cannot drift) against a stubbed `gh`.
"""

import os
import shutil
import stat
import subprocess
import sys

import pytest
import yaml

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="step is macOS-only and the script uses POSIX /tmp paths",
)

_WORKFLOW = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".github", "workflows", "release.yml",
)
_STEP = "Clear this arch's stale preview updater bundle (macOS)"

# One aarch64 bundle + its detached signature, plus assets that must survive:
# the x64 leg's bundle (the sibling job owns it) and the DMGs.
_ASSETS = """\
OmniVoice.Studio_aarch64.app.tar.gz
OmniVoice.Studio_aarch64.app.tar.gz.sig
OmniVoice.Studio_x64.app.tar.gz
OmniVoice_0.4.2_aarch64.dmg
latest.json
"""


def _step_script():
    with open(_WORKFLOW, encoding="utf-8") as fh:
        wf = yaml.safe_load(fh)
    for job in wf["jobs"].values():
        for step in job.get("steps", []):
            if step.get("name") == _STEP:
                # The runner substitutes matrix values before bash sees them.
                return step["run"].replace("${{ matrix.arch }}", "aarch64-apple-darwin")
    raise AssertionError(f"step {_STEP!r} not found in release.yml")


def _run(tmp_path, view_rc, view_err, delete_rc=0, delete_err="", assets=_ASSETS):
    """Run the step with a `gh` stub on PATH; return (CompletedProcess, deleted)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    deleted = tmp_path / "deleted.txt"
    # Via a file, not an inlined literal: bash single-quotes take \n literally,
    # so an embedded repr() would hand the step one long unsplittable line.
    assets_file = tmp_path / "assets.txt"
    assets_file.write_text(assets)
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$2" = "view" ]; then\n'
        f"  cat {str(assets_file)!r}\n"
        f'  printf %s {view_err!r} >&2\n'
        f"  exit {view_rc}\n"
        "fi\n"
        'if [ "$2" = "delete-asset" ]; then\n'
        f'  echo "$4" >> {str(deleted)!r}\n'
        f'  printf %s {delete_err!r} >&2\n'
        f"  exit {delete_rc}\n"
        "fi\n"
        "exit 0\n"
    )
    gh.chmod(gh.stat().st_mode | stat.S_IEXEC)

    script = tmp_path / "step.sh"
    script.write_text(_step_script())

    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", GH_TOKEN="x")
    proc = subprocess.run(
        [shutil.which("bash") or "/bin/bash", str(script)],
        capture_output=True, text=True, env=env, timeout=60,
    )
    names = deleted.read_text().split() if deleted.exists() else []
    return proc, names


def test_missing_preview_release_is_benign(tmp_path):
    """First preview build: there is no release yet, so there is nothing to
    collide with. This is the one failure that must NOT fail the job."""
    proc, deleted = _run(tmp_path, view_rc=1, view_err="release not found", assets="")
    assert proc.returncode == 0, proc.stderr
    assert "nothing to clear" in proc.stdout
    assert deleted == []


@pytest.mark.parametrize(
    "stderr",
    [
        "HTTP 401: Bad credentials",
        "HTTP 403: Resource not accessible by integration",
        "HTTP 429: API rate limit exceeded",
        "dial tcp: lookup api.github.com: no such host",
    ],
)
def test_unreadable_release_fails_the_job(tmp_path, stderr):
    """The regression: swallowing these leaves the stale asset in place and the
    upload dies later with `already_exists`, with no red step to explain it."""
    proc, deleted = _run(tmp_path, view_rc=1, view_err=stderr, assets="")
    assert proc.returncode != 0, (
        f"a {stderr!r} failure was swallowed — the step cannot know whether a "
        f"stale bundle survived, so it must not report success"
    )
    assert deleted == []


def test_deletes_only_this_arch(tmp_path):
    """The parallel x64 leg owns its own bundle; DMGs and latest.json are not
    ours to touch."""
    proc, deleted = _run(tmp_path, view_rc=0, view_err="")
    assert proc.returncode == 0, proc.stderr
    assert deleted == [
        "OmniVoice.Studio_aarch64.app.tar.gz",
        "OmniVoice.Studio_aarch64.app.tar.gz.sig",
    ]


def test_already_deleted_asset_is_benign(tmp_path):
    """A re-run (or the sibling leg racing us) already removed it — the goal is
    "no asset under this name", which is satisfied."""
    proc, _ = _run(tmp_path, view_rc=0, view_err="", delete_rc=1,
                   delete_err="HTTP 404: Not Found")
    assert proc.returncode == 0, proc.stderr
    assert "already gone" in proc.stdout


def test_delete_denied_fails_the_job(tmp_path):
    """A permission failure means the stale asset is still there — exactly the
    collision the step exists to prevent."""
    proc, _ = _run(tmp_path, view_rc=0, view_err="", delete_rc=1,
                   delete_err="HTTP 403: Resource not accessible by integration")
    assert proc.returncode != 0, (
        "a failed delete left the stale bundle in place; the upload will fail "
        "with already_exists, so this step must fail first and say why"
    )
