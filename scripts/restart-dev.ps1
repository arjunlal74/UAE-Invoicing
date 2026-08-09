# Stop every API/worker process belonging to this repository, then start one of
# each cleanly.
#
# This exists because a stale process is not an obvious failure: `pkill` does not
# match tsx's Windows command line, so an old build keeps serving on the port
# while a "restarted" one silently fails to bind. Tests then pass or fail
# against code that is not on disk, which is a very expensive kind of confusion.

param(
    [switch]$Reset,      # drop and recreate the database and object storage
    [switch]$NoStart     # stop everything and exit
)

# Not 'Stop': docker writes its progress to stderr, which Windows PowerShell
# turns into a terminating error even when the command succeeds.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$api = Join-Path $repo 'apps\api'

function Invoke-Compose {
    param([string[]]$ComposeArgs)
    $file = Join-Path $repo 'docker-compose.infra.yml'
    & docker compose -f $file @ComposeArgs 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  docker compose $($ComposeArgs -join ' ') failed (exit $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
}

Write-Host 'Stopping existing processes...' -ForegroundColor Cyan
$stopped = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$repo*" -and $_.CommandLine -notlike '*claude*' -and $_.CommandLine -notlike '*restart-dev*' } |
    ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $stopped++ } catch {}
    }
Write-Host "  stopped $stopped process(es)"
Start-Sleep -Seconds 2

if ($Reset) {
    Write-Host 'Resetting infrastructure...' -ForegroundColor Cyan
    Invoke-Compose @('down','-v')
}

Write-Host 'Starting infrastructure...' -ForegroundColor Cyan
Invoke-Compose @('up','-d')

# Wait for Postgres rather than sleeping a guessed interval.
$deadline = (Get-Date).AddSeconds(60)
do {
    Start-Sleep -Seconds 2
    $health = docker inspect --format '{{.State.Health.Status}}' uae-postgres 2>$null
} until ($health -eq 'healthy' -or (Get-Date) -gt $deadline)
Write-Host "  postgres: $health"

if ($Reset) {
    Write-Host 'Seeding...' -ForegroundColor Cyan
    Push-Location $api
    & node (Join-Path $api 'node_modules/tsx/dist/cli.mjs') src/db/seed.ts
    Pop-Location
}

if ($NoStart) { Write-Host 'Done (processes not started).' -ForegroundColor Green; exit 0 }

Write-Host 'Starting api and worker...' -ForegroundColor Cyan
$logs = Join-Path $repo '.logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory $logs | Out-Null }

# node with tsx's CLI directly, not the `npx` shim: Start-Process cannot launch
# a .cmd shim and reports the confusing "not a valid Win32 application".
$tsx = Join-Path $api 'node_modules/tsx/dist/cli.mjs'

Start-Process -FilePath 'node' -ArgumentList $tsx,'src/main.ts' -WorkingDirectory $api `
    -RedirectStandardOutput (Join-Path $logs 'api.log') -RedirectStandardError (Join-Path $logs 'api.err.log') -WindowStyle Hidden
Start-Process -FilePath 'node' -ArgumentList $tsx,'src/worker.ts' -WorkingDirectory $api `
    -RedirectStandardOutput (Join-Path $logs 'worker.log') -RedirectStandardError (Join-Path $logs 'worker.err.log') -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(90)
$ready = $false
do {
    Start-Sleep -Seconds 3
    try {
        $r = Invoke-RestMethod -Uri 'http://localhost:3100/health/ready' -TimeoutSec 5
        $ready = ($r.status -eq 'ready')
    } catch { $ready = $false }
} until ($ready -or (Get-Date) -gt $deadline)

if ($ready) {
    Write-Host 'Ready: http://localhost:3100' -ForegroundColor Green
} else {
    Write-Host 'API did not become ready. Check .logs\api.err.log' -ForegroundColor Red
    exit 1
}
