"""The product was renamed; the paths on users' disks were deliberately not.

The product is now **VoiceStudio** (previously OmniVoice-Studio). The rebrand
covers what a user *sees* — app name, installer, window title, docs, UI copy —
and stops precisely there, because four separate identity namespaces exist here
and only one of them is cosmetic:

  * bundle identifier `com.debpalash.omnivoice-studio` — keys config.json, the
    multi-GB managed Python venv, the WebView profile (localStorage), the
    single-instance lock, and macOS TCC grants for microphone + Accessibility;
  * the backend data dir (`OmniVoice` / `.omnivoice`) and `omnivoice.db` — every
    voice, project, generation, glossary entry and setting a user owns;
  * the `omnivoice` Python package — vendored upstream `k2-fsa/OmniVoice`, a
    name we do not own.

There is **no legacy-path fallback anywhere in this codebase**: nothing reads an
old location when the new one is missing. So renaming any of the above does not
fail loudly — it creates an empty tree, stamps a fresh database, and presents a
working app with the user's entire library apparently gone. CLAUDE.md makes that
a hard constraint ("Existing omnivoice_data/ … must keep working without manual
migration").

A future sweep chasing consistency would look exactly like the right change.
This file is the tripwire that stops it, and says why in the failure message.
"""

import json
import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

WHY = (
    "This is not a naming inconsistency to tidy up — it is where existing "
    "users' data lives. There is no legacy-path fallback, so changing it "
    "silently orphans their library. See the module docstring."
)


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


def test_the_bundle_identifier_is_unchanged():
    conf = json.loads(_read("frontend/src-tauri/tauri.conf.json"))
    assert conf["identifier"] == "com.debpalash.omnivoice-studio", WHY


def test_the_rust_mirror_of_the_identifier_agrees():
    # config.rs carries its own copy; a rename that moved only one of the two
    # would put the shell and its own config in different directories.
    conf = json.loads(_read("frontend/src-tauri/tauri.conf.json"))
    rust = _read("frontend/src-tauri/src/config.rs")
    match = re.search(r'BUNDLE_IDENTIFIER:\s*&str\s*=\s*"([^"]+)"', rust)
    assert match, "BUNDLE_IDENTIFIER const not found in config.rs"
    assert match.group(1) == conf["identifier"], WHY


def test_the_backend_data_directories_are_unchanged():
    src = _read("backend/core/config.py")
    for literal in (
        '"~/Library/Application Support/OmniVoice"',
        '"OmniVoice"',      # Windows: %APPDATA%\\OmniVoice
        '"~/.omnivoice"',   # Linux
    ):
        assert literal in src, f"{literal} missing from get_app_data_dir(). {WHY}"


def test_the_database_filename_is_unchanged():
    # One SQLite file holds voices, projects, history, glossary, settings and
    # the encrypted HF token. Renaming it is total, silent data loss.
    assert "omnivoice.db" in _read("backend/core/config.py"), WHY


@pytest.mark.parametrize(
    "rel",
    [
        "frontend/src-tauri/src/setup.rs",     # default_data_dir / default_models_dir
        "frontend/src-tauri/src/backend.rs",   # backend_log_path
        "frontend/src-tauri/src/commands.rs",  # log path + data dir
    ],
)
def test_no_rust_resolver_joins_the_brand_name_as_a_directory(rel):
    """The Rust side builds these paths with `.join("OmniVoice")`.

    A brand sweep renames that string as readily as any other, and the
    original assertion here — "does the file mention OmniVoice anywhere" —
    passed while three resolvers had been repointed at a directory that does
    not exist. Assert the SHAPE that matters: no resolver may join the
    product name.
    """
    rust = _read(rel)
    assert 'join("VoiceStudio")' not in rust, (
        f"{rel} resolves a user directory named after the brand. {WHY}"
    )
    assert 'join("OmniVoice")' in rust, (
        f"{rel} no longer joins the real data directory name. {WHY}"
    )


def test_the_rust_data_dir_mirror_agrees_with_python():
    # setup.rs::default_data_dir() is a hand-maintained mirror of
    # get_app_data_dir(). If they drift, the shell and the backend disagree
    # about where the user's data is.
    rust = _read("frontend/src-tauri/src/setup.rs")
    assert "Application Support/OmniVoice" in rust, WHY
    assert ".omnivoice" in rust, WHY


def test_no_windows_path_fixture_points_at_the_brand():
    """The Rust uninstall/reset tests carry Windows path fixtures that are only
    ABSOLUTE on Windows — so a rename there fails on the Windows runner alone,
    hours later. Catch it here, on any platform."""
    for rel in ("frontend/src-tauri/src/uninstall.rs", "frontend/src-tauri/src/reset.rs"):
        rust = _read(rel)
        for bad in ("Roaming\\VoiceStudio", "Roaming/VoiceStudio"):
            assert bad not in rust, f"{rel} fixture points at a brand-named dir. {WHY}"


