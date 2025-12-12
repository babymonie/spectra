// audioEngine.js (ESM, no Speaker/portaudio)
// Native PCM pipeline: FFmpeg -> exclusive_audio addon (WASAPI/CoreAudio)

import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'stream';
import ffmpegPath from 'ffmpeg-static';
import { parseFile } from 'music-metadata';
import { existsSync } from 'node:fs';
import path from 'node:path';

let exclusiveAudio = null;
let exclusiveLoadError = null;

// Normalize ffmpeg binary path for packaged apps (asar/app.asar.unpacked)
const resolvedFfmpegPath = (() => {
  try {
    if (!ffmpegPath) {
      console.error('[audioEngine] ffmpeg-static did not provide a binary path');
      // Try to fall back to system ffmpeg
      const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      if (probe.status === 0) {
        console.log('[audioEngine] Falling back to system FFmpeg from PATH');
        return 'ffmpeg';
      }
      return null;
    }
    let p = ffmpegPath;
    // If running from app.asar, use the unpacked path instead
    if (p.includes('app.asar')) {
      p = p.replace('app.asar', 'app.asar.unpacked');
    }

    // If the bundled/static path exists, use it
    if (existsSync(p)) {
      console.log('[audioEngine] Using bundled FFmpeg binary at:', p);
      return p;
    }

    // Check for a locally installed FFmpeg from ensure-deps at ./bin/ffmpeg(.exe)
    const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const baseDir = process.resourcesPath || process.cwd();
    const localBinPath = path.join(baseDir, 'bin', ffmpegName);
    if (existsSync(localBinPath)) {
      console.log('[audioEngine] Using local FFmpeg binary at:', localBinPath);
      return localBinPath;
    }

    console.warn('[audioEngine] Bundled FFmpeg not found at expected path, probing system FFmpeg...');
    const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    if (probe.status === 0) {
      console.log('[audioEngine] Using system FFmpeg from PATH');
      return 'ffmpeg';
    }

    console.error('[audioEngine] No FFmpeg binary found (bundled or system).');
    return null;
  } catch (e) {
    console.error('[audioEngine] Failed to resolve FFmpeg path:', e?.message ?? e);
    return ffmpegPath || null;
  }
})();

// Load the JS wrapper around your native addon
try {
  const mod = await import('./exclusiveAudio.js');
  exclusiveAudio = mod.default || mod;
} catch (e) {
  exclusiveLoadError = e?.message ?? String(e);
  console.warn('[audioEngine] failed to load exclusiveAudio addon:', exclusiveLoadError);
}

// Current playback state (one stream at a time)
let ffmpegProc = null;
let outputStream = null;
let currentFile = null;
let isPaused = false;
let currentGainStream = null;
let lastOnEnd = null;
let lastOnError = null;
let lastOptions = {};
let currentStartTime = 0;

// EQ State
let eqState = {
  enabled: false,
  preset: 'flat',
  bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] // 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k
};

function setEQ(state) {
  console.log('[audioEngine] setEQ:', state);
  const wasEnabled = eqState.enabled;
  const oldBands = [...eqState.bands];
  
  if (state.enabled !== undefined) eqState.enabled = state.enabled;
  if (state.preset !== undefined) eqState.preset = state.preset;
  if (state.bands && Array.isArray(state.bands)) eqState.bands = [...state.bands];

  // If playback is active and EQ changed, we need to restart to apply FFmpeg filters
  // Only restart if enabled changed OR (enabled is true AND bands changed)
  const bandsChanged = JSON.stringify(oldBands) !== JSON.stringify(eqState.bands);
  const shouldRestart = (wasEnabled !== eqState.enabled) || (eqState.enabled && bandsChanged);

  if (ffmpegProc && shouldRestart) {
    console.log('[audioEngine] EQ changed, restarting playback...');
    const time = getTime();
    playFile(currentFile, lastOnEnd, lastOnError, { ...lastOptions, startTime: time });
  }
}

function getEQ() {
  return { ...eqState };
}

// Update runtime volume for the active gain stream (0-100)
function setVolume(v) {
  const pct = Math.min(100, Math.max(0, Number.isFinite(v) ? Number(v) : 100));
  if (currentGainStream) {
    currentGainStream.gain = pct / 100.0;
    _updateLastOptionsVolume(pct);
    return true;
  }
  // Even if no active gain stream, remember the volume for next playback
  _updateLastOptionsVolume(pct);
  return false;
}

