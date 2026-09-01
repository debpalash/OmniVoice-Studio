import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "frontend/src-tauri/wix/main.wxs"
SCRIPT = ROOT / "scripts/render-per-user-wix.py"
CONFIG = ROOT / "frontend/src-tauri/tauri.per-user.conf.json"


def _renderer():
    spec = importlib.util.spec_from_file_location("render_per_user_wix", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_machine_and_per_user_templates_have_distinct_scopes_and_roots():
    machine = SOURCE.read_text(encoding="utf-8")
    user = _renderer().render(machine)

    assert 'InstallScope="perMachine"' in machine
    assert 'InstallScope="perUser"' in user
    assert 'Directory Id="$(var.PlatformProgramFilesFolder)"' in machine
    assert 'Directory Id="LocalAppDataFolder"' in user
    assert 'Name="InstallScope" Type="string" Value="perMachine"' in machine
    assert 'Name="InstallScope" Type="string" Value="perUser"' in user
    assert 'Id="PrevInstallDirNoName" Root="HKLM"' in machine
    assert 'Id="PrevInstallDirNoName" Root="HKCU"' in user
    assert 'Id="PrevInstallDirWithName" Root="HKLM"' in machine
    assert 'Id="PrevInstallDirWithName" Root="HKCU"' in user
    assert '<RegistryKey Root="HKCU" Key="Software\\\\{{manufacturer}}\\\\{{product_name}}">' in user
    assert '<RegistryKey Root="HKCU" Key="Software\\Classes\\\\{{protocol}}">' in user
    assert 'Guid="{{path_component_guid}}"' in machine
    assert 'Guid="41f6d598-8908-4004-9332-291b64fd38be"' in user


def test_per_user_bundle_has_separate_identity_and_no_elevated_update_task():
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    assert config["productName"].endswith("(Current User)")
    wix = config["bundle"]["windows"]["wix"]
    assert wix["upgradeCode"] == "f27de3a8-a9dc-4a3d-84bb-e98f1bf82393"
    assert wix["enableElevatedUpdateTask"] is False
    assert wix["template"] == "target/wix-per-user/main.wxs"


def test_per_user_template_never_contains_webview_install_actions():
    machine = SOURCE.read_text(encoding="utf-8")
    user = _renderer().render(machine)

    assert "https://go.microsoft.com/fwlink/p/?LinkId=2124703" in machine
    assert "ALLOWWEBVIEW2BOOTSTRAP" in machine
    for forbidden in (
        "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
        "ALLOWWEBVIEW2BOOTSTRAP",
        "DownloadAndInvokeBootstrapper",
        "InvokeBootstrapper",
        "InvokeStandalone",
        "UpdateWebView2ViaEdgeUpdate",
    ):
        assert forbidden not in user
    assert "Installed OR REMOVE OR INSTALLED_WEBVIEW2_VERSION" in user


def test_release_builds_publishes_and_smokes_as_a_standard_user():
    workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    smoke = (ROOT / "scripts/smoke-per-user-msi.ps1").read_text(encoding="utf-8")
    updater = (ROOT / "frontend/src-tauri/src/updater_channel.rs").read_text(encoding="utf-8")

    assert "render-per-user-wix.py" in workflow
    assert "tauri.per-user.conf.json" in workflow
    assert 'artifact// (Current User)/_Current_User' in workflow
    assert "latest-user.json" in workflow
    assert "smoke-per-user-msi.ps1" in workflow
    assert "Start-Process msiexec.exe -Credential" in smoke
    assert 'if ($LASTEXITCODE -ne 0)' in smoke
    assert 'if ($createdUser)' in smoke
    assert "standard-user uninstall" in smoke
    assert "latest/download/latest-user.json" in updater
    assert "releases/download/preview/latest-user.json" in updater
