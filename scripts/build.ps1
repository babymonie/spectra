param(
    [string]$mode = "auto"  # 'auto'|'electron'|'node'
)

# Move to repo root (script lives in ./scripts)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')
Push-Location -Path $repoRoot | Out-Null

Write-Host "[build] Starting native addon build (mode=$mode)"

# Ensure npm deps are installed (node-addon-api etc.)
Write-Host "[build] Running npm install..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed (exit $LASTEXITCODE)"
    Pop-Location
    exit $LASTEXITCODE
}

$hasElectron = Select-String -Path package.json -Pattern '"electron"' -Quiet

if ($mode -eq 'electron' -or ($mode -eq 'auto' -and $hasElectron)) {
    Write-Host "[build] Detected Electron; running electron-rebuild for addon 'exclusive_audio'"
    npx electron-rebuild -f -w exclusive_audio
    if ($LASTEXITCODE -ne 0) {
        Write-Error "electron-rebuild failed (exit $LASTEXITCODE)"
        Pop-Location
        exit $LASTEXITCODE
    }
    Write-Host "[build] electron-rebuild completed successfully"
} else {
    Write-Host "[build] node-gyp rebuild completed during npm install"
}

Pop-Location
Write-Host "[build] Done"
exit 0
