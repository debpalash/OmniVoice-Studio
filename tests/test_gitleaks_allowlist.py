"""The secret-scan allowlist must remain exact and value-scoped."""
from pathlib import Path
import re
import tomllib


ROOT = Path(__file__).resolve().parents[1]
_POSTHOG_TOKEN = re.search(
    r"phc_[A-Za-z0-9]{20,}",
    (ROOT / "backend/core/analytics.py").read_text(encoding="utf-8"),
)
assert _POSTHOG_TOKEN is not None
EXPECTED_EXACT_REGEXES = {
    f"^{_POSTHOG_TOKEN.group(0)}$",
    "^528e871c2a26c4f0f7773b9754e2e1acae20899d$",
    "^hf_abcdefghijklmnopqrstuvwxyz01234567890abcd$",
    "^hf_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF$",
    "^hf_QWERTYUIOPasdfghjklZXCVBNM0123456789xyzAB$",
    "^max_length=400$",
    "^Ed25519PrivateKey$",
}


def test_gitleaks_allowlist_contains_only_reviewed_exact_values():
    config = tomllib.loads((ROOT / ".gitleaks.toml").read_text(encoding="utf-8"))
    allowlist = config["allowlist"]

    assert set(allowlist) == {"description", "regexes"}
    assert set(allowlist["regexes"]) == EXPECTED_EXACT_REGEXES
    assert all(
        regex.startswith("^") and regex.endswith("$")
        for regex in allowlist["regexes"]
    )
    assert "rules" not in config
