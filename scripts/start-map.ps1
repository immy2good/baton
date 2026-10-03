# scripts/start-map.ps1 — One-click launcher for baton swarm map
param(
  [switch]$Stop,
  [switch]$Restart,
  [switch]$NoBrowser,
  [int]$Port = 8766
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

# 1. Find any process already listening on the port
function Get-MapProcess {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn -and $conn.OwningProcess) {
    return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  }
  return $null
}

$proc = Get-MapProcess

if ($Stop -or $Restart) {
  if ($proc) {
    Write-Host "Stopping swarm map (PID $($proc.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $proc.Id -Force
    Start-Sleep -Milliseconds 800
  } else {
    Write-Host "swarm map is not currently running on port $Port." -ForegroundColor Gray
  }
  if ($Stop) { exit 0 }
}

# 2. Check if already running
$proc = Get-MapProcess
if ($proc) {
  Write-Host "✓ swarm map is already running (PID $($proc.Id)) on http://127.0.0.1:$Port" -ForegroundColor Green
} else {
  Write-Host "Starting swarm map on http://127.0.0.1:$Port..." -ForegroundColor Cyan
  $scriptPath = Join-Path $RepoRoot "scripts\swarm-map.mjs"
  
  # Launch detached background process using node
  Start-Process -FilePath "node" -ArgumentList "`"$scriptPath`"" -WorkingDirectory $RepoRoot -WindowStyle Hidden
  
  # Wait for port to become active
  $started = $false
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-MapProcess) {
      $started = $true
      break
    }
  }
  
  if ($started) {
    Write-Host "✓ swarm map started successfully!" -ForegroundColor Green
  } else {
    Write-Host "! Engine launched; waiting for port $Port to bind..." -ForegroundColor Yellow
  }
}

$url = "http://127.0.0.1:$Port"
Write-Host ""
Write-Host "==========================================================" -ForegroundColor DarkCyan
Write-Host "  baton swarm map: $url" -ForegroundColor Cyan
Write-Host "  Agents + worktrees + checkpoints + TypeSafe Jev triage" -ForegroundColor DarkGray
Write-Host "==========================================================" -ForegroundColor DarkCyan
Write-Host ""

if (-not $NoBrowser) {
  Start-Process $url
}
