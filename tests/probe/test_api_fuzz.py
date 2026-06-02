"""L1 — Schemathesis property fuzzing of the FastAPI app (enable-on-demand).

Skips cleanly until ``uv add schemathesis``. Once installed, this autonomously
hammers every operation in the app's OpenAPI schema for 500s / schema
violations / validation bypasses, in-process over ASGI (no live server).
"""

from __future__ import annotations

import pytest

schemathesis = pytest.importorskip(
    "schemathesis",
    reason="L1 API fuzzing is enable-on-demand: run `uv add schemathesis`.",
)

from .api_fuzz import build_schema  # noqa: E402

schema = build_schema()


@schema.parametrize()
@pytest.mark.api_fuzz
def test_api_contract(case):
    # GET-only by default keeps the first pass safe (no state mutation / no model
    # inference). Broaden by removing this guard once destructive ops are mocked.
    if case.method.upper() != "GET":
        pytest.skip("first-pass fuzz is GET-only; mock side-effecting ops to widen")
    case.call_and_validate()
