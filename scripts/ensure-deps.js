// Simple dependency bootstrap for running Spectra from source
// This runs automatically before `npm start` (via the `prestart` script).

import { existsSync, mkdirSync, createWriteStream, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureNodeModules() {
  const nodeModulesPath = path.join(rootDir, 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    console.log('[ensure-deps] `node_modules` missing – running `npm install`...');
    run('npm', ['install']);
  } else {
    console.log('[ensure-deps] `node_modules` directory found.');
  }
}

function ensureNativeAddon() {
  const candidates = [
    path.join(rootDir, 'build', 'Release', 'exclusive_audio.node'),
    path.join(rootDir, 'build', 'Debug', 'exclusive_audio.node'),
  ];
  const hasAddon = candidates.some((p) => existsSync(p));
  if (!hasAddon) {
    console.log('[ensure-deps] Native addon not found – running `npm run build:electron`...');
    run('npm', ['run', 'build:electron']);
  } else {
    console.log('[ensure-deps] Native addon already built.');
  }
}

async function ensureFfmpeg() {
  const isWindows = process.platform === 'win32';

  // If a local ffmpeg binary already exists under ./bin, we're done.
  const ffmpegName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
  const localBinDir = path.join(rootDir, 'bin');
  const localFfmpegPath = path.join(localBinDir, ffmpegName);
  if (existsSync(localFfmpegPath)) {
    console.log('[ensure-deps] Local FFmpeg found at', localFfmpegPath);
    return;
  }

  // If system ffmpeg is available on PATH, use that and don't download.
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', cwd: rootDir, shell: isWindows });
  if (probe.status === 0) {
    console.log('[ensure-deps] System FFmpeg found on PATH; no download needed.');
    return;
  }

  if (!isWindows) {
    console.warn('[ensure-deps] No FFmpeg found and auto-download is only configured for Windows.');
    console.warn('              Please install FFmpeg manually or add it to your PATH.');
    return;
  }

  // Windows: download official static build ZIP if nothing is available.
  mkdirSync(localBinDir, { recursive: true });

  const downloadDir = path.join(rootDir, '.spectra-tools');
  mkdirSync(downloadDir, { recursive: true });
  const zipPath = path.join(downloadDir, 'ffmpeg-win.zip');
  const unzipDir = path.join(downloadDir, 'ffmpeg-unpacked');

  const ffmpegUrl = process.env.SPECTRA_FFMPEG_ZIP_URL
    || 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

  console.log('[ensure-deps] No FFmpeg found; downloading ZIP from:', ffmpegUrl);

  const res = await fetch(ffmpegUrl);
  if (!res.ok || !res.body) {
    console.error('[ensure-deps] Failed to download FFmpeg ZIP:', res.status, res.statusText);
    return;
  }

  await new Promise((resolve, reject) => {
    const fileStream = createWriteStream(zipPath);
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  console.log('[ensure-deps] Downloaded FFmpeg ZIP to', zipPath);

  // Use PowerShell Expand-Archive to unzip (available on modern Windows).
  console.log('[ensure-deps] Extracting FFmpeg ZIP...');
  const expand = spawnSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `Remove-Item -Recurse -Force "${unzipDir}" -ErrorAction SilentlyContinue; ` +
    `New-Item -ItemType Directory -Force -Path "${unzipDir}" | Out-Null; ` +
    `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${unzipDir}"`
  ], {
    cwd: rootDir,
    stdio: 'inherit'
  });

  if (expand.status !== 0) {
    console.error('[ensure-deps] Failed to extract FFmpeg ZIP.');
    return;
  }

  // Recursively search for ffmpeg.exe inside the unpacked folder.
  function findFfmpegExe(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name.toLowerCase() === 'ffmpeg.exe') return full;
      if (ent.isDirectory()) {
        const found = findFfmpegExe(full);
        if (found) return found;
      }
    }
    return null;
  }

  const foundFfmpeg = findFfmpegExe(unzipDir);
  if (!foundFfmpeg) {
    console.error('[ensure-deps] Extracted FFmpeg ZIP but could not locate ffmpeg.exe');
    return;
  }

  copyFileSync(foundFfmpeg, localFfmpegPath);
  console.log('[ensure-deps] Installed local FFmpeg to', localFfmpegPath);
}

// Only run in development / non-packaged usage.
if (process.env.SPECTRA_SKIP_ENSURE_DEPS === '1') {
  console.log('[ensure-deps] Skipping dependency check due to SPECTRA_SKIP_ENSURE_DEPS=1');
  process.exit(0);
}

// Run main bootstrap so we can await downloads.
const runAll = async () => {
  ensureNodeModules();
  ensureNativeAddon();
  await ensureFfmpeg();

  console.log('[ensure-deps] Dependencies are ready.');
};

runAll().catch((error) => {
  console.error('[ensure-deps] Fatal error during dependency setup:', error?.message ?? error);
  process.exit(1);
});
