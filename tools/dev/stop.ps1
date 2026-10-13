<#
.SYNOPSIS
  Stops Beam's dev build, by executable path only.

.DESCRIPTION
  Never by a port or a PID read from netstat: MadMapper connects to Beam's
  ports, so its PID shows up there too, and killing by it closes MadMapper.

  Refuses while the open show has unsaved changes, which closing would lose,
  unless -Force is given. The check needs DevTools on 9223 (launch.ps1); with
  no answer it refuses too, rather than guess.

.PARAMETER Force
  Stop even with unsaved changes or no answer from the app.
#>
param([switch]$Force)

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')

if (-not $Force) {
  $state = $null
  try {
    $state = & powershell -NoProfile -File (Join-Path $PSScriptRoot 'eval.ps1') -File (Join-Path $PSScriptRoot 'probes\show-state.js') | ConvertFrom-Json
  } catch {}
  if (-not $state) {
    Write-Output 'No answer from the app on 9223, so its show state is unknown. Use -Force to stop it anyway.'
    exit 1
  }
  if (-not $state.saved) {
    Write-Output "The open show has unsaved changes ($($state.path)). Save it, or use -Force."
    exit 1
  }
}

Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "$repo\*" } |
  Stop-Process -Force -Confirm:$false
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*electron-vite*dev*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
Write-Output 'Stopped.'
