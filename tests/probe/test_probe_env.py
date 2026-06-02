"""L5 env/first-run — boots the real backend against an EMPTY data dir and runs
the first_run spec end-to-end (offline, model short-circuited). This exercises
the actual lifespan/DB-init path a brand-new user hits.
"""

from __future__ import annotations

import os
import sys

import pytest

from . import env
from . import spec as probe_spec

_SPEC = os.path.join(os.path.dirname(__file__), "specs", "first_run.probe.yaml")


def test_first_run_boot(probe_report):
    spec = probe_spec.load_spec(_SPEC)
    with env.fresh_data_dir() as data_dir:
        context = env.capture_first_run(data_dir)
        # Check the first-run DB while the temp data dir still exists
        # (fresh_data_dir removes it on context exit).
        db_created = bool(context["db_path"]) and os.path.exists(context["db_path"])
        results = probe_spec.run_judges(spec, context)
        probe_report.record(spec, results)
    failures = probe_spec.blocking_failures(results)
    assert failures == [], "\n".join(str(r) for r in results)
    # The boot actually created the DB on first run (not just answered health).
    assert db_created, f"no SQLite DB created under data dir; db_path={context['db_path']!r}"


def test_boot_does_not_pollute_parent():
    """The subprocess boot must leave the parent session's env and module table
    untouched — the property that makes L5 safe to run alongside the suite."""
    before_env = os.environ.get("OMNIVOICE_DATA_DIR")
    before_main = "main" in sys.modules
    with env.fresh_data_dir() as d:
        env.capture_first_run(d)
    assert os.environ.get("OMNIVOICE_DATA_DIR") == before_env
    assert ("main" in sys.modules) == before_main


def test_docker_path_skips_without_daemon():
    if not env.docker_available():
        pytest.skip("no Docker daemon — L5 container boot is enable-on-demand")
    # When a daemon IS present, the compose file the Actor targets must exist.
    assert env.compose_file().exists(), f"missing {env.compose_file()}"
