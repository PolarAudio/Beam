<#
.SYNOPSIS
  Runs JavaScript in Beam's renderer over DevTools and prints the result.

.DESCRIPTION
  One Runtime.evaluate on port 9223 (launch.ps1 opens it), awaiting a promise
  and returning by value. Return a JSON string from the script for anything
  structured. Prints the value alone, or the exception's text.

  The renderer's show is
    document.querySelector('#app').__vue_app__.config.globalProperties.$show
  and its visualizer is $show.visualizerHandle. Modules load by their dev
  URL, e.g. await import('/src/plugins/visualizer/controls.js').

  Read, select and measure; do not add to the scene, move its items or send
  it content -- the scene and what plays on it belong to the person using it.

.PARAMETER File
  A .js file holding one expression, typically an async IIFE.

.PARAMETER Expr
  The expression itself, for a one-liner.

.EXAMPLE
  powershell -File tools/dev/eval.ps1 -File tools/dev/probes/show-state.js
#>
param(
  [string]$File = '',
  [string]$Expr = '',
  [int]$Port = 9223
)

# Read whole, as text: PowerShell 5.1 mangles some characters on other paths.
$expression = if ($File) { [System.IO.File]::ReadAllText((Resolve-Path $File)) } else { $Expr }
if (-not $expression) { Write-Output 'Give -File or -Expr.'; exit 1 }

$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json"
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like 'http://localhost:5173*' } | Select-Object -First 1
if (-not $page) { Write-Output "No Beam page on port $Port."; exit 1 }

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(30)
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
$msg = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $expression; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Depth 5 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($msg)
$ws.SendAsync([ArraySegment[byte]]$bytes, 'Text', $true, [Threading.CancellationToken]::None).Wait()
$buf = New-Object byte[] 1048576
$sb = New-Object Text.StringBuilder
do {
  $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, [Threading.CancellationToken]::None).Result
  [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
} while (-not $r.EndOfMessage)

$reply = $sb.ToString() | ConvertFrom-Json
if ($reply.result.exceptionDetails) {
  Write-Output "Exception: $($reply.result.exceptionDetails.exception.description)"
  exit 1
}
Write-Output $reply.result.result.value
