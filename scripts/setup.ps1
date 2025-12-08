# Spectra Development Environment Setup Script
# This script checks and installs required build tools

Write-Host "=== Spectra Development Environment Setup ===" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
Write-Host "Checking Node.js..." -ForegroundColor Yellow
$nodeVersion = node --version 2>$null
if ($nodeVersion) {
    Write-Host "✓ Node.js installed: $nodeVersion" -ForegroundColor Green
} else {
    Write-Host "✗ Node.js not found. Please install from https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# Check npm
Write-Host "Checking npm..." -ForegroundColor Yellow
$npmVersion = npm --version 2>$null
if ($npmVersion) {
    Write-Host "✓ npm installed: v$npmVersion" -ForegroundColor Green
} else {
    Write-Host "✗ npm not found" -ForegroundColor Red
    exit 1
}

# Check Python
Write-Host "Checking Python..." -ForegroundColor Yellow
$pythonVersion = python --version 2>$null
if ($pythonVersion) {
    Write-Host "✓ Python installed: $pythonVersion" -ForegroundColor Green
} else {
    Write-Host "⚠ Python not found. Required for building native modules." -ForegroundColor Yellow
    Write-Host "  Download from: https://www.python.org/downloads/" -ForegroundColor Yellow
}

# Check Visual Studio Build Tools
Write-Host "Checking Visual Studio Build Tools..." -ForegroundColor Yellow
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($vsPath) {
        Write-Host "✓ Visual Studio Build Tools installed" -ForegroundColor Green
    } else {
        Write-Host "⚠ Visual Studio Build Tools not found" -ForegroundColor Yellow
        Write-Host "  Install from: https://visualstudio.microsoft.com/downloads/" -ForegroundColor Yellow
        Write-Host "  Select 'Desktop development with C++' workload" -ForegroundColor Yellow
    }
} else {
    Write-Host "⚠ Visual Studio Build Tools not found" -ForegroundColor Yellow
    Write-Host "  Install from: https://visualstudio.microsoft.com/downloads/" -ForegroundColor Yellow
    Write-Host "  Or run: npm install --global windows-build-tools" -ForegroundColor Yellow
}

# Install npm dependencies
Write-Host ""
Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
npm install

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Dependencies installed successfully" -ForegroundColor Green
} else {
    Write-Host "✗ Failed to install dependencies" -ForegroundColor Red
    exit 1
}

# Build native addon
Write-Host ""
Write-Host "Building native audio addon..." -ForegroundColor Cyan
npm run build

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Native addon built successfully" -ForegroundColor Green
} else {
    Write-Host "✗ Failed to build native addon" -ForegroundColor Red
    Write-Host "  Make sure Visual Studio Build Tools are installed" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  npm start           - Run in development mode" -ForegroundColor White
Write-Host "  npm run package     - Build executable" -ForegroundColor White
Write-Host ""