@pytest.mark.parametrize(
    "rel,var",
    [
        ("scripts/smoke-test.sh", "OV_DATA"),
        ("scripts/desktop-prod.sh", "BACKEND_DATA"),
    ],
)
def test_no_dev_script_resolves_a_brand_named_data_dir(rel, var):
    """The shell scripts resolve the backend's data dir per platform.

    They were missed by the first pass of this guard and the rename sweep
    duly repointed the Windows and Linux branches at ``VoiceStudio`` — so
    ``smoke-test.sh`` verified a directory the backend never writes (a smoke
    test that passes while nothing was produced) and ``desktop-prod.sh``'s
    wipe silently stopped clearing backend state on Windows. Both are
    invisible on macOS, which is where they are usually run.

    Assert on the assignment specifically: these files legitimately mention
    the brand elsewhere (banners, comments), so a file-wide substring check
    is exactly the too-weak assertion that let this through before.
    """
    src = _read(rel)
    assignments = re.findall(rf"(?m)^\s*{var}=.*$", src)
    assert assignments, f"no {var} assignment found in {rel}"
    for line in assignments:
        assert "VoiceStudio" not in line, (
            f"{rel} resolves the backend data dir from the brand name: "
            f"{line.strip()}. {WHY}"
        )
    joined = "\n".join(assignments)
    for expected in ("Application Support/OmniVoice", "OmniVoice", ".omnivoice"):
        assert expected in joined, (
            f"{rel} lost the {expected!r} branch — it no longer agrees with "
            f"backend/core/config.py. {WHY}"
        )


def test_the_uninstall_allowlist_still_recognises_our_paths():
    # is_recognizably_ours() refuses to delete anything it does not recognise.
    # If the paths were renamed but this list was not, uninstall and reset stop
    # removing anything — reporting success while leaving everything behind.
    rust = _read("frontend/src-tauri/src/uninstall.rs")
    for owned in ("OmniVoice", "omnivoice", ".omnivoice", "com.debpalash.omnivoice-studio"):
        assert f'"{owned}"' in rust, f"{owned} dropped from the OWNED allowlist. {WHY}"


def test_the_python_package_name_is_unchanged():
    # `omnivoice` is vendored upstream k2-fsa/OmniVoice, not our product. The
    # whole runtime version chain reads it via importlib.metadata, and
    # backend.spec's copy_metadata() depends on the name matching.
    pyproject = _read("pyproject.toml")
    assert re.search(r'(?m)^name\s*=\s*"omnivoice"', pyproject), WHY


def test_the_model_class_name_is_unchanged():
    # `OmniVoice` (omnivoice.models.omnivoice) is a transformers PreTrainedModel
    # — a library identifier baked into checkpoint configs, not product
    # branding. The 0.4.2 rename sweep rewrote the backend's import to a
    # nonexistent `VoiceStudio` class, which killed every default-engine
    # generation with "cannot import name 'VoiceStudio'". Behavioral, not a
    # source-text grep: the backend's lazy loader must resolve to the very
    # class the library exports, however either side spells the import.
    import omnivoice
    from services.model_manager import _lazy_omnivoice

    assert _lazy_omnivoice() is omnivoice.OmniVoice, WHY


@pytest.mark.parametrize("env_var", ["OMNIVOICE_DATA_DIR", "OMNIVOICE_CACHE_DIR"])
def test_the_public_env_var_prefix_is_unchanged(env_var):
    # ~150 OMNIVOICE_* vars are a public configuration contract: every user's
    # docker-compose, systemd unit and shell profile. The failure mode of a
    # rename is silent (unset var falls back to a default, it does not error).
    assert env_var in _read("backend/core/config.py") + _read("backend/core/user_env.py"), WHY


# ── and the half that DID change ───────────────────────────────────────────


def test_the_product_name_is_the_new_one():
    conf = json.loads(_read("frontend/src-tauri/tauri.conf.json"))
    assert conf["productName"] == "VoiceStudio"
    assert conf["app"]["windows"][0]["title"] == "VoiceStudio"


def test_the_release_artifact_patterns_follow_the_product_name():
    # Artifact filenames derive from productName, so the preview-manifest
    # matchers must move with it or every preview build refuses to publish.
    manifest = _read("scripts/build_preview_manifest.py")
    assert 'MAC_AARCH64 = "VoiceStudio_aarch64.app.tar.gz"' in manifest
    assert 'MAC_X86_64 = "VoiceStudio_x64.app.tar.gz"' in manifest
    assert "VoiceStudio_" in manifest


def test_the_dev_binary_name_still_cannot_match_the_release_app():
    # The cargo package keeps the old name on purpose: the dev launcher's
    # pkill matches it exactly, and must never match a user's installed app.
    cargo = _read("frontend/src-tauri/Cargo.toml")
    assert re.search(r'(?m)^name\s*=\s*"omnivoice-studio"', cargo)
    common = _read("scripts/desktop-common.mjs")
    assert 'DEV_APP_PROCESS_NAME = "omnivoice-studio"' in common
    assert 'APP_NAME = "VoiceStudio"' in common