// Ensure lastOptions.volume tracks runtime changes so subsequent operations
// (seek which restarts playback) reuse the current volume instead of falling
// back to default (100%).
function _updateLastOptionsVolume(v) {
  try {
    const pct = Math.min(100, Math.max(0, Number.isFinite(v) ? Number(v) : 100));
    lastOptions = { ...(lastOptions || {}), volume: pct };
  } catch {
    // ignore
  }
}

/**
 * Try to open an exclusive/shared stream using your native addon.
 * We try the requested mode first, then the opposite mode as a fallback.
 * If both fail, we throw – main.js will then fall back to the renderer <audio>.
 */
function createExclusiveStream({ sampleRate, channels, bitDepth, deviceId, mode, bufferMs, bitPerfect, strictBitPerfect }) {
  if (!exclusiveAudio || typeof exclusiveAudio.createExclusiveStream !== 'function') {
    throw new Error('exclusiveAudio addon not available');
  }

  const baseOpts = {
    sampleRate,
    channels,
    bitDepth,
    deviceId: deviceId || null,
    bufferMs: bufferMs || 250,
    bitPerfect: bitPerfect || false,
    strictBitPerfect: strictBitPerfect || false,
  };

  const firstMode = mode === 'shared' ? 'shared' : 'exclusive';
  const secondMode = firstMode === 'exclusive' ? 'shared' : 'exclusive';

  const tryMode = (m) => {
    console.log(`[audioEngine] opening ${m} WASAPI/CoreAudio stream`);
    try {
      const st = new Error().stack;
      console.log('[audioEngine] createExclusiveStream callstack:\n', st);
    } catch {}
    return exclusiveAudio.createExclusiveStream({ ...baseOpts, mode: m });
  };

  let lastErr;

  try {
    return tryMode(firstMode);
  } catch (e1) {
    lastErr = e1;
    console.warn(
      `[audioEngine] ${firstMode} mode failed:`,
      e1?.message ?? e1
    );
    try {
      // If the addon exposes device enumeration, log available ids to help debug invalid deviceId
      if (exclusiveAudio && typeof exclusiveAudio.getDevices === 'function') {
        const devs = exclusiveAudio.getDevices();
        console.log('[audioEngine] native devices:', Array.isArray(devs) ? devs.map(d => d.id || d.name) : devs);
      }
    } catch (ee) {}
  }

  try {
    return tryMode(secondMode);
  } catch (e2) {
    console.warn(
      `[audioEngine] ${secondMode} mode also failed:`,
      e2?.message ?? e2
    );
    lastErr = e2;
  }

  // Propagate to caller – main.js will fall back to renderer.
  const err = new Error(
    'Failed to open native audio output: ' + (lastErr?.message ?? String(lastErr))
  );
  throw err;
}

/**
 * Start playback using native engine.
 * If anything fails, we throw so main.js can fall back to renderer.
 */
