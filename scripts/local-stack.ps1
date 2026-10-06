# =============================================================================
# AfriBot — stack locale Windows (PostgreSQL + Redis natifs, sans Docker/WSL)
#
# Contexte : cette machine n'a ni virtualisation firmware (WSL2 impossible) ni
# droits admin (WSL1 impossible non-plus). Les binaires sont donc extraits dans
# C:\AfriBot et lancés en simples processus utilisateur.
#
# Usage :
#   powershell -File scripts\local-stack.ps1 start
#   powershell -File scripts\local-stack.ps1 stop
#   powershell -File scripts\local-stack.ps1 status
# =============================================================================
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'logs')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

# --- Chemins -----------------------------------------------------------------
$Root      = 'C:\AfriBot'
$PgBin     = Join-Path $Root 'pgsql\bin'
$PgData    = Join-Path $Root 'pgdata'
$PgLog     = Join-Path $Root 'logs\postgres.log'
$RedisExe  = Join-Path $Root 'redis\redis-server.exe'
$RedisConf = Join-Path $Root 'redis\redis.conf'
$RedisLog  = Join-Path $Root 'logs\redis.log'

# Doivent rester alignés sur le .env du projet
$PgPort    = 5432
$RedisPort = 6379

function Test-Port([int]$Port) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
}

# IMPORTANT : ne JAMAIS appeler pg_ctl via un pipe (« & pg_ctl ... | Out-Null »).
# `pg_ctl start` lance `postgres.exe`, qui HÉRITE du handle stdout du pipe ; le
# pipe ne se ferme donc jamais et le script reste bloqué indéfiniment (le serveur
# démarre, mais le script n'avance plus). Start-Process évite tout pipe partagé.
function Start-PgCtl([string[]]$PgCtlArgs) {
    $p = Start-Process -FilePath (Join-Path $PgBin 'pg_ctl.exe') `
        -ArgumentList $PgCtlArgs -WindowStyle Hidden -PassThru -Wait
    return $p.ExitCode
}

function Show-Status {
    $pg = Test-Port $PgPort
    $rd = Test-Port $RedisPort
    Write-Host ''
    Write-Host '=== AfriBot — stack locale ===' -ForegroundColor Cyan
    Write-Host ("PostgreSQL :{0} {1}" -f $PgPort, $(if ($pg) { 'EN MARCHE' } else { 'ARRETE' })) `
        -ForegroundColor $(if ($pg) { 'Green' } else { 'Red' })
    Write-Host ("Redis      :{0} {1}" -f $RedisPort, $(if ($rd) { 'EN MARCHE' } else { 'ARRETE' })) `
        -ForegroundColor $(if ($rd) { 'Green' } else { 'Red' })
    Write-Host ''
    Write-Host 'DATABASE_URL attendu :' -ForegroundColor DarkGray
    Write-Host '  postgresql://afribot_user:change-moi-mot-de-passe-fort@localhost:5432/afribot' -ForegroundColor DarkGray
    Write-Host 'REDIS_URL attendu :' -ForegroundColor DarkGray
    Write-Host '  redis://:change-moi-redis-secret@localhost:6379/0' -ForegroundColor DarkGray
    Write-Host ''
}

switch ($Action) {
    'start' {
        if (-not (Test-Path $PgBin)) { throw "Binaires PostgreSQL absents : $PgBin (voir scripts\setup-local-stack.ps1)" }

        if (-not (Test-Port $PgPort)) {
            Write-Host 'Demarrage PostgreSQL...' -ForegroundColor Yellow
            # -w : pg_ctl attend que le serveur accepte les connexions avant de rendre la main
            $code = Start-PgCtl @('-D', $PgData, '-l', $PgLog, '-o', "-p $PgPort", '-w', 'start')
            if ($code -ne 0) { throw "pg_ctl start a echoue (code $code) - voir $PgLog" }
        }

        if (-not (Test-Port $RedisPort)) {
            Write-Host 'Demarrage Redis...' -ForegroundColor Yellow
            Start-Process -FilePath $RedisExe -ArgumentList $RedisConf -WindowStyle Hidden
            Start-Sleep -Seconds 2
        }

        Show-Status
    }

    'stop' {
        if (Test-Port $PgPort) {
            Write-Host 'Arret PostgreSQL...' -ForegroundColor Yellow
            # -m fast : coupe les connexions en cours proprement (pas de pipe, cf. Start-PgCtl)
            $code = Start-PgCtl @('-D', $PgData, '-m', 'fast', 'stop')
            if ($code -ne 0) { throw "pg_ctl stop a echoue (code $code)" }
        }
        # Redis n'a pas de commande d'arrêt native : on cible le processus
        Get-Process redis-server -ErrorAction SilentlyContinue | Stop-Process -Force
        Show-Status
    }

    'status' { Show-Status }

    'logs' {
        Write-Host '=== postgres.log (20 dernieres lignes) ===' -ForegroundColor Cyan
        if (Test-Path $PgLog) { Get-Content $PgLog -Tail 20 } else { Write-Host '(absent)' }
        Write-Host ''
        Write-Host '=== redis.log (20 dernieres lignes) ===' -ForegroundColor Cyan
        if (Test-Path $RedisLog) { Get-Content $RedisLog -Tail 20 } else { Write-Host '(absent)' }
    }
}