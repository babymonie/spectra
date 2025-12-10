// Simple dependency bootstrap for running Spectra from source
// This runs automatically before `npm start` (via the `prestart` script).

import { existsSync, mkdirSync, createWriteStream, copyFileSync, readdirSync, chmodSync } from 'node:fs';
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
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const arch = process.arch; // 'x64', 'arm64', etc.

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

  if (!isWindows && !isMac && !isLinux) {
    console.warn('[ensure-deps] No FFmpeg found and auto-download is not supported on this platform.');
    console.warn('              Please install FFmpeg manually or add it to your PATH.');
    return;
  }

  // Prepare download directory
  mkdirSync(localBinDir, { recursive: true });

  const downloadDir = path.join(rootDir, '.spectra-tools');
  mkdirSync(downloadDir, { recursive: true });
  const unzipDir = path.join(downloadDir, 'ffmpeg-unpacked');

  // Determine download URL based on platform/arch or env override
  let ffmpegUrl = process.env.SPECTRA_FFMPEG_URL || '';
  if (!ffmpegUrl) {
    if (isWindows) {
      ffmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
    } else if (isLinux) {
      if (arch === 'x64') ffmpegUrl = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
      else if (arch === 'arm64') ffmpegUrl = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz';
      else ffmpegUrl = '';
    } else if (isMac) {
      // evermeet provides macOS builds; versioned names may change so allow override
      ffmpegUrl = 'https://evermeet.cx/ffmpeg/ffmpeg-6.0.zip';
    }
  }

  if (!ffmpegUrl) {
    console.warn('[ensure-deps] No default FFmpeg URL available for this platform/arch.');
    console.warn('              Set SPECTRA_FFMPEG_URL to a static FFmpeg archive (zip or tar.xz) to enable auto-download.');
    return;
  }

  const archiveName = path.basename(new URL(ffmpegUrl).pathname);
  const archivePath = path.join(downloadDir, archiveName);

  console.log('[ensure-deps] Downloading FFmpeg from:', ffmpegUrl);
  const res = await fetch(ffmpegUrl);
  if (!res.ok || !res.body) {
    console.error('[ensure-deps] Failed to download FFmpeg archive:', res.status, res.statusText);
    return;
  }

  await new Promise((resolve, reject) => {
    const fileStream = createWriteStream(archivePath);
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  console.log('[ensure-deps] Downloaded FFmpeg archive to', archivePath);

  // Extract depending on archive type
  mkdirSync(unzipDir, { recursive: true });
  let extractOk = false;
  if (archivePath.endsWith('.zip')) {
    console.log('[ensure-deps] Extracting ZIP...');
    const unzip = spawnSync(process.platform === 'win32' ? 'powershell' : 'unzip',
      process.platform === 'win32'
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -Force -Path "${archivePath}" -DestinationPath "${unzipDir}"`]
        : [archivePath, '-d', unzipDir],
      { cwd: rootDir, stdio: 'inherit', shell: process.platform === 'win32' }
    );
    extractOk = unzip.status === 0;
  } else if (archivePath.endsWith('.tar.xz') || archivePath.endsWith('.txz')) {
    console.log('[ensure-deps] Extracting tar.xz...');
    const tar = spawnSync('tar', ['-xJf', archivePath, '-C', unzipDir], { cwd: rootDir, stdio: 'inherit' });
    extractOk = tar.status === 0;
  } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    console.log('[ensure-deps] Extracting tar.gz...');
    const tar = spawnSync('tar', ['-xzf', archivePath, '-C', unzipDir], { cwd: rootDir, stdio: 'inherit' });
    extractOk = tar.status === 0;
  } else {
    console.warn('[ensure-deps] Unknown archive type for', archivePath);
  }

  if (!extractOk) {
    console.error('[ensure-deps] Failed to extract FFmpeg archive.');
    return;
  }

  // Recursively search for ffmpeg executable in unpacked folder.
  function findFfmpegExec(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && (ent.name === 'ffmpeg' || ent.name.toLowerCase() === 'ffmpeg.exe')) return full;
      if (ent.isDirectory()) {
        const found = findFfmpegExec(full);
        if (found) return found;
      }
    }
    return null;
  }

  const foundFfmpeg = findFfmpegExec(unzipDir);
  if (!foundFfmpeg) {
    console.error('[ensure-deps] Extracted FFmpeg archive but could not locate ffmpeg binary');
    return;
  }

  // Ensure executable bit and copy into local bin
  try {
    chmodSync(foundFfmpeg, 0o755);
  } catch (_) {}
  copyFileSync(foundFfmpeg, localFfmpegPath);
  try { chmodSync(localFfmpegPath, 0o755); } catch (_) {}
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
