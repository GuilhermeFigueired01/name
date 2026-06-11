# ============================================================
#  Phishing Sim — Script de instalação para Windows Server
#  Corre como Administrador: Right-click > "Run as Administrator"
# ============================================================

$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AINTAR — Phishing Sim Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Verificar Node.js ─────────────────────────────────────
Write-Host "[1/5] A verificar Node.js..." -ForegroundColor Yellow
try {
    $nodeVer = node --version
    Write-Host "      Node.js encontrado: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "      Node.js NAO encontrado." -ForegroundColor Red
    Write-Host "      Instala em: https://nodejs.org  (versao LTS recomendada)" -ForegroundColor Red
    Write-Host "      Depois volta a correr este script." -ForegroundColor Red
    Read-Host "Pressiona Enter para sair"
    exit 1
}

# ── 2. Instalar dependências da aplicação ────────────────────
Write-Host "[2/5] A instalar dependencias (npm install)..." -ForegroundColor Yellow
Set-Location $AppDir
npm install --omit=dev
Write-Host "      OK" -ForegroundColor Green

# ── 3. Instalar PM2 globalmente ──────────────────────────────
Write-Host "[3/5] A instalar PM2..." -ForegroundColor Yellow
npm install -g pm2
npm install -g pm2-windows-startup
Write-Host "      OK" -ForegroundColor Green

# ── 4. Criar pasta de logs ───────────────────────────────────
Write-Host "[4/5] A criar pastas logs/ e data/..." -ForegroundColor Yellow
$null = New-Item -ItemType Directory -Force "$AppDir\logs"
$null = New-Item -ItemType Directory -Force "$AppDir\data"
Write-Host "      OK" -ForegroundColor Green

# ── 5. Arrancar com PM2 e configurar arranque automático ─────
Write-Host "[5/5] A arrancar o servidor com PM2..." -ForegroundColor Yellow
pm2 start "$AppDir\ecosystem.config.js"
pm2 save
pm2-startup install
Write-Host "      OK" -ForegroundColor Green

# ── Resumo ───────────────────────────────────────────────────
$env_file = Join-Path $AppDir ".env"
$port = 3333
if (Test-Path $env_file) {
    $portLine = Select-String -Path $env_file -Pattern '^PORT=(\d+)' | Select-Object -First 1
    if ($portLine) { $port = $portLine.Matches.Groups[1].Value }
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.InterfaceAlias -notmatch 'Loopback' } |
       Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Servidor a correr!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  URL local:    http://localhost:$port" -ForegroundColor White
Write-Host "  URL rede:     http://$ip`:$port" -ForegroundColor White
Write-Host ""
Write-Host "  Painel admin: http://$ip`:$port/admin?key=aintar-admin-2024" -ForegroundColor Cyan
Write-Host ""
Write-Host "  IMPORTANTE: Muda o ADMIN_KEY no ficheiro .env!" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Comandos uteis:" -ForegroundColor White
Write-Host "    pm2 status          -- ver estado" -ForegroundColor Gray
Write-Host "    pm2 logs            -- ver logs em tempo real" -ForegroundColor Gray
Write-Host "    pm2 restart phishing-sim  -- reiniciar" -ForegroundColor Gray
Write-Host "    pm2 stop phishing-sim     -- parar" -ForegroundColor Gray
Write-Host ""
Read-Host "Pressiona Enter para fechar"
