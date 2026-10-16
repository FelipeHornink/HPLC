<#
.SYNOPSIS
  Prepares a fresh Windows machine to run HPLC projects with the HPLC
  simulator, without WSL2.

.DESCRIPTION
  This script:
   1) Installs Git for Windows (if "git" is not on the PATH).
   2) Installs MSYS2 (the only local toolchain with real POSIX socket
      headers in this no-WSL2 scenario -- needed because runtime/main.cpp
      uses arpa/inet.h, sys/socket.h, pthread.h).
   3) Installs gcc/g++ and python inside MSYS2 via pacman.
   4) Creates wrappers ~/.local/bin/g++ and ~/.local/bin/gcc that route to
      the MSYS2 g++/gcc (calling the msys64 binary directly from another
      MSYS/Git-Bash runtime breaks DLL loading -- the wrapper avoids that by
      running inside msys64's own bash.exe).
   5) Makes sure %USERPROFILE%\.local\bin is on the user PATH.
   6) Copies the STruC++ compiler (strucpp/ folder of this package) to
      %USERPROFILE%\.local\strucpp.

  After running this script, CLOSE AND REOPEN the terminal/VS Code (the new
  PATH only applies to processes started after the change).

.NOTES
  Run it in a regular PowerShell (administrator is not needed in most
  cases -- winget installs into the current user profile).
#>

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    WARNING: $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1) Git --
Write-Step "Checking Git for Windows"
$gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Warn2 "Git not found. Installing via winget..."
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
    $gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $gitCmd) { throw "Git was not found after installation. Install it manually (https://git-scm.com/download/win) and run this script again." }
} else {
    Write-Ok "Git already installed: $($gitCmd.Source)"
}
$gitBashPath = Join-Path (Split-Path (Split-Path $gitCmd.Source)) 'bin\bash.exe'
if (-not (Test-Path $gitBashPath)) { throw "Git's bash.exe was not found at '$gitBashPath'." }
Write-Ok "Git Bash at: $gitBashPath"

# --------------------------------------------------------------- 2) MSYS2 --
Write-Step "Checking MSYS2 (toolchain with POSIX socket headers)"
if (-not (Test-Path 'C:\msys64\usr\bin\bash.exe')) {
    Write-Warn2 "MSYS2 not found at C:\msys64. Installing via winget..."
    winget install --id MSYS2.MSYS2 -e --accept-source-agreements --accept-package-agreements
    if (-not (Test-Path 'C:\msys64\usr\bin\bash.exe')) { throw "MSYS2 did not appear at C:\msys64 after installation." }
} else {
    Write-Ok "MSYS2 already present at C:\msys64"
}

# ------------------------------------------------------- 3) gcc/python in MSYS2 --
Write-Step "Installing gcc/g++ and python inside MSYS2 (may take a few minutes)"
& C:\msys64\usr\bin\bash.exe -lc "pacman -Sy --noconfirm" 2>&1 | ForEach-Object { Write-Host "    $_" }
Start-Sleep -Seconds 1
& C:\msys64\usr\bin\bash.exe -lc "rm -f /var/lib/pacman/db.lck; pacman -S --noconfirm --needed gcc python" 2>&1 | ForEach-Object { Write-Host "    $_" }
$gccOk = & C:\msys64\usr\bin\bash.exe -lc "command -v gcc && command -v python" 2>&1
if ($LASTEXITCODE -ne 0 -or -not $gccOk) { throw "gcc/python were not installed correctly inside MSYS2. Run 'C:\msys64\usr\bin\bash.exe' manually and try 'pacman -S gcc python' again." }
Write-Ok "gcc/g++ and python installed in MSYS2"

# ------------------------------------------------- 4) wrappers ~/.local/bin --
Write-Step "Creating wrappers ~/.local/bin/g++ and ~/.local/bin/gcc"
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
echo "wrappers created in: $(cd ~/.local/bin && pwd)"
'@
$wrapperScriptPath = Join-Path $env:TEMP 'hplc-wrapper-setup.sh'
[System.IO.File]::WriteAllText($wrapperScriptPath, $wrapperScript.Replace("`r`n", "`n"))
& $gitBashPath $wrapperScriptPath
Write-Ok "g++/gcc wrappers created (they route to MSYS2, avoiding the DLL loading problem of another runtime)"

# ------------------------------------------------------------- 5) PATH --
Write-Step "Ensuring %USERPROFILE%\.local\bin is on the user PATH"
$localBin = Join-Path $env:USERPROFILE '.local\bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$localBin*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $localBin } else { "$userPath;$localBin" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Ok "Added to the user PATH: $localBin (reopen the terminal/VS Code for it to apply)"
} else {
    Write-Ok "$localBin was already on the user PATH"
}

# --------------------------------------------------------- 6) strucpp --
Write-Step "Copying the STruC++ compiler"
$strucppSrc = Join-Path $scriptDir 'strucpp'
$strucppDst = Join-Path $env:USERPROFILE '.local\strucpp'
if (-not (Test-Path $strucppSrc)) { throw "Folder 'strucpp' not found next to this script ($strucppSrc). Run it from the extracted folder of the full package." }
New-Item -ItemType Directory -Force -Path (Split-Path $strucppDst) | Out-Null
Copy-Item -Path $strucppSrc -Destination $strucppDst -Recurse -Force
Write-Ok "strucpp copied to $strucppDst"

Write-Host "`n=========================================================" -ForegroundColor Green
Write-Host " Setup complete!" -ForegroundColor Green
Write-Host " Next steps:" -ForegroundColor Green
Write-Host "  1. CLOSE AND REOPEN the terminal/VS Code (so the new PATH applies)."
Write-Host "  2. In VS Code: Extensions > ... > Install from VSIX... > choose hplc-<version>.vsix"
Write-Host "  3. Open your HPLC project folder in VS Code (or create one with 'HPLC: New PLC Project')."
Write-Host "  4. Run 'HPLC: Build' or click Play on the project."
Write-Host "=========================================================" -ForegroundColor Green
