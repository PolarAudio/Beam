<#
.SYNOPSIS
  Starts Beam's dev build detached, its output in tools/dev/out/app.log.

.DESCRIPTION
  Detached so it outlives whatever started it; a background job is stopped at
  its time limit and takes the app down with it. DevTools listen on 9223 for
  eval.ps1 and screenshot.ps1. By default the window opens without
  maximising or taking focus (BEAM_BACKGROUND), so a launch never lands on top
  of someone's work or catches their typing.

.PARAMETER Show
  A .beam to open. Opening a show here, on the first instance, mounts its
  bundled library; handing one to a running Beam does not.

.PARAMETER Foreground
  Open the window normally.

.EXAMPLE
  powershell -File tools/dev/launch.ps1 -Show "C:\path\scene.beam"
#>
param(
  [string]$Show = '',
  [switch]$Foreground
)

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force $out | Out-Null
$log = Join-Path $out 'app.log'

$running = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "$repo\*" }
if ($running) {
  Write-Output "Beam is already running ($($running.Count) processes). Stop it first with stop.ps1."
  exit 1
}

$background = if ($Foreground) { '' } else { 'set "BEAM_BACKGROUND=1" && ' }
$showArg = if ($Show) { " -- `"$Show`"" } else { '' }
$command = "/c ${background}npx electron-vite dev --remoteDebuggingPort 9223$showArg > `"$log`" 2>&1"
Start-Process cmd.exe -ArgumentList $command -WorkingDirectory $repo -WindowStyle Hidden
Write-Output "Launched. Log: $log"
