<#
.SYNOPSIS
  Renders every regression shot into tools/dev/out/regress/<Label>, and
  compares them with another set.

.DESCRIPTION
  Restarts Beam's dev build with no show, captures each scene from each of its
  cameras at each haze level with the clock frozen, then stops it. The user's
  preferences.json and window-state.json are copied aside first and put back
  after, because the room and bloom are pinned through setters that write them.

  With -Against, every shot is diffed against the same file in that set and a
  table says how many pixels moved by more than 8 levels. A step that is not
  meant to change a scene must leave it at 0.

.EXAMPLE
  powershell -File tools/dev/regress/run.ps1 -Label baseline
  powershell -File tools/dev/regress/run.ps1 -Label after-r1 -Against baseline
  powershell -File tools/dev/regress/run.ps1 -Label after-r1 -Against baseline -CompareOnly
#>
param(
  [Parameter(Mandatory = $true)][string]$Label,
  [string]$Against = '',
  [switch]$CompareOnly
)

$here = $PSScriptRoot
$dev = Split-Path $here
$repo = Resolve-Path (Join-Path $dev '..')
$outRoot = Join-Path $dev 'out\regress'
$outDir = Join-Path $outRoot $Label

# Scene, camera; each at every haze level.
$views = @(
  @('movers', 'front'), @('movers', 'under'),
  @('leds', 'front'), @('laser', 'front'), @('projector', 'front'), @('display', 'front'), @('strobe', 'front'),
  @('reflect', 'front')
)
$hazes = @(0, 25, 50, 100)

if (-not $CompareOnly) {
  $prefs = Join-Path $env:APPDATA 'Beam'
  $keep = Join-Path $outRoot '_prefs'
  New-Item -ItemType Directory -Force $keep | Out-Null
  Copy-Item (Join-Path $prefs 'preferences.json'), (Join-Path $prefs 'window-state.json') $keep -Force

  try {
    & powershell -NoProfile -File (Join-Path $dev 'stop.ps1') -Force | Out-Null
    & powershell -NoProfile -File (Join-Path $dev 'launch.ps1') | Out-Null
    $up = $false
    for ($i = 0; $i -lt 90 -and -not $up; $i++) {
      Start-Sleep -Seconds 2
      $state = & powershell -NoProfile -File (Join-Path $dev 'eval.ps1') -File (Join-Path $dev 'probes\show-state.js') 2>$null
      $up = $state -like '{*'
    }
    if (-not $up) { throw 'Beam did not come up on 9223.' }
    Start-Sleep -Seconds 3

    New-Item -ItemType Directory -Force $outDir | Out-Null
    foreach ($v in $views) {
      foreach ($h in $hazes) {
        $name = "$($v[0])_$($v[1])_h$h.png"
        $r = & powershell -NoProfile -File (Join-Path $here 'capture.ps1') -Scene $v[0] -Camera $v[1] -Haze $h -Out (Join-Path $outDir $name)
        Write-Output "$name  $(if ($r -like 'Shot failed*' -or $r -like 'Setup failed*') { $r } else { 'ok' })"
      }
    }
  } finally {
    & powershell -NoProfile -File (Join-Path $dev 'stop.ps1') -Force | Out-Null
    Copy-Item (Join-Path $keep 'preferences.json'), (Join-Path $keep 'window-state.json') $prefs -Force
    Write-Output 'Stopped Beam; preferences restored.'
  }
}

if ($Against) {
  $base = Join-Path $outRoot $Against
  $tool = Join-Path $dev 'png-tool.cjs'
  Write-Output ''
  Write-Output "Against ${Against}: pixels moved by more than 8 levels, and the largest move"
  Push-Location $repo
  try {
    foreach ($v in $views) {
      foreach ($h in $hazes) {
        $name = "$($v[0])_$($v[1])_h$h.png"
        $a = Join-Path $base $name
        $b = Join-Path $outDir $name
        if (-not (Test-Path $a) -or -not (Test-Path $b)) { Write-Output ("{0,-28} missing" -f $name); continue }
        $d = (& npx electron $tool diff $a $b) -join ' '
        if ($d -match 'differing > 8: (\d+) of (\d+) pixels, largest difference (\d+)') {
          Write-Output ("{0,-28} {1,8}  max {2}" -f $name, $Matches[1], $Matches[3])
        } else {
          Write-Output ("{0,-28} {1}" -f $name, $d.Trim())
        }
      }
    }
  } finally { Pop-Location }
}
