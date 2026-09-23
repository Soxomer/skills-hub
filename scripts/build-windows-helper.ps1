param(
    [string]$Runner = "$PSScriptRoot\..\target\release\ahm.exe",
    [string]$Iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    [switch]$HelperOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$payload = Join-Path $repoRoot 'target\windows-helper'
New-Item -ItemType Directory -Force -Path $payload | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$references = Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /warnaserror+ "/out:$payload\SkillsHubHelper.exe" "/win32manifest:$repoRoot\packaging\windows\helper.manifest" "/reference:$references\Microsoft.VisualBasic.dll" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.dll /reference:System.Web.Extensions.dll "$repoRoot\packaging\windows\Helper.cs"
if ($LASTEXITCODE -ne 0) { throw 'Helper compilation failed' }
if ($HelperOnly) { return }
Copy-Item -LiteralPath $Runner -Destination (Join-Path $payload 'ahm.exe') -Force
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
& $Iscc "/DAppVersion=$version" "/DPayloadDir=$payload" "$repoRoot\packaging\windows\helper.iss"
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed' }
