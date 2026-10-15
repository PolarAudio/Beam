<#
.SYNOPSIS
  Runs one of the GDTF harness scripts in the running Beam with arguments.

.DESCRIPTION
  Call it with & from PowerShell, not powershell -File: -Params is a
  hashtable, which only passes intact inside one PowerShell.

.EXAMPLE
  $run = 'D:\Projects\beatline\Beam\.claude\skills\gdtf\scripts\beam\run.ps1'
  # Load files side by side, left to right
  & $run -Script load -Params @{ files = @('tools/dev/out/x/orig.gdtf', 'tools/dev/out/x/fixed.gdtf') }
  # One frame with these channel values on every head (names from load's output)
  & $run -Script shot -Params @{ set = @{ 'Dimmer' = 140; 'CTO' = 255 } } -Out D:\...\cto_on.png
  # Engine state for CTO channels
  & $run -Script state -Match '^CT'
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('load', 'shot', 'state')][string]$Script,
  [hashtable]$Params = @{},
  [string]$Match = '.',
  [string]$Out = ''
)
$here = $PSScriptRoot
$repo = Resolve-Path (Join-Path $here '..\..\..\..\..')
$eval = Join-Path $repo 'tools\dev\eval.ps1'
$tmp = Join-Path $repo 'tools\dev\out\gdtf-args.js'
New-Item -ItemType Directory -Force (Split-Path $tmp) | Out-Null

# The harness helpers, once per page load.
$ready = & powershell -NoProfile -File $eval -Expr 'String(!!window.__bt)'
if ($ready -ne 'true') { $null = & powershell -NoProfile -File $eval -File (Join-Path $repo 'tools\dev\regress\prelude.js') }

# Through a file: PowerShell 5.1 strips quotes from native arguments.
$json = $Params | ConvertTo-Json -Compress -Depth 5
$matchJson = $Match | ConvertTo-Json -Compress
[IO.File]::WriteAllText($tmp, "window.__args = $json; window.__stateMatch = $matchJson; 'set'")
$null = & powershell -NoProfile -File $eval -File $tmp

$result = ''
for ($try = 0; $try -lt 2 -and -not $result; $try++) {
  $result = ((& powershell -NoProfile -File $eval -File (Join-Path $here "$Script.js")) -join "`n").Trim()
}
if ($Script -eq 'shot') {
  if (-not ($result -like 'data:image/png;base64,*')) { Write-Output "Shot failed: $result"; exit 1 }
  [IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($result.Substring(22)))
  Write-Output $Out
} else {
  Write-Output $result
}