async function playFile(filePath, onEnd, onError, options = {}) {
  // Clean up any previous playback
  stop();
  try {
    console.log('[audioEngine] playFile called for', filePath, 'options=', { ...(options || {}) });
    const st = new Error('playFile-stack').stack;
    console.log('[audioEngine] playFile callstack:\n', st);
  } catch {}
  currentStartTime = options.startTime || 0;

  currentFile = filePath;
  lastOnEnd = onEnd;
  lastOnError = onError;
  lastOptions = options;
  isPaused = false;

  // Probe basic audio parameters
  let meta;
  try {
    meta = await parseFile(filePath);
  } catch {
    meta = {};
  }
  const fmt = meta?.format || {};
  // Allow overriding sample rate via options, otherwise use file's rate, or default to 44100
  const sampleRate = options.sampleRate || fmt.sampleRate || 44100;
  const channels = fmt.numberOfChannels || 2;
  const bitDepth = 16; // we ask FFmpeg for s16le

  // Open native output (may throw → handled by main.js)
  outputStream = createExclusiveStream({
    sampleRate,
    channels,
    bitDepth,
    deviceId: options.deviceId,
    mode: options.mode, // 'exclusive' | 'shared' (renderer sends this)
    bufferMs: options.bufferMs || 250,
    bitPerfect: !!options.bitPerfect,
    strictBitPerfect: !!options.strictBitPerfect,
  });

  const actualSampleRate = outputStream.actualSampleRate || sampleRate;
  const actualChannels = outputStream.actualChannels || channels;
  const actualBitDepth = outputStream.actualBitDepth || bitDepth;

  let ffmpegFormat = 's16le';
  let ffmpegCodec = 'pcm_s16le';

  if (actualBitDepth === 32) {
    ffmpegFormat = 'f32le';
    ffmpegCodec = 'pcm_f32le';
  } else if (actualBitDepth === 24) {
    ffmpegFormat = 's24le';
    ffmpegCodec = 'pcm_s24le';
  }

  console.log(`[audioEngine] Spawning FFmpeg with format=${ffmpegFormat}, rate=${actualSampleRate}, ch=${actualChannels}`);

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
  ];

  const isNetworkSource = typeof filePath === 'string' && /^https?:\/\//i.test(filePath);
  if (isNetworkSource) {
    // Robust streaming options: auto-reconnect when HTTP stream drops
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    );
  }

  if (options.startTime) {
    args.push('-ss', String(options.startTime));
  }

  args.push(
    '-i', filePath,
    '-vn'
  );

  // Apply EQ if enabled
  if (eqState.enabled) {
    // Bands: 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k
    const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    let entries = '';
    for (let i = 0; i < freqs.length; i++) {
      const gain = eqState.bands[i] || 0;
      if (i > 0) entries += ';';
      entries += `entry(${freqs[i]},${gain})`;
    }
    // Use firequalizer for high quality EQ
    args.push('-af', `firequalizer=gain_entry='${entries}'`);
  }

  args.push(
    '-f', ffmpegFormat,
    '-acodec', ffmpegCodec,
    '-ac', String(actualChannels),
    '-ar', String(actualSampleRate),
    'pipe:1'
  );

  // Spawn FFmpeg to decode to raw PCM s16le
  if (!resolvedFfmpegPath) {
    const err = new Error('FFmpeg binary path is not available');
    console.error('[audioEngine] Cannot start FFmpeg:', err.message);
    if (onError) onError(err);
    return;
  }

  ffmpegProc = spawn(resolvedFfmpegPath, args);

  if (ffmpegProc.stderr) {
    ffmpegProc.stderr.on('data', (data) => {
      console.error('[audioEngine] FFmpeg stderr:', data.toString());
    });
  }

  ffmpegProc.on('error', (err) => {
    console.error('[audioEngine] FFmpeg error:', err);
    if (onError) onError(err);
    stop();
  });

  ffmpegProc.on('close', (code) => {
    console.log('[audioEngine] FFmpeg exited with code:', code);
    const exitErr =
      code && code !== 0
        ? new Error('FFmpeg exited with code ' + code)
        : null;

    ffmpegProc = null;

    if (exitErr) {
      console.error('[audioEngine] FFmpeg close error:', exitErr.message);
      if (onError) onError(exitErr);
    } else if (!isPaused && onEnd) {
      onEnd();
    }
  });

  // If the caller provided a volume option, apply a simple software gain stage
  // before piping PCM to the native output. This supports common formats: s16le, f32le, s24le.
  class GainTransform extends Transform {
    constructor(format, channels, volumePercent) {
      super();
      this.format = format;
      this.channels = channels || 1;
      this.gain = Math.min(100, Math.max(0, Number.isFinite(volumePercent) ? volumePercent : 100)) / 100.0;
    }

    _transform(chunk, encoding, callback) {
      try {
        if (this.gain === 1.0) {
          this.push(chunk);
          return callback();
        }

        if (this.format === 's16le') {
          const out = Buffer.allocUnsafe(chunk.length);
          for (let i = 0; i + 1 < chunk.length; i += 2) {
            const s = chunk.readInt16LE(i);
            let v = Math.round(s * this.gain);
            if (v > 32767) v = 32767;
            else if (v < -32768) v = -32768;
            out.writeInt16LE(v, i);
          }
          this.push(out);
          return callback();
        }

        if (this.format === 'f32le') {
          // Use DataView to read/write floats from the Buffer backing store
          const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.length);
          const out = Buffer.allocUnsafe(chunk.length);
          for (let i = 0; i + 3 < chunk.length; i += 4) {
            const f = view.getFloat32(i, true);
            let v = f * this.gain;
            if (v > 1.0) v = 1.0;
            else if (v < -1.0) v = -1.0;
            out.writeFloatLE(v, i);
          }
          this.push(out);
          return callback();
        }

        if (this.format === 's24le') {
          const out = Buffer.allocUnsafe(chunk.length);
          for (let i = 0; i + 2 < chunk.length; i += 3) {
            let s = chunk[i] | (chunk[i + 1] << 8) | (chunk[i + 2] << 16);
            if (s & 0x800000) s |= 0xff000000; // sign extend
            let v = Math.round(s * this.gain);
            if (v > 0x7fffff) v = 0x7fffff;
            else if (v < -0x800000) v = -0x800000;
            out[i] = v & 0xff;
            out[i + 1] = (v >> 8) & 0xff;
            out[i + 2] = (v >> 16) & 0xff;
          }
          this.push(out);
          return callback();
        }

        // Unknown format — pass through
        this.push(chunk);
        return callback();
      } catch (err) {
        return callback(err);
      }
    }
  }

  if (ffmpegProc.stdout) {
    ffmpegProc.stdout.on('error', (err) => {
      console.error('[audioEngine] stdout error:', err);
      if (onError) onError(err);
      stop();
    });

    const vol = Number(options?.volume ?? 100);
    const gainStream = new GainTransform(ffmpegFormat, actualChannels, vol);
    currentGainStream = gainStream;
    ffmpegProc.stdout.pipe(gainStream).pipe(outputStream);
  }

  if (outputStream && typeof outputStream.on === 'function') {
    outputStream.on('error', (err) => {
      console.error('[audioEngine] output stream error:', err);
      if (onError) onError(err);
      stop();
    });
  }
}

