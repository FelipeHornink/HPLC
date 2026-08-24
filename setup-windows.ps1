<#
.SYNOPSIS
  Prepara uma maquina Windows nova para rodar o ProjetoBase (compressor
  padrao HBR) com o simulador do PLC Codex, replicando o ambiente montado
  na maquina original (sem WSL2).

.DESCRIPTION
  Este script:
   1) Instala o Git for Windows (se nao houver "git" no PATH).
   2) Instala o MSYS2 (unico toolchain local com headers POSIX de socket
      reais neste cenario sem WSL2 -- necessario porque runtime/main.cpp
      usa arpa/inet.h, sys/socket.h, pthread.h).
   3) Instala gcc/g++ e python dentro do MSYS2 via pacman.
   4) Cria wrappers ~/.local/bin/g++ e ~/.local/bin/gcc que roteiam para o
      g++/gcc do MSYS2 (invocar o binario msys64 direto de outro runtime
      MSYS/Git-Bash quebra o carregamento de DLL -- o wrapper evita isso
      rodando por dentro do proprio bash.exe do msys64).
   5) Garante que %USERPROFILE%\.local\bin esteja no PATH do usuario.
   6) Copia o compilador STruC++ (pasta strucpp/ deste pacote) para
      %USERPROFILE%\.local\strucpp.

  Depois de rodar este script, FECHE E REABRA o terminal/VS Code (o PATH
  novo so vale para processos iniciados depois da mudanca).

.NOTES
  Rode num PowerShell comum (nao precisa ser administrador na maioria dos
  casos -- o winget instala no perfil do usuario atual).
#>

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    AVISO: $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1) Git --
Write-Step "Verificando Git for Windows"
$gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Warn2 "Git nao encontrado. Instalando via winget..."
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
    $gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $gitCmd) { throw "Git nao foi encontrado apos a instalacao. Instale manualmente (https://git-scm.com/download/win) e rode este script de novo." }
} else {
    Write-Ok "Git ja instalado: $($gitCmd.Source)"
}
$gitBashPath = Join-Path (Split-Path (Split-Path $gitCmd.Source)) 'bin\bash.exe'
if (-not (Test-Path $gitBashPath)) { throw "Nao encontrei bash.exe do Git em '$gitBashPath'." }
Write-Ok "Git Bash em: $gitBashPath"

# --------------------------------------------------------------- 2) MSYS2 --
Write-Step "Verificando MSYS2 (toolchain com headers POSIX de socket)"
if (-not (Test-Path 'C:\msys64\usr\bin\bash.exe')) {
    Write-Warn2 "MSYS2 nao encontrado em C:\msys64. Instalando via winget..."
    winget install --id MSYS2.MSYS2 -e --accept-source-agreements --accept-package-agreements
    if (-not (Test-Path 'C:\msys64\usr\bin\bash.exe')) { throw "MSYS2 nao apareceu em C:\msys64 apos a instalacao." }
} else {
    Write-Ok "MSYS2 ja presente em C:\msys64"
}

# ------------------------------------------------------- 3) gcc/python no MSYS2 --
Write-Step "Instalando gcc/g++ e python dentro do MSYS2 (pode levar alguns minutos)"
& C:\msys64\usr\bin\bash.exe -lc "pacman -Sy --noconfirm" 2>&1 | ForEach-Object { Write-Host "    $_" }
Start-Sleep -Seconds 1
& C:\msys64\usr\bin\bash.exe -lc "rm -f /var/lib/pacman/db.lck; pacman -S --noconfirm --needed gcc python" 2>&1 | ForEach-Object { Write-Host "    $_" }
$gccOk = & C:\msys64\usr\bin\bash.exe -lc "command -v gcc && command -v python" 2>&1
if ($LASTEXITCODE -ne 0 -or -not $gccOk) { throw "gcc/python nao instalaram corretamente dentro do MSYS2. Rode 'C:\msys64\usr\bin\bash.exe' manualmente e tente 'pacman -S gcc python' de novo." }
Write-Ok "gcc/g++ e python instalados no MSYS2"

# ------------------------------------------------- 4) wrappers ~/.local/bin --
Write-Step "Criando wrappers ~/.local/bin/g++ e ~/.local/bin/gcc"
$wrapperScript = @'
MINGW_BIN="/c/msys64/usr/bin"
mkdir -p ~/.local/bin
cat > ~/.local/bin/g++ <<EOF
#!/usr/bin/env bash
exec "$MINGW_BIN/g++.exe" "\$@"
EOF
cat > ~/.local/bin/gcc <<EOF
#!/usr/bin/env bash
exec "$MINGW_BIN/gcc.exe" "\$@"
EOF
chmod +x ~/.local/bin/g++ ~/.local/bin/gcc
echo "wrappers criados em: $(cd ~/.local/bin && pwd)"
'@
$wrapperScriptPath = Join-Path $env:TEMP 'plc-codex-wrapper-setup.sh'
[System.IO.File]::WriteAllText($wrapperScriptPath, $wrapperScript.Replace("`r`n", "`n"))
& $gitBashPath $wrapperScriptPath
Write-Ok "wrappers de g++/gcc criados (routeiam para o MSYS2, evitando o problema de carregar DLL de outro runtime)"

# ------------------------------------------------------------- 5) PATH --
Write-Step "Garantindo %USERPROFILE%\.local\bin no PATH do usuario"
$localBin = Join-Path $env:USERPROFILE '.local\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$localBin*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $localBin } else { "$userPath;$localBin" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Ok "Adicionado ao PATH do usuario: $localBin (reabra o terminal/VS Code para valer)"
} else {
    Write-Ok "$localBin ja estava no PATH do usuario"
}

# --------------------------------------------------------- 6) strucpp --
Write-Step "Copiando compilador STruC++"
$strucppSrc = Join-Path $scriptDir 'strucpp'
$strucppDst = Join-Path $env:USERPROFILE '.local\strucpp'
if (-not (Test-Path $strucppSrc)) { throw "Pasta 'strucpp' nao encontrada junto deste script ($strucppSrc). Rode a partir da pasta extraida do pacote completo." }
New-Item -ItemType Directory -Force -Path (Split-Path $strucppDst) | Out-Null
Copy-Item -Path $strucppSrc -Destination $strucppDst -Recurse -Force
Write-Ok "strucpp copiado para $strucppDst"

Write-Host "`n=========================================================" -ForegroundColor Green
Write-Host " Setup concluido!" -ForegroundColor Green
Write-Host " Proximos passos:" -ForegroundColor Green
Write-Host "  1. FECHE E REABRA o terminal/VS Code (para o PATH novo valer)."
Write-Host "  2. No VS Code: Extensions > ... > Install from VSIX... > escolha plc-codex-0.25.0.vsix"
Write-Host "  3. Extraia ProjetoBase.zip numa pasta e abra ela no VS Code."
Write-Host "  4. Rode 'PLC Codex: Build' ou clique Play no projeto."
Write-Host "=========================================================" -ForegroundColor Green
