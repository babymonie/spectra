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
      const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      if (probe.status === 0) {
        console.log('[audioEngine] Falling back to system FFmpeg from PATH');
        return 'ffmpeg';
      }
      return null;
    }
    let p = ffmpegPath;
    if (p.includes('app.asar')) {
      p = p.replace('app.asar', 'app.asar.unpacked');
    }

    if (existsSync(p)) {
      console.log('[audioEngine] Using bundled FFmpeg binary at:', p);
      return p;
    }

    const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const baseDir = process.resourcesPath || process.cwd();
    const localBinPath = path.join(baseDir, 'bin', ffmpegName);
    if (existsSync(localBinPath)) {
      console.log('[audioEngine] Using local FFmpeg binary at:', localBinPath);
      return localBinPath;
    }

    console.warn('[audioEngine] Bundled FFmpeg not found, probing system FFmpeg...');
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

try {
  const mod = await import('./exclusiveAudio.js');
  exclusiveAudio = mod.default || mod;
} catch (e) {
  exclusiveLoadError = e?.message ?? String(e);
  console.warn('[audioEngine] failed to load exclusiveAudio addon:', exclusiveLoadError);
}

let ffmpegProc = null;
let outputStream = null;
let currentFile = null;
let isPaused = false;
let currentGainStream = null;
let lastOnEnd = null;
let lastOnError = null;
let lastOptions = {};
let currentStartTime = 0;
let silenceInterval = null;
let silenceChunk = null;
let outputFormatInfo = { sampleRate: 44100, channels: 2, bitDepth: 16 };

let eqState = {
  enabled: false,
  preset: 'flat',
  bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] 
};

function setEQ(state) {
  console.log('[audioEngine] setEQ:', state);
  const wasEnabled = eqState.enabled;
  const oldBands = [...eqState.bands];
  
  if (state.enabled !== undefined) eqState.enabled = state.enabled;
  if (state.preset !== undefined) eqState.preset = state.preset;
  if (state.bands && Array.isArray(state.bands)) eqState.bands = [...state.bands];

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

function setVolume(v) {
  const pct = Math.min(100, Math.max(0, Number.isFinite(v) ? Number(v) : 100));
  if (currentGainStream) {
    currentGainStream.gain = pct / 100.0;
    _updateLastOptionsVolume(pct);
    return true;
  }
  _updateLastOptionsVolume(pct);
  return false;
}

function _updateLastOptionsVolume(v) {
  try {
    const pct = Math.min(100, Math.max(0, Number.isFinite(v) ? Number(v) : 100));
    // Check if lastOptions is a valid object before spreading
    if (typeof lastOptions === 'object' && lastOptions !== null) {
        lastOptions = { ...lastOptions, volume: pct };
    } else {
        lastOptions = { volume: pct };
    }
  } catch (e) {
    console.warn('[audioEngine] error updating volume state:', e);
  }
}

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
    return exclusiveAudio.createExclusiveStream({ ...baseOpts, mode: m });
  };

  let lastErr;

  try {
    return tryMode(firstMode);
  } catch (e1) {
    lastErr = e1;
    console.warn(`[audioEngine] ${firstMode} mode failed:`, e1?.message ?? e1);
  }

  try {
    return tryMode(secondMode);
  } catch (e2) {
    console.warn(`[audioEngine] ${secondMode} mode also failed:`, e2?.message ?? e2);
    lastErr = e2;
  }

  const err = new Error(
    'Failed to open native audio output: ' + (lastErr?.message ?? String(lastErr))
  );
  throw err;
}

