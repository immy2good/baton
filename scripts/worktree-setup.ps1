#requires -Version 7.0
<#
.SYNOPSIS
  Bring a fresh git worktree up to a working environment from the repo's baton.json.

.DESCRIPTION
  A new worktree has no dependencies and no local config. This script runs the
  repo's `worktree.setup` lines from inside any linked worktree, however it was
  created (Claude Code --worktree, EnterWorktree, `git worktree add`, a launcher).

  One source of truth per repo: baton.json -> worktree.setup (or paseo.json, so a
  repo that Paseo also sets up keeps a single block). Nothing here is
  repo-specific. Lines are executed with Invoke-Expression; they are reviewed as
  part of the PR that changes the config file. Both
  $env:BATON_SOURCE_CHECKOUT_PATH and $env:PASEO_SOURCE_CHECKOUT_PATH are set to
  the main checkout, so a block written for either works.

.PARAMETER Path
  Worktree root. Defaults to the current directory.

.PARAMETER Force
  Re-run even if this worktree already carries a completed marker.

.OUTPUTS
  Exit 0 when every line ran (or nothing to do), 1 when any line failed, 2 when
  the path is not a git checkout. A marker file .baton-worktree-setup.done records
  the last successful run so hooks can call this on every session start cheaply.
  A Paseo-written .paseo-worktree-setup.done marker counts too, so a worktree a
  launcher already set up is not set up twice.
#>
[CmdletBinding()]
param(
  [string]$Path = (Get-Location).Path,
  [switch]$Force
)

Set-Location -LiteralPath $Path

# git prints every path in its own (forward-slash) form; compare like with like.
$gitDir    = & git rev-parse --path-format=absolute --git-dir 2>$null
if ($LASTEXITCODE -ne 0 -or -not $gitDir) { Write-Host "[worktree-setup] not a git checkout: $Path"; exit 2 }
$commonDir = & git rev-parse --path-format=absolute --git-common-dir 2>$null
$topLevel  = & git rev-parse --show-toplevel 2>$null
$isLinked  = ($gitDir -ne $commonDir)

if (-not $isLinked) {
  Write-Host "[worktree-setup] $topLevel is the main checkout; nothing to set up."
  exit 0
}

$source = Split-Path -Parent $commonDir
$marker = Join-Path $topLevel '.baton-worktree-setup.done'
$launcherMarker = Join-Path $topLevel '.paseo-worktree-setup.done'
if (-not $Force) {
  foreach ($m in @($marker, $launcherMarker)) {
    if (Test-Path $m) {
      Write-Host "[worktree-setup] already set up ($(Get-Content $m -TotalCount 1)); use -Force to rerun."
      exit 0
    }
  }
}

$cfgFile = $null
foreach ($name in @('baton.json', 'paseo.json')) {
  $candidate = Join-Path $topLevel $name
  if (Test-Path $candidate) { $cfgFile = $candidate; break }
}
if (-not $cfgFile) {
  Write-Host "[worktree-setup] no baton.json in $topLevel - this repo has no worktree environment contract yet."
  exit 0
}

$cfg = Get-Content -Raw $cfgFile | ConvertFrom-Json
$lines = @()
if ($cfg.worktree -and $cfg.worktree.setup) { $lines = @($cfg.worktree.setup) }
if ($lines.Count -eq 0) {
  Write-Host "[worktree-setup] $(Split-Path -Leaf $cfgFile) has no worktree.setup lines."
  exit 0
}

# A block may end by writing a marker itself (for launcher-native runs). Here the
# marker is written only when every line succeeded, so skip that line.
$lines = @($lines | Where-Object { $_ -notmatch '\.(baton|paseo)-worktree-setup\.done' })

$env:BATON_SOURCE_CHECKOUT_PATH = $source
$env:PASEO_SOURCE_CHECKOUT_PATH = $source

# Evidence must outlive stdout. A long `npm ci` (hundreds of packages) outlasts some
# harnesses' command-capture window, so the agent never sees the final line and
# reruns -Force, reinstalling everything. Every script line therefore also
# goes to a log inside this worktree's private git dir: never tracked, no .gitignore
# entry needed, readable after the fact with `Get-Content`.
$logPath = Join-Path $gitDir 'baton-worktree-setup.log'
# Logging must never be able to break or mis-score the run it exists to witness: a
# locked or unwritable log (AV scan, read-only mount, path length) is swallowed here,
# whatever $ErrorActionPreference says. stdout still carries every line.
function Write-SetupLog([string]$msg, [switch]$Reset) {
  Write-Host $msg
  try {
    if ($Reset) { Set-Content -Path $logPath -Value $msg -ErrorAction Stop }
    else { Add-Content -Path $logPath -Value $msg -ErrorAction Stop }
  } catch { }
}
Set-Alias -Name Say -Value Write-SetupLog -Scope Script
Write-SetupLog ("# worktree-setup run {0}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')) -Reset

Say "[worktree-setup] worktree: $topLevel"
Say "[worktree-setup] source:   $source"

$ErrorActionPreference = 'Stop'
$failed = 0
$i = 0
foreach ($line in $lines) {
  $i++
  Say "[worktree-setup] ($i/$($lines.Count)) $line"
  try {
    $global:LASTEXITCODE = 0
    Invoke-Expression $line
    if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) {
      throw "exit code $LASTEXITCODE"
    }
    Say "[worktree-setup]   ok"
  } catch {
    $failed++
    Say "[worktree-setup]   FAILED: $($_.Exception.Message)"
  }
}

if ($failed -eq 0) {
  Set-Content -Path $marker -Value ("{0} from {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $source)
  Say "[worktree-setup] done: $($lines.Count) line(s) ok."
  Say "[worktree-setup] log: $logPath"
  exit 0
}

Say "[worktree-setup] $failed of $($lines.Count) line(s) failed; marker not written."
Say "[worktree-setup] log: $logPath"
exit 1
