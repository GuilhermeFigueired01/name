Write-Host ""
Write-Host "  Phishing Sim - Modo de Desenvolvimento" -ForegroundColor Cyan
Write-Host "  ----------------------------------------" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  ERRO: Node.js nao encontrado." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "  A instalar dependencias..." -ForegroundColor Yellow
    npm install
}

$proc = Get-NetTCPConnection -LocalPort 3333 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) {
    Stop-Process -Id $proc -Force -ErrorAction SilentlyContinue
    Write-Host "  Processo anterior na porta 3333 terminado." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  A arrancar servidor em modo dev (.env.dev)..." -ForegroundColor Green
Write-Host "  Local:   http://localhost:443/v2/login" -ForegroundColor White
Write-Host "  Rede:    http://10.100.10.156:443/v2/login" -ForegroundColor White
Write-Host "  Admin:   http://localhost:443/admin?key=aintar-admin-2024" -ForegroundColor White
Write-Host ""

node server.js dev
