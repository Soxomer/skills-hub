$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$output = Join-Path $repoRoot 'target\windows-helper-tests'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$references = Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8'
& $compiler /nologo /target:exe /platform:x64 /warnaserror+ /main:HelperTests "/out:$output\tests.exe" "/reference:$references\Microsoft.VisualBasic.dll" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.dll /reference:System.Web.Extensions.dll "$repoRoot\packaging\windows\Helper.cs" "$repoRoot\packaging\windows\HelperTests.cs"
if ($LASTEXITCODE -ne 0) { throw 'Helper test compilation failed' }
& "$output\tests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Helper tests failed' }
