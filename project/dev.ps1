# Start backend (Python) + frontend, visit http://localhost:3000
$root = $PSScriptRoot

# Admin credentials (change before first run, or set env vars externally)
if (-not $env:ADMIN_USER) { $env:ADMIN_USER = "admin" }
if (-not $env:ADMIN_PASS) { $env:ADMIN_PASS = "admin123" }
Write-Host "== Admin: $env:ADMIN_USER ==" -ForegroundColor Magenta

# Kill previous backend if port 4000 is occupied
$existing = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $existing | ForEach-Object {
        Write-Host "== Killing old process on port 4000 (PID $($_.OwningProcess)) ==" -ForegroundColor Yellow
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
}

Write-Host "== Starting Python backend (port 4000) ==" -ForegroundColor Cyan
$backend = Start-Process -PassThru -NoNewWindow -FilePath "uv" `
  -ArgumentList "run","python","app.py" `
  -WorkingDirectory "$root\server-py" `
  -RedirectStandardError "$root\server.log"

Write-Host "   Backend log: $root\server.log"
Write-Host "   Waiting for backend..." -NoNewline

# Wait until port 4000 is listening (timeout 60s)
$timeout = 60
$elapsed = 0
while ($elapsed -lt $timeout) {
    $listening = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
    if ($listening) { break }
    if ($backend.HasExited) {
        Write-Host ""
        Write-Host "== Backend failed! Check server.log ==" -ForegroundColor Red
        Get-Content "$root\server.log" -Tail 10
        exit 1
    }
    Start-Sleep -Seconds 2
    $elapsed += 2
    Write-Host "." -NoNewline
}
Write-Host ""

if ($elapsed -ge $timeout) {
    Write-Host "== Backend start timeout ==" -ForegroundColor Red
    exit 1
}

Write-Host "== Backend ready ==" -ForegroundColor Green
Write-Host ""
Write-Host "== Start Frontend (port 3000, proxy /api -> 4000) ==" -ForegroundColor Cyan
Set-Location "$root\client"
npm install
npm run dev

# Ctrl+C exits frontend, clean up backend
if ($backend -and !$backend.HasExited) { Stop-Process -Id $backend.Id }
Write-Host "== Backend stopped ==" -ForegroundColor Yellow
