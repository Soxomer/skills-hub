param([string]$Installer = "$PSScriptRoot\..\target\release-assets\ahm-windows-x64-setup.exe")
$ErrorActionPreference = 'Stop'
# Installation changes HKCU protocol/shortcut entries. Run only on disposable CI workers.
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'This installation test requires a disposable GitHub Actions Windows worker.' }
if (Test-Path 'HKCU:\Software\Classes\ahm') { throw 'Refusing to replace an existing ahm protocol registration.' }
$fixture = Join-Path $env:RUNNER_TEMP ('ahm-install-' + [guid]::NewGuid())
$installDir = Join-Path $fixture 'app'
$dataDir = Join-Path $fixture 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$env:AHM_DB = Join-Path $dataDir 'library.db'
$env:AHM_RUNNER_STATE = Join-Path $dataDir 'runner.db'
$sentinel = Join-Path $dataDir 'SKILL.md'
[IO.File]::WriteAllText($sentinel, 'preserve user skill')
[IO.File]::WriteAllText($env:AHM_DB, 'preserve library')
[IO.File]::WriteAllText($env:AHM_RUNNER_STATE, 'preserve runner credential state')
$before = Get-FileHash -LiteralPath $sentinel,$env:AHM_DB,$env:AHM_RUNNER_STATE
function Invoke-Installer {
    $process = Start-Process -FilePath $Installer -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $installDir + '"') -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installation failed: $($process.ExitCode)" }
}
Invoke-Installer
if (-not (Test-Path (Join-Path $installDir 'SkillsHubHelper.exe'))) { throw 'Missing helper' }
$protocol = (Get-Item 'HKCU:\Software\Classes\ahm\shell\open\command').GetValue('')
if ($protocol -ne ('"' + (Join-Path $installDir 'SkillsHubHelper.exe') + '" "%1"')) { throw 'Protocol handoff is not quoted correctly' }
# The installed CLI runs without Rust, Cargo, Git or a source checkout on PATH.
$savedPath = $env:PATH
try {
    $env:PATH = "$env:WINDIR\System32;$env:WINDIR"
    & (Join-Path $installDir 'ahm.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'Packaged CLI requires missing developer dependencies' }
} finally { $env:PATH = $savedPath }
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name SkillsHubHelper -Value ('"' + (Join-Path $installDir 'SkillsHubHelper.exe') + '" --background') -PropertyType String -Force | Out-Null
Invoke-Installer
if (-not (Get-ItemProperty -Path $runKey -Name SkillsHubHelper -ErrorAction SilentlyContinue)) { throw 'Upgrade lost the explicit startup preference' }
$uninstall = Start-Process -FilePath (Join-Path $installDir 'unins000.exe') -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -WindowStyle Hidden -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw 'Uninstall failed' }
if (Test-Path 'HKCU:\Software\Classes\ahm') { throw 'Protocol remains after uninstall' }
if (Get-ItemProperty -Path $runKey -Name SkillsHubHelper -ErrorAction SilentlyContinue) { throw 'Sign-in entry remains after uninstall' }
foreach ($item in $before) {
    if ((Get-FileHash -LiteralPath $item.Path).Hash -ne $item.Hash) { throw 'User data changed during upgrade or uninstall' }
}
Write-Output 'Installer passed: install, quoted protocol, no developer PATH, upgrade preference, uninstall, preserved user data.'
