param(
    [Parameter(Mandatory = $true)]
    [string]$MsiPath
)

$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path $MsiPath).Path
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($resolved, 0)

function Get-MsiValue([string]$Query) {
    $view = $database.OpenView($Query)
    try {
        $view.Execute()
        $record = $view.Fetch()
        if ($null -eq $record) { return $null }
        return $record.StringData(1)
    }
    finally {
        $view.Close()
    }
}

function Assert-Contains([string]$Value, [string]$Expected, [string]$Label) {
    if ([string]::IsNullOrEmpty($Value) -or -not $Value.Contains($Expected)) {
        throw "$Label missing '$Expected' (actual: '$Value')"
    }
}

$secure = Get-MsiValue "SELECT ``Value`` FROM ``Property`` WHERE ``Property``='SecureCustomProperties'"
Assert-Contains $secure "ALLOWWEBVIEW2BOOTSTRAP" "secure MSI properties"
Assert-Contains $secure "DISABLEWEBVIEW2BOOTSTRAP" "secure MSI properties"

$bootstrapCondition = Get-MsiValue "SELECT ``Condition`` FROM ``InstallExecuteSequence`` WHERE ``Action``='DownloadAndInvokeBootstrapper'"
Assert-Contains $bootstrapCondition 'ALLOWWEBVIEW2BOOTSTRAP = "1"' "WebView2 bootstrap condition"
Assert-Contains $bootstrapCondition 'DISABLEWEBVIEW2BOOTSTRAP <> "1"' "WebView2 bootstrap condition"

$launchCondition = Get-MsiValue "SELECT ``Condition`` FROM ``InstallExecuteSequence`` WHERE ``Action``='LaunchApplication'"
Assert-Contains $launchCondition 'AUTOLAUNCHAPP <> "0"' "launch condition"

$runtimeCondition = Get-MsiValue "SELECT ``Condition`` FROM ``LaunchCondition`` WHERE ``Condition``='Installed OR REMOVE OR INSTALLED_WEBVIEW2_VERSION OR (ALLOWWEBVIEW2BOOTSTRAP = `"1`" AND DISABLEWEBVIEW2BOOTSTRAP <> `"1`")'"
Assert-Contains $runtimeCondition "INSTALLED_WEBVIEW2_VERSION" "fail-closed runtime condition"

$bootstrapCommand = Get-MsiValue "SELECT ``Target`` FROM ``CustomAction`` WHERE ``Action``='DownloadAndInvokeBootstrapper'"
Assert-Contains $bootstrapCommand "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "WebView2 bootstrap URL"
Assert-Contains $bootstrapCommand "Start-Process" "WebView2 silent invocation"

$machineDetection = Get-MsiValue "SELECT ``Key`` FROM ``RegLocator`` WHERE ``Signature_``='Webview2VersionSystemx86'"
$userDetection = Get-MsiValue "SELECT ``Key`` FROM ``RegLocator`` WHERE ``Signature_``='Webview2VersionUser'"
Assert-Contains $machineDetection "Microsoft\EdgeUpdate\Clients" "machine WebView2 detection"
Assert-Contains $userDetection "Microsoft\EdgeUpdate\Clients" "user WebView2 detection"

Write-Host "Verified managed WebView2 and AUTOLAUNCHAPP contracts in $resolved"
