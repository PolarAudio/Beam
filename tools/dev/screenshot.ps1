<#
.SYNOPSIS
  Captures Beam's window to a PNG over DevTools, without touching the screen.

.DESCRIPTION
  Page.captureScreenshot on port 9223: the page as rendered, at its own
  pixel size, whether or not the window is in front.

.PARAMETER Out
  The PNG to write.

.EXAMPLE
  powershell -File tools/dev/screenshot.ps1 -Out tools/dev/out/now.png
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Port = 9223
)

$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json"
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like 'http://localhost:5173*' } | Select-Object -First 1
if (-not $page) { Write-Output "No Beam page on port $Port."; exit 1 }

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
$msg = '{"id":1,"method":"Page.captureScreenshot","params":{"format":"png"}}'
$bytes = [Text.Encoding]::UTF8.GetBytes($msg)
$ws.SendAsync([ArraySegment[byte]]$bytes, 'Text', $true, [Threading.CancellationToken]::None).Wait()
$buf = New-Object byte[] 4194304
$sb = New-Object Text.StringBuilder
do {
  $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, [Threading.CancellationToken]::None).Result
  [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
} while (-not $r.EndOfMessage)
$json = $sb.ToString() | ConvertFrom-Json
$path = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location) $Out }
New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
[IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($json.result.data))
Write-Output $path
