<#
.SYNOPSIS
  Captures one regression shot from the running dev build to a PNG.

.DESCRIPTION
  Loads prelude.js and scenes.js if the page does not have them yet, sets
  window.__args and runs shot.js, which returns the frame as a data URL.

.EXAMPLE
  powershell -File tools/dev/regress/capture.ps1 -Scene movers -Haze 50 -Camera front -Out x.png
  powershell -File tools/dev/regress/capture.ps1 -Scene movers -Haze 0 -House up -Out x.png
#>
param(
  [Parameter(Mandatory = $true)][string]$Scene,
  [Parameter(Mandatory = $true)][int]$Haze,
  [string]$Camera = 'front',
  [ValidateSet('down', 'up')][string]$House = 'down',
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 1280,
  [int]$Height = 720
)

$here = $PSScriptRoot
$eval = Join-Path $here '..\eval.ps1'

$ready = & powershell -NoProfile -File $eval -Expr "String(!!(window.__bt && window.__scenes))"
if ($ready -ne 'true') {
  $r1 = & powershell -NoProfile -File $eval -File (Join-Path $here 'prelude.js')
  $r2 = & powershell -NoProfile -File $eval -File (Join-Path $here 'scenes.js')
  if ($r1 -ne 'ok' -or -not $r2) { Write-Output "Setup failed: $r1 $r2"; exit 1 }
}

$argJson = @{ scene = $Scene; haze = $Haze; camera = $Camera; house = $House; width = $Width; height = $Height } | ConvertTo-Json -Compress
# Through a file: PowerShell 5.1 strips the quotes from a native argument.
$argFile = Join-Path $here '..\out\regress-args.js'
New-Item -ItemType Directory -Force (Split-Path $argFile) | Out-Null
[IO.File]::WriteAllText($argFile, "window.__args = $argJson; 'set'")
$null = & powershell -NoProfile -File $eval -File $argFile
$data = ''
# The first shot after a scene is built sometimes comes back with no value;
# the scene is standing by then and a second asking returns the frame.
for ($try = 0; $try -lt 2 -and -not ($data -like 'data:image/png;base64,*'); $try++) {
  $data = ((& powershell -NoProfile -File $eval -File (Join-Path $here 'shot.js')) -join '').Trim()
}
if (-not ($data -like 'data:image/png;base64,*')) { Write-Output "Shot failed: $data"; exit 1 }

$path = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location) $Out }
New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
[IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($data.Substring(22)))
Write-Output $path
