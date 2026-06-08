[CmdletBinding()]
param(
  [string]$PackageUrl = "https://github.com/Open-Agent-Tools/timelapse-capture/releases/latest/download/timelapse-capture.tgz",
  [switch]$Main
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Main) {
  $PackageUrl = "https://github.com/Open-Agent-Tools/timelapse-capture/tarball/main"
}

function Test-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Update-PathFromRegistry {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathParts = @($machinePath, $userPath) | Where-Object { $_ }
  $env:Path = $pathParts -join ";"
}

function Get-NodeMajor {
  if (-not (Test-Command "node")) {
    return $null
  }

  $versionText = (& node --version).Trim()
  if ($versionText -match "^v(?<major>\d+)\.") {
    return [int]$Matches.major
  }

  throw "Could not parse Node.js version: $versionText"
}

function Install-WingetPackage {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if (-not (Test-Command "winget")) {
    throw "winget is not available. Install $Name manually, open a new PowerShell window, then rerun this script."
  }

  Write-Host "Installing $Name with winget..."
  winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements
  Update-PathFromRegistry
}

Write-Host "Checking Node.js..."
$nodeMajor = Get-NodeMajor
if ($null -eq $nodeMajor -or $nodeMajor -lt 24) {
  Install-WingetPackage -Id "OpenJS.NodeJS" -Name "Node.js 24 or newer"
  $nodeMajor = Get-NodeMajor
}

if ($null -eq $nodeMajor -or $nodeMajor -lt 24) {
  throw "Node.js 24 or newer is required. Open a new PowerShell window and rerun: node --version"
}

if (-not (Test-Command "npm")) {
  throw "npm was not found after installing Node.js. Open a new PowerShell window and rerun this script."
}

Write-Host "Installing timelapse-capture..."
npm install -g $PackageUrl

Write-Host "Verifying installation..."
timelapse-capture doctor