async function playFile(filePath, onEnd, onError, options = {}) {
  try {
    const startAt = Number(options?.startTime ?? 0);
    const trackPath = options?.track?.path;
    const currentTrackPath = lastOptions?.track?.path;
    const sameByTrack = trackPath && currentTrackPath && trackPath === currentTrackPath;
    const sameByFile = currentFile && filePath && currentFile === filePath;
    const sameFile = ffmpegProc && (sameByTrack || sameByFile);
    if (sameFile && startAt < 0.05) {
      console.log('[audioEngine] playFile dedup: already playing this file, ignoring duplicate request');
      return;
    }
  } catch {}

  stop();
  try {
    console.log('[audioEngine] playFile called for', filePath);
  } catch {}
  currentStartTime = options.startTime || 0;

  currentFile = filePath;
  lastOnEnd = onEnd;
  lastOnError = onError;
  lastOptions = options;
  isPaused = false;

  let meta;
  try {
    meta = await parseFile(filePath);
  } catch {
    meta = {};
  }
  const fmt = meta?.format || {};
  const sampleRate = options.sampleRate || fmt.sampleRate || 44100;
  const channels = fmt.numberOfChannels || 2;
  const bitDepth = 16; 

  try {
    outputStream = createExclusiveStream({
      sampleRate,
      channels,
      bitDepth,
      deviceId: options.deviceId,
      mode: options.mode,
      bufferMs: options.bufferMs || 250,
      bitPerfect: !!options.bitPerfect,
      strictBitPerfect: !!options.strictBitPerfect,
    });
  } catch (err) {
    if (onError) onError(err);
    return;
  }

  const actualSampleRate = outputStream.actualSampleRate || sampleRate;
  const actualChannels = outputStream.actualChannels || channels;
  const actualBitDepth = outputStream.actualBitDepth || bitDepth;

  // Remember format info for pause/resume silence filler
  outputFormatInfo = { sampleRate: actualSampleRate, channels: actualChannels, bitDepth: actualBitDepth };

  // Prepare a silence chunk (~20ms) matching the output format to avoid underruns when paused
  try {
    const bytesPerSample = Math.max(1, Math.floor(actualBitDepth / 8));
    const bytesPerFrame = bytesPerSample * actualChannels;
    const chunkFrames = Math.max(1, Math.floor(actualSampleRate * 0.02)); // 20ms
    const chunkBytes = chunkFrames * bytesPerFrame;
    silenceChunk = Buffer.alloc(chunkBytes, 0);
  } catch (e) {
    silenceChunk = null;
  }

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
    // UPDATED: More robust network options for MinIO/S3
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_on_http_error', '4xx,5xx',
      '-reconnect_delay_max', '10',
      '-rw_timeout', '15000000', // 15 seconds timeout
      '-probesize', '10000000',  // More probe data for slow starts
      '-analyzeduration', '20000000'
    );
  }

  if (options.startTime) {
    args.push('-ss', String(options.startTime));
  }

  args.push(
    '-i', filePath,
    '-vn'
  );

  if (eqState.enabled) {
    const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    let entries = '';
    for (let i = 0; i < freqs.length; i++) {
      const gain = eqState.bands[i] || 0;
      if (i > 0) entries += ';';
      entries += `entry(${freqs[i]},${gain})`;
    }
    args.push('-af', `firequalizer=gain_entry='${entries}'`);
  }

  args.push(
    '-f', ffmpegFormat,
    '-acodec', ffmpegCodec,
    '-ac', String(actualChannels),
    '-ar', String(actualSampleRate),
    'pipe:1'
  );

  if (!resolvedFfmpegPath) {
    const err = new Error('FFmpeg binary path is not available');
    console.error('[audioEngine] Cannot start FFmpeg:', err.message);
    if (onError) onError(err);
    return;
  }

  ffmpegProc = spawn(resolvedFfmpegPath, args);

  if (ffmpegProc.stderr) {
    ffmpegProc.stderr.on('data', (data) => {
      // Normalize and inspect stderr output. Many FFmpeg "warnings"
      // (especially about embedded album art / JPEGs) are benign for
      // audio-only pipelines and should not be logged as errors.
      const raw = String(data || '');
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const msg of lines) {
        // Common messages to downgrade to warning (or ignore)
        const benignPatterns = [
          /Stream ends prematurely/i,
          /Invalid SOS parameters for sequential JPEG/i,
          /premature end of image/i,
          /premature end of data/i,
          /Skipping unsupported/i,
        ];

        const isBenign = benignPatterns.some((re) => re.test(msg));

        if (isBenign) {
          console.warn('[audioEngine] FFmpeg warning:', msg);
          continue;
        }

        // Treat obvious error lines as errors, otherwise as warnings
        if (/\berror\b/i.test(msg) || /failed/i.test(msg)) {
          console.error('[audioEngine] FFmpeg stderr:', msg);
        } else {
          console.warn('[audioEngine] FFmpeg stderr:', msg);
        }
      }
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
      code && code !== 0 && code !== 255 // 255 is often SIGTERM/Kill
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

  class GainTransform extends Transform {
    constructor(format, channels, volumePercent) {
      super();
      this.format = format;
      this.channels = channels || 1;
      this.gain = Math.min(100, Math.max(0, Number.isFinite(volumePercent) ? volumePercent : 100)) / 100.0;
    }

    _transform(chunk, encoding, callback) {
      try {
        if (this.gain >= 0.99 && this.gain <= 1.01) {
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
            if (s & 0x800000) s |= 0xff000000;
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

        this.push(chunk);
        return callback();
      } catch (err) {
        return callback(err);
      }
    }
  }

  if (ffmpegProc.stdout) {
    ffmpegProc.stdout.on('error', (err) => {
      // Avoid spamming logs if error is just EPIPE from closing
      if (err.code !== 'EPIPE') {
          console.error('[audioEngine] stdout error:', err);
          if (onError) onError(err);
      }
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
  // stop any silence filler
  if (silenceInterval) {
    clearInterval(silenceInterval);
    silenceInterval = null;
  }
  if (ffmpegProc) {
    try {
      ffmpegProc.kill('SIGTERM');
    } catch {}
    ffmpegProc = null;
  }

  if (outputStream) {
    try {
      outputStream.end();
      // Force destroy to ensure native handle closes
      if (typeof outputStream.destroy === 'function') outputStream.destroy();
    } catch {}
    outputStream = null;
  }

  isPaused = false;
  currentFile = null;
}

function pause() {
  console.log('[audioEngine] pause called');
  if (!ffmpegProc || isPaused) return;

  try {
    if (ffmpegProc.stdout) ffmpegProc.stdout.pause();

    // Use native pause (it already outputs silence in the render thread)
    if (outputStream && typeof outputStream.pause === 'function') {
      outputStream.pause();
    }
  } catch (e) {
    console.error('[audioEngine] pause error:', e);
  }

  isPaused = true;
}


function resume() {
  console.log('[audioEngine] resume called');
  if (!ffmpegProc || !isPaused) return;

  try {
    if (outputStream && typeof outputStream.resume === 'function') {
      outputStream.resume();
    }
    if (ffmpegProc.stdout) ffmpegProc.stdout.resume();
  } catch (e) {
    console.error('[audioEngine] resume error:', e);
  }

  isPaused = false;
}

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