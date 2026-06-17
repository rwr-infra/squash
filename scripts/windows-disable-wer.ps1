<#
.SYNOPSIS
    Disables the Windows Error Reporting (WER) crash dialog for rwr_server.exe.

.DESCRIPTION
    When rwr_server.exe crashes on Windows, WER pops a "has stopped working"
    dialog and the process HANGS waiting for it to be dismissed. node-pty never
    receives an exit event, so squash's auto-restart can never kick in until a
    human clicks the dialog.

    This script adds rwr_server.exe to WER's ExcludedApplications list so that a
    crash terminates the process immediately (no dialog) — squash then sees the
    exit and auto-restarts normally. This is the root-cause fix; squash also
    ships an in-app WerFault watchdog as a fallback if you cannot run this.

    Requires Administrator privileges (writes to HKLM).

.PARAMETER ExeName
    Executable name to exclude. Defaults to rwr_server.exe.

.PARAMETER GlobalDisableUi
    Also set DontShowUI=1 machine-wide (suppresses the WER UI for ALL apps).
    Use with care.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\windows-disable-wer.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\windows-disable-wer.ps1 -ExeName rwr_server.exe -GlobalDisableUi
#>
[CmdletBinding()]
param(
    [string]$ExeName = 'rwr_server.exe',
    [switch]$GlobalDisableUi
)

$ErrorActionPreference = 'Stop'

# --- Require elevation -------------------------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Error "This script must be run as Administrator (it writes to HKLM). Re-run from an elevated PowerShell."
    exit 1
}

$werRoot = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting'
$excludedRoot = Join-Path $werRoot 'ExcludedApplications'

# --- Per-app exclusion (preferred: smallest blast radius) --------------------
if (-not (Test-Path $excludedRoot)) {
    New-Item -Path $excludedRoot -Force | Out-Null
}
New-ItemProperty -Path $excludedRoot -Name $ExeName -Value 1 -PropertyType DWord -Force | Out-Null
Write-Host "[OK] Added '$ExeName' to WER ExcludedApplications. Crashes will no longer show a dialog." -ForegroundColor Green

# --- Optional machine-wide UI suppression ------------------------------------
if ($GlobalDisableUi) {
    New-ItemProperty -Path $werRoot -Name 'DontShowUI' -Value 1 -PropertyType DWord -Force | Out-Null
    Write-Host "[OK] Set DontShowUI=1 machine-wide (suppresses WER UI for all applications)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. rwr_server.exe will now exit immediately on crash, letting squash auto-restart it." -ForegroundColor Cyan
