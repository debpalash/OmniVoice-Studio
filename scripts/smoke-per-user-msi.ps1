param(
    [Parameter(Mandatory = $true)]
    [string]$MsiPath
)

$ErrorActionPreference = "Stop"
$user = "VoiceStudioMsiTest"
$password = "VsMsi-Test-42!"
$secure = ConvertTo-SecureString $password -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$user", $secure)
$resolved = (Resolve-Path $MsiPath).Path
$createdUser = $false

try {
    net user $user $password /add | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "test-user creation exited $LASTEXITCODE" }
    $createdUser = $true
    $install = Start-Process msiexec.exe -Credential $credential -LoadUserProfile -Wait -PassThru -ArgumentList @(
        "/i", "`"$resolved`"", "/qn", "/norestart", "DISABLEWEBVIEW2BOOTSTRAP=1", "AUTOLAUNCHAPP=0"
    )
    if ($install.ExitCode -ne 0) { throw "standard-user install exited $($install.ExitCode)" }

    $root = "C:\Users\$user\AppData\Local\VoiceStudio (Current User)"
    if (-not (Test-Path "$root\omnivoice-studio.exe")) { throw "per-user shell missing at $root" }
    if (-not (Test-Path "$root\uv.exe")) { throw "per-user uv sidecar missing at $root" }

    $uninstall = Start-Process msiexec.exe -Credential $credential -LoadUserProfile -Wait -PassThru -ArgumentList @(
        "/x", "`"$resolved`"", "/qn", "/norestart"
    )
    if ($uninstall.ExitCode -ne 0) { throw "standard-user uninstall exited $($uninstall.ExitCode)" }
    if (Test-Path "$root\omnivoice-studio.exe") { throw "per-user shell remains after uninstall" }
}
finally {
    if ($createdUser) {
        net user $user /delete 2>$null | Out-Null
    }
}
