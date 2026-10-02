#Requires -Version 5.1
<#
.SYNOPSIS
  Pack Game Save Manager into a single-file Windows EXE (Tray Mode on double-click).

.USAGE
  .\pack.ps1
  .\pack.ps1 -SkipInstall
#>
param(
	[switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Fail([string]$Message) {
	Write-Host "ERROR: $Message" -ForegroundColor Red
	exit 1
}

Write-Host '=== Game Save Manager - pack EXE ===' -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
	Fail 'node not found. Install Node.js (LTS) and reopen the terminal.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
	Fail 'npm not found.'
}

$nodeVer = (node -v).Trim()
Write-Host "Node: $nodeVer"

if (-not $SkipInstall) {
	Write-Host ''
	Write-Host '-> npm install' -ForegroundColor Yellow
	npm install
	if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)" }
}

Write-Host ''
Write-Host '-> npm run build:exe' -ForegroundColor Yellow
npm run build:exe
if ($LASTEXITCODE -ne 0) { Fail "pack failed (exit $LASTEXITCODE)" }

$exe = Join-Path $PSScriptRoot 'release\GameSaveManager.exe'
if (-not (Test-Path -LiteralPath $exe)) {
	Fail "output not found: $exe"
}

$sizeMb = [math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 1)
Write-Host ''
Write-Host "OK: $exe ($sizeMb MB)" -ForegroundColor Green
Write-Host '  Double-click EXE -> Tray Mode + open Web UI'
Write-Host '  data/ and backups/ are written next to the EXE'
