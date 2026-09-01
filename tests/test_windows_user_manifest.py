import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/build_windows_user_manifest.py"
SPEC = importlib.util.spec_from_file_location("build_windows_user_manifest", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_per_user_manifest_points_only_to_scoped_signed_msi():
    manifest = MODULE.build_manifest(
        repo="debpalash/VoiceStudio",
        tag="v1.2.3",
        version="1.2.3",
        asset="VoiceStudio_Current_User_1.2.3_x64_en-US.msi",
        signature="signed\n",
    )
    entry = manifest["platforms"]["windows-x86_64"]
    assert manifest["version"] == "1.2.3"
    assert entry["signature"] == "signed"
    assert entry["url"].endswith("/VoiceStudio_Current_User_1.2.3_x64_en-US.msi")
    assert set(manifest["platforms"]) == {
        "windows-x86_64",
        "windows-x86_64-msi",
    }
