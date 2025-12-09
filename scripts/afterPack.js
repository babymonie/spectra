// afterPack.js - Ensures native addons are properly included after packaging

import fs from 'fs';
import path from 'path';

export default async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName;
  
  console.log('[afterPack] Platform:', platform);
  console.log('[afterPack] App output dir:', appOutDir);
  
  // Determine paths based on platform
  let resourcesPath, buildPath, binPath;
  
  if (platform === 'win32') {
    resourcesPath = path.join(appOutDir, 'resources');
  } else if (platform === 'darwin') {
    resourcesPath = path.join(appOutDir, 'Spectra.app', 'Contents', 'Resources');
  } else if (platform === 'linux') {
    resourcesPath = path.join(appOutDir, 'resources');
  }
  
  const appPath = path.join(resourcesPath, 'app.asar.unpacked');
  buildPath = path.join(appPath, 'build');
  binPath = path.join(appPath, 'bin');
  
  console.log('[afterPack] Checking native addon...');
  
  // Check if build directory exists (contains native addon)
  if (fs.existsSync(buildPath)) {
    console.log('[afterPack] ✓ Native addon found in build/');
    
    // List contents
    const buildContents = fs.readdirSync(buildPath);
    console.log('[afterPack] Build directory contents:', buildContents);
  } else {
    console.warn('[afterPack] ⚠ Build directory not found, trying to copy...');
    
    // Try to copy from project build directory
    const projectBuildPath = path.join(context.projectDir, 'build');
    if (fs.existsSync(projectBuildPath)) {
      fs.mkdirSync(buildPath, { recursive: true });
      copyRecursive(projectBuildPath, buildPath);
      console.log('[afterPack] ✓ Copied native addon from project build/');
    }
  }
  
  // Check if bin directory exists (prebuilt addons)
  if (fs.existsSync(binPath)) {
    console.log('[afterPack] ✓ Prebuilt addon found in bin/');
  } else {
    console.warn('[afterPack] ⚠ Bin directory not found');
  }
  
  console.log('[afterPack] Complete');
};

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        copyRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}
