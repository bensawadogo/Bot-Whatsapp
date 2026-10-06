# =============================================================================
# AfriBot — installation de la stack locale Windows (PostgreSQL + Redis natifs)
#
# Prérequis : les 2 archives téléchargées dans %TEMP% (voir ci-dessous).
# Ce script NE nécessite NI droits admin, NI Docker, NI WSL.
#
# Usage : powershell -ExecutionPolicy Bypass -File scripts\setup-local-stack.ps1
# =============================================================================
$ErrorActionPreference = 'Stop'

$Root    = 'C:\AfriBot'
$PgJar   = Join-Path $env:TEMP 'pg-embedded.jar'
$RedisZip = Join-Path $env:TEMP 'redis-x64.zip'
$Tmp     = Join-Path $env:TEMP 'afribot-extract'

# Doivent rester alignés sur le .env du projet
$PgUser     = 'afribot_user'
$PgPassword = 'change-moi-mot-de-passe-fort'
$PgDatabase = 'afribot'
$RedisPassword = 'change-moi-redis-secret'

Write-Host '=== 1/5 Preparation des dossiers ===' -ForegroundColor Cyan
foreach ($dir in @($Root, "$Root\pgdata", "$Root\logs", "$Root\redis", "$Root\pgsql", $Tmp)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

Write-Host '=== 2/5 Extraction de PostgreSQL ===' -ForegroundColor Cyan
if (-not (Test-Path "$Root\pgsql\bin\pg_ctl.exe")) {
    if (-not (Test-Path $PgJar)) { throw "Archive PostgreSQL absente : $PgJar" }

    # Un .jar est un zip : on le renomme pour qu'Expand-Archive l'accepte
    $asZip = Join-Path $Tmp 'pg-embedded.zip'
    Copy-Item $PgJar $asZip -Force
    Expand-Archive -Path $asZip -DestinationPath $Tmp -Force

    $txz = Get-ChildItem -Path $Tmp -Filter '*.txz' | Select-Object -First 1
    if (-not $txz) { throw "Archive .txz introuvable dans $Tmp" }

    # bsdtar (livré avec Windows 10+) gere le xz : aucune dependance externe
    & tar.exe -xJf $txz.FullName -C "$Root\pgsql"
    if ($LASTEXITCODE -ne 0) { throw "Extraction tar echouee (code $LASTEXITCODE)" }
    Remove-Item $asZip -Force -ErrorAction SilentlyContinue
    Write-Host "  -> $Root\pgsql" -ForegroundColor Green
} else {
    Write-Host '  deja extrait' -ForegroundColor DarkGray
}

Write-Host '=== 3/5 Extraction de Redis ===' -ForegroundColor Cyan
if (-not (Test-Path "$Root\redis\redis-server.exe")) {
    if (-not (Test-Path $RedisZip)) { throw "Archive Redis absente : $RedisZip" }
    Expand-Archive -Path $RedisZip -DestinationPath "$Root\redis" -Force
    Write-Host "  -> $Root\redis" -ForegroundColor Green
} else {
    Write-Host '  deja extrait' -ForegroundColor DarkGray
}

Write-Host '=== 4/5 Initialisation du cluster PostgreSQL ===' -ForegroundColor Cyan
if (-not (Test-Path "$Root\pgdata\PG_VERSION")) {
    $pwFile = Join-Path $Tmp 'pgpw.txt'
    Set-Content -Path $pwFile -Value $PgPassword -Encoding ASCII -NoNewline

    & "$Root\pgsql\bin\initdb.exe" `
        -D "$Root\pgdata" `
        -U $PgUser `
        --pwfile=$pwFile `
        -E UTF8 `
        --locale=C `
        --auth-host=scram-sha-256
    if ($LASTEXITCODE -ne 0) { throw "initdb echoue (code $LASTEXITCODE)" }
    Remove-Item $pwFile -Force -ErrorAction SilentlyContinue
    Write-Host '  cluster initialise' -ForegroundColor Green
} else {
    Write-Host '  cluster deja initialise' -ForegroundColor DarkGray
}

Write-Host '=== 4bis/5 Configuration Redis (requirepass) ===' -ForegroundColor Cyan
$RedisConf = Join-Path $Root 'redis\redis.conf'
$pwdLine = "requirepass $RedisPassword"
$confLines = @(
    '# AfriBot - Redis local (Windows natif, sans Docker/WSL)',
    '# Doit rester aligne sur REDIS_URL du .env :',
    "#   redis://:$RedisPassword@localhost:6379/0",
    'port 6379',
    'bind 127.0.0.1',
    'protected-mode yes',
    '',
    $pwdLine,
    '',
    'dir C:/AfriBot/redis',
    'save ""',
    'appendonly no',
    'maxmemory 128mb',
    'maxmemory-policy allkeys-lru',
    'loglevel notice',
    'logfile C:/AfriBot/logs/redis.log'
)
Set-Content -Path $RedisConf -Value $confLines -Encoding ASCII
Write-Host "  -> $RedisConf" -ForegroundColor Green

Write-Host '=== 5/5 Demarrage + creation de la base ===' -ForegroundColor Cyan
& "$PSScriptRoot\local-stack.ps1" start

# Les binaires PostgreSQL embarques (zonky) ne contiennent PAS psql/createdb :
# on cree la base via Prisma (`db execute` sur la base de maintenance 'postgres'),
# ce qui evite toute dependance client supplementaire.
$MaintenanceUrl = "postgresql://${PgUser}:${PgPassword}@localhost:5432/postgres?schema=public"
$TargetUrl      = "postgresql://${PgUser}:${PgPassword}@localhost:5432/${PgDatabase}?schema=public"
$sqlFile        = Join-Path $Tmp 'create-db.sql'
Set-Content -Path $sqlFile -Value "CREATE DATABASE `"$PgDatabase`";" -Encoding ASCII

Write-Host '  creation de la base si absente...' -ForegroundColor DarkGray
# npx doit tourner depuis la racine du projet pour resoudre le prisma local
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    # Echec silencieux si la base existe deja (42P04 duplicate_database)
    $dbOut = & npx --no-install prisma db execute --url $MaintenanceUrl --file $sqlFile 2>&1 | Out-String
    $dbCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($dbCode -eq 0) {
    Write-Host "  base '$PgDatabase' creee" -ForegroundColor Green
} elseif ($dbOut -match '42P04|already exists') {
    Write-Host "  base '$PgDatabase' deja presente" -ForegroundColor DarkGray
} else {
    Write-Host '  ECHEC de la creation de la base :' -ForegroundColor Red
    Write-Host $dbOut -ForegroundColor DarkGray
}

Write-Host ''
Write-Host 'Termine. Etape suivante :' -ForegroundColor Cyan
Write-Host '  cd c:\BOT-WHATSAPP' -ForegroundColor White
Write-Host '  npx prisma migrate deploy' -ForegroundColor White
Write-Host '  npm run dev' -ForegroundColor White
Write-Host ''
Write-Host 'URL de connexion a mettre dans .env :' -ForegroundColor DarkGray
Write-Host "  DATABASE_URL=$TargetUrl" -ForegroundColor DarkGray