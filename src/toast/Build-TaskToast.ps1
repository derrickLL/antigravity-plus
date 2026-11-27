[CmdletBinding()]
param(
    [string]$OutputDir = ''
)
$ErrorActionPreference = 'Stop'

if (-not $OutputDir) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $OutputDir = Join-Path $repoRoot 'bin'
}

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) {
    throw '未找到系统内置 .NET Framework C# 编译器 (csc.exe)。'
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$source = Join-Path $PSScriptRoot 'TaskToastHost.cs'
$approvalSource = Join-Path $PSScriptRoot 'NativeApproval.cs'
$output = Join-Path $OutputDir 'TaskToastHost.exe'
$stagedOutput = Join-Path $OutputDir 'TaskToastHost.build.exe'
$oldOutput = Join-Path $OutputDir 'TaskToastHost.old.exe'

if (Test-Path -LiteralPath $stagedOutput) {
    Remove-Item -LiteralPath $stagedOutput -Force
}

$cscArgs = @(
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/codepage:65001',
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Drawing.dll',
    '/r:System.Management.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Web.Extensions.dll',
    "/out:$stagedOutput",
    $source,
    $approvalSource
)

& $compiler @cscArgs
if ($LASTEXITCODE -ne 0) {
    throw "TaskToastHost 编译失败 (exit=$LASTEXITCODE)"
}

if (Test-Path -LiteralPath $oldOutput) {
    Remove-Item -LiteralPath $oldOutput -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $output) {
    try {
        Remove-Item -LiteralPath $output -Force -ErrorAction Stop
    } catch {
        Move-Item -LiteralPath $output -Destination $oldOutput -Force
    }
}
Move-Item -LiteralPath $stagedOutput -Destination $output -Force
if (Test-Path -LiteralPath $oldOutput) {
    Remove-Item -LiteralPath $oldOutput -Force -ErrorAction SilentlyContinue
}
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $bytes = [System.IO.File]::ReadAllBytes($output)
    $hashHex = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
    [PSCustomObject]@{ Algorithm = 'SHA256'; Hash = $hashHex; Path = $output }
} finally {
    $sha.Dispose()
}