function stop() {
  currentStartTime = 0;
  if (ffmpegProc) {
    try {
      // SIGTERM is more portable on Windows than SIGKILL
      ffmpegProc.kill('SIGTERM');
    } catch {
      // ignore
    }
    ffmpegProc = null;
  }

  if (outputStream) {
    try {
      outputStream.end();
    } catch {
      // ignore
    }
    outputStream = null;
  }

  isPaused = false;
  currentFile = null;
}

function pause() {
  console.log('[audioEngine] pause called');
  if (!ffmpegProc || isPaused) {
      console.log('[audioEngine] pause ignored: proc=', !!ffmpegProc, 'paused=', isPaused);
      return;
  }
  try {
    if (ffmpegProc.stdout) {
        console.log('[audioEngine] pausing ffmpeg stdout');
        ffmpegProc.stdout.pause();
    }
    if (outputStream && typeof outputStream.pause === 'function') {
        console.log('[audioEngine] pausing native output');
        outputStream.pause();
    }
  } catch (e) {
    console.error('[audioEngine] pause error:', e);
  }
  isPaused = true;
}

function resume() {
  console.log('[audioEngine] resume called');
  if (!ffmpegProc || !isPaused) {
      console.log('[audioEngine] resume ignored: proc=', !!ffmpegProc, 'paused=', isPaused);
      return;
  }
  try {
    if (ffmpegProc.stdout) {
        console.log('[audioEngine] resuming ffmpeg stdout');
        ffmpegProc.stdout.resume();
    }
    if (outputStream && typeof outputStream.resume === 'function') {
        console.log('[audioEngine] resuming native output');
        outputStream.resume();
    }
  } catch (e) {
    console.error('[audioEngine] resume error:', e);
  }
  isPaused = false;
}

// For renderer diagnostics (“Engine: native/renderer …”)
function getStatus() {
  return {
    exclusiveAvailable: !!exclusiveAudio,
    exclusiveLoadError,
    playing: !!ffmpegProc,
    paused: !!isPaused,
    currentFile: currentFile || null,
    currentTime: getTime(),
    volume: (lastOptions && Number.isFinite(lastOptions.volume)) ? lastOptions.volume : 100,
  };
}

// Device enumeration comes straight from your native addon
function getDevices() {
  if (!exclusiveAudio || typeof exclusiveAudio.getDevices !== 'function') {
    return [];
  }
  try {
    return exclusiveAudio.getDevices();
  } catch {
    return [];
  }
}

function getTime() {
  if (outputStream && typeof outputStream.getElapsedTime === 'function') {
    return currentStartTime + outputStream.getElapsedTime();
  }
  return currentStartTime;
}

function seek(time) {
  if (!currentFile) return;
  console.log('[audioEngine] seeking to', time);
  playFile(currentFile, lastOnEnd, lastOnError, { ...lastOptions, startTime: time });
}

const audioEngineApi = {
  playFile,
  stop,
  pause,
  resume,
  getStatus,
  getDevices,
  getTime,
  setVolume,
  seek,
  setEQ,
  getEQ,
};

export default audioEngineApi;
