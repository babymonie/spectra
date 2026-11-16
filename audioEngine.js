import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'stream';
import ffmpegPath from 'ffmpeg-static';
import { parseFile } from 'music-metadata';
import { closeSync, createReadStream, existsSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { FFmpegSupervisor } from './ffmpegSupervisor.js';

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

// Probe once whether the resolved FFmpeg binary has libsoxr compiled in.
const hasSoxr = (() => {
  try {
    if (!resolvedFfmpegPath) return false;
    const result = spawnSync(resolvedFfmpegPath, ['-version'], { encoding: 'utf8', timeout: 5000 });
    const out = (result.stdout || '') + (result.stderr || '');
    return out.includes('enable-libsoxr') || out.includes('--enable-libsoxr');
  } catch {
    return false;
  }
})();
console.log(`[audioEngine] soxr resampler: ${hasSoxr ? 'available' : 'unavailable — using swr'}`)

let ffmpegProc = null;
let ffmpegSupervisor = null;
let outputStream = null;
let currentFile = null;
let currentInputStream = null;
let isPaused = false;
let currentGainStream = null;
let lastOnEnd = null;
let lastOnError = null;
let lastOptions = {};
let currentStartTime = 0;
let silenceInterval = null;
let silenceChunk = null;
let outputFormatInfo = { sampleRate: 44100, channels: 2, bitDepth: 16, sampleFormat: 's16le' };
let currentSourceInfo = null;
let currentOutputInfo = null;
const backendHealth = new Map();

// Bumped by every playFile()/stop(). Async continuations and stream callbacks
// compare against it so a superseded request can never touch live state.
let playGeneration = 0;
let trackBaseBytes = 0;      // outputStream.totalBytesWritten when this track began
let currentCueStart = 0;     // absolute offset of a cue virtual track inside its file
let currentDuration = 0;     // seconds, relative to the (virtual) track start
let trackEnded = false;      // decoder finished naturally; waiting for a hand-over
let idleCloseTimer = null;
let pendingFinish = null;    // end-of-track notification deferred while paused
let outputErrorHandler = null;
let lastPlayRequest = { key: null, at: 0, startAt: 0 };
const probeCache = new Map();
const EMPTY_CHUNK = Buffer.alloc(0);

function clearIdleClose() {
  if (idleCloseTimer) { clearTimeout(idleCloseTimer); idleCloseTimer = null; }
}

// After a natural end the device stays open briefly so the next track can be
// appended gaplessly. If nothing follows, release the device.
function scheduleIdleClose(gen) {
  clearIdleClose();
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    if (gen === playGeneration && trackEnded) stop();
  }, 2500);
}

function waitForDrain(stream, maxMs = 1200) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!stream || stream._closed || isPaused) return resolve();
      const buffered = typeof stream.getBufferedBytes === 'function' ? stream.getBufferedBytes() : 0;
      if (buffered <= 0 || Date.now() - started > maxMs) {
        // Ring is empty; give the hardware buffer a moment to play out too.
        return setTimeout(resolve, Math.min(150, Math.max(30, Number(stream.actualBufferMs) || 60)));
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

function isNetworkPath(p) {
  return typeof p === 'string' && /^https?:\/\//i.test(p);
}

/**
 * Ask FFmpeg what a source really is. Used for network streams (UPnP, WebDAV,
 * object storage) and for local files music-metadata cannot parse, so hi-res
 * streams are not silently forced to 44.1 kHz / 16-bit.
 */
function probeSource(filePath) {
  if (!resolvedFfmpegPath || !filePath) return Promise.resolve({});
  if (probeCache.has(filePath)) return Promise.resolve(probeCache.get(filePath));
  return new Promise((resolve) => {
    const args = ['-hide_banner'];
    if (isNetworkPath(filePath)) args.push('-rw_timeout', '8000000');
    args.push('-i', filePath);
    let stderr = '';
    let done = false;
    let proc;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      const info = {};
      const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (dur) info.duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
      const audio = stderr.match(/Stream #[^\n]*Audio:\s*([^\n]+)/);
      if (audio) {
        const line = audio[1];
        info.codec = line.split(/[ ,(]/)[0] || null;
        const rate = line.match(/(\d+)\s*Hz/);
        if (rate) info.sampleRate = Number(rate[1]);
        if (/\bmono\b/.test(line)) info.numberOfChannels = 1;
        else if (/\bstereo\b/.test(line)) info.numberOfChannels = 2;
        else if (/\b7\.1\b/.test(line)) info.numberOfChannels = 8;
        else if (/\b5\.1\b/.test(line)) info.numberOfChannels = 6;
        else {
          const ch = line.match(/(\d+)\s*channels/);
          if (ch) info.numberOfChannels = Number(ch[1]);
        }
        const explicitBits = line.match(/\((\d+)\s*bit\)/);
        if (explicitBits) info.bitsPerSample = Number(explicitBits[1]);
        else if (/\bs16p?\b/.test(line)) info.bitsPerSample = 16;
        else if (/\bs32p?\b/.test(line)) info.bitsPerSample = 32;
        else if (/\bdsd_/i.test(line)) info.bitsPerSample = 1;
      }
      if (info.sampleRate) {
        if (probeCache.size > 200) probeCache.delete(probeCache.keys().next().value);
        probeCache.set(filePath, info);
      }
      resolve(info);
    };
    timer = setTimeout(() => { try { proc?.kill('SIGTERM'); } catch {} finish(); }, 10000);
    try {
      proc = spawn(resolvedFfmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      proc.stderr.on('data', (d) => { if (stderr.length < 65536) stderr += String(d); });
      proc.on('error', finish);
      proc.on('close', finish);
    } catch {
      finish();
    }
  });
}

/** Kill the decoder side only; the output device stays open. */
function stopDecoder() {
  if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
  if (ffmpegSupervisor) { try { ffmpegSupervisor.kill(); } catch {} ffmpegSupervisor = null; }
  if (ffmpegProc) { try { ffmpegProc.kill('SIGTERM'); } catch {} ffmpegProc = null; }
  if (currentGainStream) { try { currentGainStream.unpipe(); currentGainStream.destroy(); } catch {} currentGainStream = null; }
}

function detachOutputErrorHandler() {
  if (outputStream && outputErrorHandler) {
    try { outputStream.removeListener('error', outputErrorHandler); } catch {}
    // Keep a no-op listener so a late error on a dying stream is not "unhandled".
    try { outputStream.on('error', () => {}); } catch {}
  }
  outputErrorHandler = null;
}

/** Absolute position inside the source file (ignores cue offsets). */
function absolutePosition() {
  if (outputStream && typeof outputStream.getElapsedTime === 'function') {
    return currentStartTime + outputStream.getElapsedTime(trackBaseBytes);
  }
  return currentStartTime;
}

/** Restart the current source at `absTime`, keeping pause state and device. */
function restartCurrent(absTime, extra = {}) {
  if (!currentFile) return Promise.resolve();
  return playFile(currentFile, lastOnEnd, lastOnError, {
    ...(lastOptions || {}),
    gapless: false,
    startTime: Math.max(0, Number.isFinite(absTime) ? absTime : 0),
    __resumePaused: isPaused,
    __restart: true,
    ...extra,
  });
}

function normalizePlaybackOption(v) {
  return v === undefined || v === null || v === '' ? null : v;
}

function hasOutputOptionDelta(next = {}, prev = {}) {
  const keys = ['deviceId', 'mode', 'sampleRatePolicy', 'sampleRate', 'bitDepth', 'bufferMs', 'bufferFrames', 'bitPerfect', 'strictBitPerfect', 'dsdTransport'];
  for (const key of keys) {
    const a = normalizePlaybackOption(next[key]);
    const b = normalizePlaybackOption(prev[key]);
    if (String(a) !== String(b)) return true;
  }
  return false;
}

function isLocalDsf(filePath, fmt) {
  return !!(
    filePath &&
    typeof filePath === 'string' &&
    !/^https?:\/\//i.test(filePath) &&
    (String(fmt?.container || '').toUpperCase() === 'DSF' || path.extname(filePath).toLowerCase() === '.dsf')
  );
}

function readDsfInfo(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(92);
    readSync(fd, header, 0, header.length, 0);
    if (header.subarray(0, 4).toString('ascii') !== 'DSD ') {
      throw new Error('Not a DSF file');
    }
    if (header.subarray(28, 32).toString('ascii') !== 'fmt ') {
      throw new Error('Invalid DSF fmt chunk');
    }
    const fmtSize = Number(header.readBigUInt64LE(32));
    const dataOffset = 28 + fmtSize;
    if (dataOffset + 12 > header.length) {
      throw new Error('Unsupported DSF header layout');
    }
    if (header.subarray(dataOffset, dataOffset + 4).toString('ascii') !== 'data') {
      throw new Error('Invalid DSF data chunk');
    }
    const dataChunkSize = Number(header.readBigUInt64LE(dataOffset + 4));
    return {
      channels: header.readUInt32LE(52),
      sampleRate: header.readUInt32LE(56),
      bitsPerSample: header.readUInt32LE(60),
      sampleCount: Number(header.readBigUInt64LE(64)),
      blockSizePerChannel: header.readUInt32LE(72),
      dataStart: dataOffset + 12,
      dataBytes: Math.max(0, dataChunkSize - 12),
    };
  } finally {
    closeSync(fd);
  }
}

class DsfDopTransform extends Transform {
  constructor({ channels, blockSizePerChannel }) {
    super();
    this.channels = channels;
    this.blockSizePerChannel = blockSizePerChannel;
    this.blockBytes = channels * blockSizePerChannel;
    this.pending = Buffer.alloc(0);
    this.marker = 0x05;
  }

  _transform(chunk, encoding, callback) {
    try {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      while (this.pending.length >= this.blockBytes) {
        const block = this.pending.subarray(0, this.blockBytes);
        this.pending = this.pending.subarray(this.blockBytes);
        this.push(this._packBlock(block));
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _flush(callback) {
    try {
      if (this.pending.length >= this.channels * 2) {
        this.push(this._packBlock(this.pending));
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _packBlock(block) {
    const frames = Math.floor(block.length / this.channels / 2);
    const out = Buffer.allocUnsafe(frames * this.channels * 3);
    let o = 0;
    for (let i = 0; i < frames; i++) {
      const marker = this.marker;
      this.marker = this.marker === 0x05 ? 0xfa : 0x05;
      for (let ch = 0; ch < this.channels; ch++) {
        const base = ch * this.blockSizePerChannel + i * 2;
        out[o++] = block[base] || 0;
        out[o++] = block[base + 1] || 0;
        out[o++] = marker;
      }
    }
    return out;
  }
}

function createDsfDopStream(filePath, dsf) {
  if (dsf.bitsPerSample !== 1) {
    throw new Error('DoP requires 1-bit DSF input');
  }
  if (dsf.channels < 1 || dsf.channels > 2) {
    throw new Error(`DoP currently supports mono/stereo DSF only; got ${dsf.channels} channels`);
  }
  if (!dsf.blockSizePerChannel || dsf.blockSizePerChannel < 2) {
    throw new Error('Invalid DSF block size for DoP');
  }
  return createReadStream(filePath, {
    start: dsf.dataStart,
    end: dsf.dataStart + dsf.dataBytes - 1,
    highWaterMark: dsf.blockSizePerChannel * dsf.channels * 4,
  }).pipe(new DsfDopTransform({
    channels: dsf.channels,
    blockSizePerChannel: dsf.blockSizePerChannel,
  }));
}

class DsfNativeTransform extends Transform {
  constructor({ channels, blockSizePerChannel }) {
    super();
    this.channels = channels;
    this.blockSizePerChannel = blockSizePerChannel;
    this.blockBytes = channels * blockSizePerChannel;
    this.pending = Buffer.alloc(0);
  }

  _transform(chunk, encoding, callback) {
    try {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      while (this.pending.length >= this.blockBytes) {
        const block = this.pending.subarray(0, this.blockBytes);
        this.pending = this.pending.subarray(this.blockBytes);
        this.push(this._interleaveBlock(block));
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _flush(callback) {
    try {
      if (this.pending.length >= this.channels) {
        this.push(this._interleaveBlock(this.pending));
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _interleaveBlock(block) {
    const frames = Math.floor(block.length / this.channels);
    const out = Buffer.allocUnsafe(frames * this.channels);
    let o = 0;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < this.channels; ch++) {
        out[o++] = block[ch * this.blockSizePerChannel + i] || 0;
      }
    }
    return out;
  }
}

function createDsfNativeStream(filePath, dsf) {
  if (dsf.bitsPerSample !== 1) {
    throw new Error('Native DSD requires 1-bit DSF input');
  }
  if (dsf.channels < 1 || dsf.channels > 2) {
    throw new Error(`Native DSD currently supports mono/stereo DSF only; got ${dsf.channels} channels`);
  }
  if (!dsf.blockSizePerChannel || dsf.blockSizePerChannel < 1) {
    throw new Error('Invalid DSF block size for native DSD');
  }
  return createReadStream(filePath, {
    start: dsf.dataStart,
    end: dsf.dataStart + dsf.dataBytes - 1,
    highWaterMark: dsf.blockSizePerChannel * dsf.channels * 4,
  }).pipe(new DsfNativeTransform({
    channels: dsf.channels,
    blockSizePerChannel: dsf.blockSizePerChannel,
  }));
}
let eqState = {
  enabled: false,
  preset: 'flat',
  bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
};

// Pre-amp gain in dB (±12 dB), applied on top of volume and ReplayGain
let preampDb = 0;

// ReplayGain mode: 'track' | 'album' | 'off'
let replayGainMode = 'track';

// dB to linear conversion helper (clamped to prevent absurd values)
function dbToLinear(db) {
  return Math.pow(10, Math.max(-80, Math.min(24, db)) / 20);
}

/**
 * Compute total linear gain for GainTransform from all gain stages.
 * @param {number} volumePct  - user volume 0–100
 * @param {object|null} rg    - replaygain object from metadata { trackGain, albumGain, trackPeak, albumPeak }
 * @returns {number} linear gain to apply (pre-clipped to prevent hard distortion)
 */
function computeTotalGain(volumePct, rg) {
  const vol = Math.min(1, Math.max(0, (Number.isFinite(volumePct) ? volumePct : 100) / 100));
  let rgDb = 0;
  let peak = 1;
  if (rg && replayGainMode !== 'off') {
    const gain = replayGainMode === 'album' && rg.albumGain != null ? rg.albumGain : rg.trackGain;
    if (gain != null) rgDb = gain;
    const p = replayGainMode === 'album' && rg.albumPeak != null ? rg.albumPeak : rg.trackPeak;
    if (p != null && p > 0) peak = p;
  }
  const totalLinear = vol * dbToLinear(rgDb + preampDb);
  // Hard-clip to 1/peak to prevent clipping (standard RG behavior)
  return Math.min(totalLinear, 1.0 / peak);
}

function applyEqPlaybackCompatibility(options = {}) {
  const next = { ...(options || {}) };
  if (eqState.enabled) {
    if (next.__preEqBitPerfect === undefined) next.__preEqBitPerfect = !!next.bitPerfect;
    if (next.__preEqStrictBitPerfect === undefined) next.__preEqStrictBitPerfect = !!next.strictBitPerfect;
    if (next.__preEqDsdTransport === undefined) next.__preEqDsdTransport = next.dsdTransport || 'pcm';
    next.bitPerfect = false;
    next.strictBitPerfect = false;
    if (next.dsdTransport === 'dop' || next.dsdTransport === 'native') {
      next.dsdTransport = 'pcm';
    }
  } else {
    if (next.__preEqBitPerfect !== undefined) {
      next.bitPerfect = !!next.__preEqBitPerfect;
      delete next.__preEqBitPerfect;
    }
    if (next.__preEqStrictBitPerfect !== undefined) {
      next.strictBitPerfect = !!next.__preEqStrictBitPerfect;
      delete next.__preEqStrictBitPerfect;
    }
    if (next.__preEqDsdTransport !== undefined) {
      next.dsdTransport = next.__preEqDsdTransport;
      delete next.__preEqDsdTransport;
    }
  }
  return next;
}
function setEQ(state) {
  console.log('[audioEngine] setEQ:', state);
  const wasEnabled = eqState.enabled;
  const oldBands = [...eqState.bands];

  if (state.enabled !== undefined) eqState.enabled = state.enabled;
  if (state.preset !== undefined) eqState.preset = state.preset;
  if (state.bands && Array.isArray(state.bands)) eqState.bands = [...state.bands];

  const bandsChanged = JSON.stringify(oldBands) !== JSON.stringify(eqState.bands);
  const shouldRestart = (wasEnabled !== eqState.enabled) || (eqState.enabled && bandsChanged);

  if (currentFile && shouldRestart && (ffmpegProc || currentInputStream)) {
    console.log('[audioEngine] EQ changed, restarting playback...');
    restartCurrent(absolutePosition(), { __reuseOutput: true }).catch((e) => {
      console.error('[audioEngine] EQ restart failed:', e);
    });
  }
}

function getEQ() {
  return { ...eqState };
}

function setVolume(v) {
  const pct = Math.min(100, Math.max(0, Number.isFinite(v) ? Number(v) : 100));
  if (currentGainStream) {
    currentGainStream.gain = computeTotalGain(pct, currentGainStream._rgMeta ?? null);
    _updateLastOptionsVolume(pct);
    return true;
  }
  _updateLastOptionsVolume(pct);
  return false;
}

function setPreamp(db) {
  preampDb = Math.min(12, Math.max(-12, Number.isFinite(Number(db)) ? Number(db) : 0));
  // Re-apply gain to live stream
  if (currentGainStream) {
    const vol = lastOptions?.volume ?? 100;
    currentGainStream.gain = computeTotalGain(vol, currentGainStream._rgMeta ?? null);
  }
  return preampDb;
}

function setReplayGainMode(mode) {
  if (['track', 'album', 'off'].includes(mode)) replayGainMode = mode;
  // Re-apply gain to live stream
  if (currentGainStream) {
    const vol = lastOptions?.volume ?? 100;
    currentGainStream.gain = computeTotalGain(vol, currentGainStream._rgMeta ?? null);
  }
  return replayGainMode;
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

function createExclusiveStream({ sampleRate, channels, bitDepth, deviceId, mode, bufferMs, bufferFrames, bitPerfect, strictBitPerfect, windowHandle, dsdNative }) {
  if (!exclusiveAudio || typeof exclusiveAudio.createExclusiveStream !== 'function') {
    throw new Error('exclusiveAudio addon not available');
  }

  const requestedMode = mode || 'exclusive';
  const parsedBufferMs = Number(bufferMs);
  const effectiveBufferMs = Number.isFinite(parsedBufferMs) && parsedBufferMs > 0
    ? parsedBufferMs
    : (requestedMode === 'asio' ? 0 : 250);

  const baseOpts = {
    sampleRate,
    channels,
    bitDepth,
    deviceId: deviceId || null,
    bufferMs: effectiveBufferMs,
    bufferFrames: Number.isFinite(Number(bufferFrames)) ? Number(bufferFrames) : 0,
    bitPerfect: bitPerfect || false,
    strictBitPerfect: strictBitPerfect || false,
    windowHandle,
    dsdNative: !!dsdNative,
  };

  if (!['shared', 'exclusive', 'asio'].includes(requestedMode)) {
    throw new Error(`Unsupported audio output mode "${requestedMode}". Available built-in modes are WASAPI shared, WASAPI exclusive, and ASIO.`);
  }

  const firstMode = requestedMode;
  const secondMode = firstMode === 'exclusive' ? 'shared' : 'exclusive';

  const optionsForMode = (m) => {
    const opts = { ...baseOpts, mode: m };
    if (firstMode === 'asio' && m !== 'asio') {
      opts.deviceId = resolveWasapiFallbackDeviceId(baseOpts.deviceId);
      opts.dsdNative = false;
    }
    return opts;
  };

  const tryMode = (m) => {
    const streamOpts = optionsForMode(m);
    console.log(`[audioEngine] opening ${m} native audio stream`, {
      deviceId: streamOpts.deviceId || null,
      requestedDeviceId: baseOpts.deviceId || null,
    });
    const stream = exclusiveAudio.createExclusiveStream(streamOpts);
    if (m !== firstMode) {
      stream.fallback = true;
      stream.fallbackReason = `${firstMode} mode failed: ${lastErr?.message ?? String(lastErr)}`;
    }
    return stream;
  };

  let lastErr;

  try {
    return tryMode(firstMode);
  } catch (e1) {
    lastErr = e1;
    console.warn(`[audioEngine] ${firstMode} mode failed:`, e1?.message ?? e1);
    if (firstMode === 'asio') {
      markBackendUnhealthy(baseOpts.deviceId, 'asio', e1?.message ?? String(e1), resolveWasapiFallbackDeviceId(baseOpts.deviceId));
    }
    if ((firstMode === 'asio' && strictBitPerfect) || (firstMode === 'exclusive' && strictBitPerfect)) {
      throw e1;
    }
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
  // Decode cue virtual track path: "audio.flac\x00cue\x00startSec\x00endSec"
  if (filePath && filePath.includes('\x00cue\x00')) {
    const parts = filePath.split('\x00cue\x00');
    const [audioFile, rest] = [parts[0], parts[1] || ''];
    const [startStr, endStr] = rest.split('\x00');
    const cueSec = parseFloat(startStr);
    const cueEnd = endStr && endStr !== '-' ? parseFloat(endStr) : null;
    const cueOptions = { ...options, __requestPath: filePath };
    if (Number.isFinite(cueSec)) {
      // Callers address a cue track relative to its own start.
      cueOptions.__cueStartSec = cueSec;
      cueOptions.startTime = cueSec + Math.max(0, Number(options?.startTime) || 0);
    }
    if (Number.isFinite(cueEnd)) cueOptions.__cueEndSec = cueEnd;
    return playFile(audioFile, onEnd, onError, cueOptions);
  }

  options = applyEqPlaybackCompatibility(routePlaybackOptionsForBackendHealth(options));
  const prevOptions = lastOptions || {};
  const requestKey = options.__requestPath || filePath;
  const startAt = Math.max(0, Number(options?.startTime ?? 0) || 0);

  // Swallow accidental double-fires (click + dblclick, duplicate IPC) only.
  // A deliberate replay of the same track must restart it.
  const now = Date.now();
  if (
    !options.__restart &&
    currentFile && !trackEnded &&
    lastPlayRequest.key === requestKey &&
    now - lastPlayRequest.at < 350 &&
    Math.abs(lastPlayRequest.startAt - startAt) < 0.05 &&
    !hasOutputOptionDelta(options, prevOptions)
  ) {
    console.log('[audioEngine] playFile dedup: duplicate request within 350ms ignored');
    return;
  }
  lastPlayRequest = { key: requestKey, at: now, startAt };

  const resumePaused = !!options.__resumePaused;
  const naturalHandover = options.gapless === true && trackEnded;
  const reuseRequested = options.gapless === true || options.__reuseOutput === true;
  options = { ...options };
  delete options.__resumePaused;
  delete options.__reuseOutput;
  delete options.__restart;

  clearIdleClose();
  pendingFinish = null;

  // Keep the device open when the next source can simply be appended to it
  // (gapless hand-over, seek, EQ change). Everything else gets a clean reopen.
  const canReuse =
    reuseRequested &&
    outputStream && !outputStream._closed && !outputStream.destroyed &&
    !currentInputStream &&
    !hasOutputOptionDelta(options, prevOptions);
  if (canReuse) {
    stopDecoder();
  } else {
    stop();
  }
  const gen = ++playGeneration;

  try {
    console.log('[audioEngine] playFile called for', filePath, canReuse ? '(reusing output)' : '');
  } catch {}

  currentStartTime = startAt;
  currentCueStart = Number.isFinite(options.__cueStartSec) ? options.__cueStartSec : 0;
  currentFile = filePath;
  lastOnEnd = onEnd;
  lastOnError = onError;
  lastOptions = options;
  isPaused = false;
  trackEnded = false;
  trackBaseBytes = outputStream ? outputStream.totalBytesWritten : 0;

  const fail = (err) => {
    if (gen !== playGeneration) return;
    stop();
    if (onError) onError(err);
  };

  let meta = null;
  if (!isNetworkPath(filePath)) {
    try {
      meta = await parseFile(filePath, { duration: false, skipCovers: true });
    } catch {
      meta = null;
    }
    if (gen !== playGeneration) return; // superseded while reading tags
  }
  let fmt = { ...(meta?.format || {}) };
  if (!fmt.sampleRate || !fmt.numberOfChannels) {
    const probed = await probeSource(filePath);
    if (gen !== playGeneration) return;
    const known = Object.fromEntries(Object.entries(fmt).filter(([, v]) => v !== undefined && v !== null));
    fmt = { ...probed, ...known };
  }

  // Extract ReplayGain from parsed tags and store for gain computation
  const metaCommon = meta?.common || {};
  const trackRgMeta = (() => {
    let trackGain = null, albumGain = null, trackPeak = null, albumPeak = null;
    const rg = (v) => { if (v == null) return null; if (typeof v === 'number') return v; if (typeof v?.dB === 'number') return v.dB; return parseFloat(String(v)) || null; };
    const pk = (v) => { if (v == null) return null; if (typeof v === 'number') return v; if (typeof v?.ratio === 'number') return v.ratio; return parseFloat(String(v)) || null; };
    trackGain = rg(metaCommon.replaygain_track_gain);
    albumGain = rg(metaCommon.replaygain_album_gain);
    trackPeak = pk(metaCommon.replaygain_track_peak);
    albumPeak = pk(metaCommon.replaygain_album_peak);
    return { trackGain, albumGain, trackPeak, albumPeak };
  })();
  {
    const fullDuration = Number(fmt.duration) || 0;
    currentDuration = Number.isFinite(options.__cueEndSec)
      ? Math.max(0, options.__cueEndSec - currentCueStart)
      : Math.max(0, fullDuration - currentCueStart);
  }
  // Pass RG into options so attachPipeline and computeTotalGain can use it
  options = { ...options, __replaygain: trackRgMeta };
  lastOptions = options;
  if (options.__backendHealthBypass) {
    console.warn('[audioEngine] bypassing unhealthy backend', options.__backendHealthBypass);
  }
  const dsdTransport = options.dsdTransport || 'pcm';
  const sampleRatePolicy = options.sampleRatePolicy || (options.sampleRate ? 'fixed' : 'source');
  const dsfSource = isLocalDsf(filePath, fmt);
  const useNativeDsd = dsdTransport === 'native' && dsfSource && options.mode === 'asio' && !eqState.enabled;
  const useDop = dsdTransport === 'dop' && dsfSource && !eqState.enabled;
  const bitPerfectOutput = !!options.bitPerfect || !!options.strictBitPerfect;
  if (bitPerfectOutput && eqState.enabled) {
    console.warn('[audioEngine] Bit-perfect output enabled; bypassing software equalizer');
  }
  if (bitPerfectOutput && Number(options?.volume ?? 100) !== 100) {
    console.warn('[audioEngine] Bit-perfect output enabled; bypassing software volume');
  }
  if ((dsdTransport === 'dop' || dsdTransport === 'native') && dsfSource && eqState.enabled) {
    console.warn('[audioEngine] EQ enabled; decoding DSD to PCM instead of native/DoP transport so EQ can be applied');
  }
  if (dsdTransport === 'native' && dsfSource && options.mode !== 'asio') {
    console.warn('[audioEngine] Native DSD requires ASIO output; decoding DSD to PCM for the selected output mode');
  }
  const dsf = (useDop || useNativeDsd) ? readDsfInfo(filePath) : null;
  const sourceSampleRate = fmt.sampleRate || 44100;
  const requestedSampleRate = Number.parseInt(String(options.sampleRate || ''), 10);
  const hasRequestedSampleRate = Number.isFinite(requestedSampleRate) && requestedSampleRate > 8000 && requestedSampleRate < 1000000;
  let pcmSampleRate = sourceSampleRate;
  if (sampleRatePolicy === 'fixed' && hasRequestedSampleRate) {
    pcmSampleRate = requestedSampleRate;
  } else if (sampleRatePolicy === 'upsample' && hasRequestedSampleRate) {
    pcmSampleRate = Math.max(sourceSampleRate, requestedSampleRate);
  }
  const sampleRate = useNativeDsd
    ? dsf.sampleRate
    : (useDop
      ? Math.floor(dsf.sampleRate / 16)
      : pcmSampleRate);
  const channels = (useDop || useNativeDsd) ? dsf.channels : (fmt.numberOfChannels || 2);
  const sourceBitDepth = options.bitDepth || fmt.bitsPerSample || 16;
  let bitDepth = useNativeDsd ? 8 : (useDop ? 24 : Number(sourceBitDepth));
  if (!useNativeDsd && ![16, 24, 32].includes(bitDepth)) {
    // Formats like DSF/DSD report 1-bit samples, but this engine decodes via
    // FFmpeg to PCM before WASAPI. Request a real PCM depth for exclusive mode.
    console.warn(`[audioEngine] source bit depth ${sourceBitDepth} is not a PCM WASAPI depth; using 24-bit PCM output`);
    bitDepth = 24;
  }

  // Reuse the open device when the next source has the same output format.
  let gaplessReused = false;
  if (canReuse && outputStream && !outputStream._closed) {
    const fmtOk =
      (outputStream.actualSampleRate || 0) === sampleRate &&
      (outputStream.actualChannels || 0) === channels &&
      (outputStream.actualBitDepth || 0) === bitDepth &&
      !useDop && !useNativeDsd;
    if (fmtOk) {
      gaplessReused = true;
      console.log('[audioEngine] reusing outputStream (format match)');
      const reused = outputStream;
      // The previous decoder may have been cut mid-frame: realign, and count
      // this track's position from the first byte that follows.
      trackBaseBytes = reused.totalBytesWritten;
      reused.realign(() => {
        if (gen === playGeneration && outputStream === reused) trackBaseBytes = reused.totalBytesWritten;
      });
      if (!resumePaused) { try { reused.resume(); } catch {} }
    } else {
      console.log('[audioEngine] output format changes; reopening outputStream');
      if (naturalHandover) {
        // Let the tail of the finished track play out before closing the device.
        await waitForDrain(outputStream);
        if (gen !== playGeneration) return;
      }
      detachOutputErrorHandler();
      try { outputStream.end(); if (typeof outputStream.destroy === 'function') outputStream.destroy(); } catch {}
      outputStream = null;
    }
  }

  if (!gaplessReused) {
    try {
      outputStream = createExclusiveStream({
        sampleRate,
        channels,
        bitDepth,
        deviceId: options.deviceId,
        mode: useNativeDsd ? 'asio' : (useDop ? 'exclusive' : options.mode),
        bufferMs: options.bufferMs,
        bufferFrames: Number.isFinite(Number(options.bufferFrames)) ? Number(options.bufferFrames) : 0,
        bitPerfect: (useDop || useNativeDsd) ? true : !!options.bitPerfect,
        strictBitPerfect: useDop ? true : !!options.strictBitPerfect,
        windowHandle: options.windowHandle,
        dsdNative: useNativeDsd,
      });
    } catch (err) {
      fail(err);
      return;
    }
    trackBaseBytes = 0;
  }

  const actualSampleRate = outputStream.actualSampleRate || sampleRate;
  const actualChannels = outputStream.actualChannels || channels;
  const actualBitDepth = outputStream.actualBitDepth || bitDepth;
  const actualSampleFormat = outputStream.actualSampleFormat || (
    actualBitDepth === 32 ? 'f32le' : `s${actualBitDepth}le`
  );

  currentSourceInfo = {
    sampleRate: sourceSampleRate,
    bitDepth: fmt.bitsPerSample || null,
    channels: fmt.numberOfChannels || channels,
    codec: fmt.codec || null,
    lossless: fmt.lossless ?? null,
    bitrate: fmt.bitrate || null,
    sampleRatePolicy,
  };
  currentOutputInfo = {
    requestedBackend: useNativeDsd ? 'native-dsd' : (useDop ? 'dop' : (options.mode || 'exclusive')),
    backend: outputStream.actualBackend || (useNativeDsd ? 'native-dsd' : (useDop ? 'dop' : options.mode)),
    sampleRate: actualSampleRate,
    channels: actualChannels,
    bitDepth: actualBitDepth,
    sampleFormat: actualSampleFormat,
    bufferFrames: outputStream.actualBufferFrames || 0,
    bufferMs: outputStream.actualBufferMs || 0,
    ringDurationMs: outputStream.ringDurationMs || 0,
    fallback: !!outputStream.fallback,
    fallbackReason: outputStream.fallbackReason || '',
    bitPerfect: bitPerfectOutput || useDop || useNativeDsd,
    dsp: bitPerfectOutput || useDop || useNativeDsd ? 'bypassed' : (eqState.enabled ? 'eq' : 'none'),
  };

  // Remember format info for pause/resume silence filler
  outputFormatInfo = {
    sampleRate: actualSampleRate,
    channels: actualChannels,
    bitDepth: actualBitDepth,
    sampleFormat: actualSampleFormat,
  };

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

  if (useNativeDsd) {
    if (actualSampleFormat !== 'dsd8') {
      const err = new Error(`Native DSD requires an ASIO driver with DSD sample buffers; got ${actualSampleFormat}`);
      try { outputStream.destroy(err); } catch {}
      if (onError) onError(err);
      return;
    }

    if (Number(options?.volume ?? 100) !== 100) {
      console.warn('[audioEngine] Volume ignored for native DSD output');
    }

    console.log(`[audioEngine] Streaming DSF as native DSD over ASIO: dsdRate=${dsf.sampleRate}, ch=${channels}`);
    currentInputStream = createDsfNativeStream(filePath, dsf);
    currentInputStream.on('error', (err) => {
      console.error('[audioEngine] native DSD stream error:', err);
      if (onError) onError(err);
      stop();
    });
    outputStream.on('error', (err) => {
      console.error('[audioEngine] output stream error:', err);
      if (onError) onError(err);
      stop();
    });
    outputStream.on('finish', () => {
      if (!isPaused && currentFile === filePath && onEnd) onEnd();
    });
    currentInputStream.pipe(outputStream);
    return;
  }
  if (useDop) {
    if (actualBitDepth !== 24 || actualSampleRate !== sampleRate || actualChannels !== channels) {
      const err = new Error(
        `DoP requires exact exclusive 24-bit ${sampleRate} Hz / ${channels}ch output; got ${actualBitDepth}-bit ${actualSampleRate} Hz / ${actualChannels}ch`
      );
      try { outputStream.destroy(err); } catch {}
      if (onError) onError(err);
      return;
    }

    if (eqState.enabled) {
      console.warn('[audioEngine] Equalizer bypassed for DoP output');
    }
    if (Number(options?.volume ?? 100) !== 100) {
      console.warn('[audioEngine] Volume ignored for DoP output');
    }

    console.log(`[audioEngine] Streaming DSF as DoP over exclusive WASAPI: carrier=${sampleRate}, dsdRate=${dsf.sampleRate}, ch=${channels}`);
    currentInputStream = createDsfDopStream(filePath, dsf);
    currentInputStream.on('error', (err) => {
      console.error('[audioEngine] DoP stream error:', err);
      if (onError) onError(err);
      stop();
    });
    outputStream.on('error', (err) => {
      console.error('[audioEngine] output stream error:', err);
      if (onError) onError(err);
      stop();
    });
    outputStream.on('finish', () => {
      if (!isPaused && currentFile === filePath && onEnd) onEnd();
    });
    currentInputStream.pipe(outputStream);
    return;
  }

  let ffmpegFormat = 's16le';
  let ffmpegCodec = 'pcm_s16le';

  if (actualSampleFormat === 'f32le') {
    ffmpegFormat = 'f32le';
    ffmpegCodec = 'pcm_f32le';
  } else if (actualSampleFormat === 's32le') {
    ffmpegFormat = 's32le';
    ffmpegCodec = 'pcm_s32le';
  } else if (actualSampleFormat === 's24le') {
    ffmpegFormat = 's24le';
    ffmpegCodec = 'pcm_s24le';
  }

  console.log(`[audioEngine] Spawning FFmpeg with format=${ffmpegFormat}, rate=${actualSampleRate}, ch=${actualChannels}`);

  if (!resolvedFfmpegPath) {
    const err = new Error('FFmpeg binary path is not available');
    console.error('[audioEngine] Cannot start FFmpeg:', err.message);
    fail(err);
    return;
  }

  // Build FFmpeg args; called again on supervisor restarts with updated startAt
  const buildArgs = (startAt) => {
    const a = ['-hide_banner', '-loglevel', 'error'];
    const isNetwork = typeof filePath === 'string' && /^https?:\/\//i.test(filePath);
    if (isNetwork) {
      a.push(
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_network_error', '1',
        '-reconnect_on_http_error', '4xx,5xx',
        '-reconnect_delay_max', '10',
        '-rw_timeout', '15000000',
        '-probesize', '10000000',
        '-analyzeduration', '20000000'
      );
    }
    if (startAt > 0) a.push('-ss', String(startAt));
    a.push('-i', filePath, '-vn');
    // Cue sheet end time: trim output at end of virtual track
    if (Number.isFinite(options.__cueEndSec) && options.__cueEndSec > 0) {
      const duration = options.__cueEndSec - startAt;
      if (duration > 0) a.push('-t', String(duration));
    }
    if (!bitPerfectOutput) {
      const filters = [];
      if (eqState.enabled) {
        const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
        let entries = '';
        let maxBoost = 0;
        for (let i = 0; i < freqs.length; i++) {
          const g = Number(eqState.bands[i] || 0);
          if (g > maxBoost) maxBoost = g;
          if (i > 0) entries += ';';
          entries += `entry(${freqs[i]},${g})`;
        }
        if (maxBoost > 0) filters.push(`volume=${(-maxBoost).toFixed(1)}dB`);
        filters.push(`firequalizer=gain_entry='${entries}'`);
      }
      // SoX resampler preferred; fall back to swr when libsoxr not compiled in.
      // FFmpeg no-ops the resample step if rate already matches.
      if (hasSoxr) {
        filters.push('aresample=resampler=soxr:precision=28:cutoff=0.96:dither_method=modified_e_weighted');
      } else {
        filters.push('aresample=resampler=swr');
      }
      a.push('-af', filters.join(','));
    }

    a.push('-f', ffmpegFormat, '-acodec', ffmpegCodec, '-ac', String(actualChannels), '-ar', String(actualSampleRate), 'pipe:1');
    return a;
  };

  // GainTransform: applies linear gain with TPDF dithering on integer formats.
  // TPDF (Triangular Probability Density Function) masks quantization noise
  // that appears when gain < 1.0 reduces effective bit depth.
  class GainTransform extends Transform {
    constructor(format, channels, linearGain, rgMeta) {
      super();
      this.format = format;
      this.channels = channels || 1;
      this.gain = Number.isFinite(linearGain) ? Math.max(0, linearGain) : 1;
      this._rgMeta = rgMeta || null;
      // LCG state for fast TPDF random generation (two independent streams)
      this._r1 = (Math.random() * 0xffffffff) >>> 0;
      this._r2 = (Math.random() * 0xffffffff) >>> 0;
      this._carry = null;
    }

    _tpdf() {
      // Two independent LCG streams, subtracted → triangular [-1, 1] distribution
      this._r1 = (this._r1 * 1664525 + 1013904223) >>> 0;
      this._r2 = (this._r2 * 22695477 + 1) >>> 0;
      return ((this._r1 >>> 16) - (this._r2 >>> 16)) / 65536.0; // [-1, 1]
    }

    _transform(chunk, encoding, callback) {
      try {
        // FFmpeg's pipe is read in arbitrary slices, so a chunk can end in the
        // middle of a sample (always possible for 24-bit). Carry the partial
        // sample over instead of scaling misaligned bytes into noise.
        if (this._carry) {
          chunk = Buffer.concat([this._carry, chunk]);
          this._carry = null;
        }
        if (this.gain === 1) {
          this.push(chunk);
          return callback();
        }

        const width = this.format === 's16le' ? 2 : this.format === 's24le' ? 3
          : (this.format === 's32le' || this.format === 'f32le') ? 4 : 1;
        const usable = chunk.length - (chunk.length % width);
        if (usable < chunk.length) this._carry = Buffer.from(chunk.subarray(usable));
        if (usable === 0) return callback();
        const src = usable === chunk.length ? chunk : chunk.subarray(0, usable);
        const out = Buffer.allocUnsafe(usable);

        if (this.format === 's16le') {
          for (let i = 0; i < usable; i += 2) {
            // TPDF dither: +/-0.5 LSB triangular noise before quantization
            let v = src.readInt16LE(i) * this.gain + this._tpdf() * 0.5;
            v = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
            out.writeInt16LE(v, i);
          }
        } else if (this.format === 'f32le') {
          for (let i = 0; i < usable; i += 4) {
            let v = src.readFloatLE(i) * this.gain;
            v = v > 1 ? 1 : v < -1 ? -1 : v;
            out.writeFloatLE(v, i);
          }
        } else if (this.format === 's32le') {
          for (let i = 0; i < usable; i += 4) {
            let v = src.readInt32LE(i) * this.gain + this._tpdf() * 0.5;
            v = v > 2147483647 ? 2147483647 : v < -2147483648 ? -2147483648 : Math.round(v);
            out.writeInt32LE(v, i);
          }
        } else if (this.format === 's24le') {
          for (let i = 0; i < usable; i += 3) {
            let s = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16);
            if (s & 0x800000) s |= 0xff000000; // sign-extend to int32
            let v = s * this.gain + this._tpdf() * 0.5;
            v = v > 0x7fffff ? 0x7fffff : v < -0x800000 ? -0x800000 : Math.round(v);
            out[i] = v & 0xff;
            out[i + 1] = (v >> 8) & 0xff;
            out[i + 2] = (v >> 16) & 0xff;
          }
        } else {
          src.copy(out);
        }

        this.push(out);
        return callback();
      } catch (err) {
        return callback(err);
      }
    }

    _flush(callback) {
      if (this._carry) { this.push(this._carry); this._carry = null; }
      callback();
    }
  }

  // Resolve total linear gain: volume × ReplayGain × preamp
  const volPct = bitPerfectOutput ? 100 : Number(options?.volume ?? 100);
  const trackRg = options?.__replaygain ?? null;
  const totalGain = bitPerfectOutput ? 1 : computeTotalGain(volPct, trackRg);

  // Connect a newly spawned process stdout into the gain → output pipeline.
  // Uses { end: false } so outputStream stays open across supervisor restarts.
  const attachPipeline = (proc) => {
    ffmpegProc = proc;

    // Clean up previous gain stream without ending outputStream
    if (currentGainStream) {
      try { currentGainStream.unpipe(); currentGainStream.destroy(); } catch {}
      currentGainStream = null;
    }

    if (!proc.stdout) return;

    proc.stdout.on('error', (err) => {
      if (err.code !== 'EPIPE') console.error('[audioEngine] stdout error:', err);
    });

    // A crashed decoder may have stopped mid-frame; realign before appending.
    if (thisSupervisor.spawnCount > 1 && outputStream && typeof outputStream.realign === 'function') outputStream.realign();

    // Keep the live volume across decoder restarts instead of the start value.
    const liveGain = bitPerfectOutput ? 1 : computeTotalGain(Number(lastOptions?.volume ?? volPct), trackRg);
    const gain = new GainTransform(ffmpegFormat, actualChannels, liveGain, trackRg);
    currentGainStream = gain;
    proc.stdout.pipe(gain).pipe(outputStream, { end: false });
  };

  // Stderr log handler shared across restarts
  const handleStderr = (data) => {
    const raw = String(data || '');
    const benignPatterns = [
      /Stream ends prematurely/i,
      /Invalid SOS parameters for sequential JPEG/i,
      /premature end of image/i,
      /premature end of data/i,
      /Skipping unsupported/i,
      /Invalid picture type/i,
      /Could not read mimetype from an attached picture/i,
    ];
    for (const msg of raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
      if (benignPatterns.some(re => re.test(msg))) {
        console.warn('[audioEngine] FFmpeg warning:', msg);
      } else if (/\berror\b/i.test(msg) || /failed/i.test(msg)) {
        console.error('[audioEngine] FFmpeg stderr:', msg);
      } else {
        console.warn('[audioEngine] FFmpeg stderr:', msg);
      }
    }
  };

  const bytesPerSec = actualSampleRate * actualChannels * (actualBitDepth / 8);
  const thisSupervisor = new FFmpegSupervisor({
    ffmpegPath: resolvedFfmpegPath,
    maxRestarts: 3,
    restartWindowMs: 30_000,
    watchdogMs: 20_000,
  });
  ffmpegSupervisor = thisSupervisor;

  thisSupervisor.on('spawned', attachPipeline);
  thisSupervisor.on('stderr', handleStderr);

  thisSupervisor.on('restarting', (restartAt) => {
    console.warn(`[audioEngine] FFmpeg restarting at ${restartAt.toFixed(2)}s after crash`);
  });

  thisSupervisor.on('crash', (code, signal) => {
    console.error(`[audioEngine] FFmpeg crashed (code=${code} signal=${signal}) — supervisor will restart`);
  });

  thisSupervisor.on('close', (code, signal) => {
    if (thisSupervisor !== ffmpegSupervisor) return;
    console.log('[audioEngine] FFmpeg exited - code:', code, 'signal:', signal);
    ffmpegProc = null;
    if (code !== 0) return; // killed by us (stop/seek/skip)

    // Natural end of the source. The decoder is done, but its last PCM may
    // still be travelling through the gain stage and the write queue. Only
    // report the end once every byte has reached the device ring, so the
    // tail is never cut and the next track can be appended gaplessly.
    const gainStream = currentGainStream;
    const finish = () => {
      if (gen !== playGeneration) return;
      if (isPaused) { pendingFinish = finish; return; } // never advance while paused
      pendingFinish = null;
      trackEnded = true;
      ffmpegSupervisor = null;
      scheduleIdleClose(gen);
      if (onEnd) onEnd();
    };
    const afterDecoderFlushed = () => {
      if (gen !== playGeneration) return;
      if (!outputStream || outputStream._closed || outputStream.destroyed) return finish();
      outputStream.write(EMPTY_CHUNK, () => finish());
    };
    if (!gainStream || gainStream.readableEnded || gainStream.destroyed) afterDecoderFlushed();
    else gainStream.once('end', afterDecoderFlushed);
  });

  thisSupervisor.on('error', (err) => {
    if (thisSupervisor !== ffmpegSupervisor) return;
    console.error('[audioEngine] FFmpeg supervisor gave up:', err.message);
    ffmpegProc = null;
    fail(err);
  });

  thisSupervisor.start(buildArgs(options.startTime || 0), {
    bytesPerSecond: bytesPerSec,
    startTime: options.startTime || 0,
    getArgs: buildArgs,
  });

  if (outputStream && typeof outputStream.on === 'function') {
    // One live handler per stream: a reused (gapless) stream must not keep
    // firing handlers that belong to tracks which already finished.
    if (outputErrorHandler) {
      try { outputStream.removeListener('error', outputErrorHandler); } catch {}
    }
    outputErrorHandler = (err) => {
      if (gen !== playGeneration) return;
      console.error('[audioEngine] output stream error:', err);
      const msg = err?.message ?? String(err);
      const asioNoCallbackStall = isAsioNoCallbackStall(msg);
      const fallbackMode = asioNoCallbackStall && options?.mode === 'asio' ? 'exclusive' : 'shared';
      const canFallback =
        options?.mode !== fallbackMode &&
        !options?.strictBitPerfect &&
        !options?.__runtimeFallbackToShared &&
        !(fallbackMode === 'exclusive' && options?.__runtimeFallbackFromAsio) &&
        /exclusive audio write stalled|exclusive audio write failed|device lost/i.test(msg);

      if (canFallback) {
        const restartAt = absolutePosition();
        const fallbackDeviceId = resolveWasapiFallbackDeviceId(options?.deviceId);
        const fallbackReason = asioNoCallbackStall ? 'asio driver started but produced zero callbacks' : 'device stopped consuming audio';
        if (asioNoCallbackStall) {
          markBackendUnhealthy(options?.deviceId, 'asio', fallbackReason, fallbackDeviceId);
        }
        console.warn(`[audioEngine] output failed during playback; retrying in ${fallbackMode} mode`, {
          requestedDeviceId: options?.deviceId || null,
          fallbackDeviceId,
          reason: fallbackReason,
        });
        stop();
        setImmediate(() => {
          playFile(filePath, onEnd, onError, {
            ...(options || {}),
            deviceId: fallbackDeviceId,
            mode: fallbackMode,
            dsdTransport: fallbackMode === 'exclusive' && options?.dsdTransport === 'native' ? 'pcm' : options?.dsdTransport,
            startTime: Number.isFinite(restartAt) ? restartAt : 0,
            __runtimeFallbackFromAsio: fallbackMode === 'exclusive' ? true : !!options?.__runtimeFallbackFromAsio,
            __runtimeFallbackToShared: fallbackMode === 'shared',
          }).catch((fallbackErr) => {
            console.error(`[audioEngine] ${fallbackMode} fallback failed:`, fallbackErr);
            if (onError) onError(fallbackErr);
          });
        });
        return;
      }
      fail(err);
    };
    outputStream.on('error', outputErrorHandler);
  }

  // A seek / EQ change issued while paused must stay paused.
  if (resumePaused) pause();
}

function stop() {
  playGeneration++;
  clearIdleClose();
  pendingFinish = null;
  trackEnded = false;
  currentStartTime = 0;
  currentCueStart = 0;
  currentDuration = 0;
  trackBaseBytes = 0;
  currentSourceInfo = null;
  currentOutputInfo = null;
  // stop any silence filler
  if (silenceInterval) {
    clearInterval(silenceInterval);
    silenceInterval = null;
  }
  if (ffmpegSupervisor) {
    try { ffmpegSupervisor.kill(); } catch {}
    ffmpegSupervisor = null;
  }
  if (ffmpegProc) {
    try { ffmpegProc.kill('SIGTERM'); } catch {}
    ffmpegProc = null;
  }
  if (currentGainStream) {
    try { currentGainStream.unpipe(); currentGainStream.destroy(); } catch {}
    currentGainStream = null;
  }

  if (currentInputStream) {
    try {
      currentInputStream.destroy();
    } catch {}
    currentInputStream = null;
  }

  if (outputStream) {
    detachOutputErrorHandler();
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
  if ((!ffmpegProc && !ffmpegSupervisor && !currentInputStream) || isPaused || trackEnded) return;

  try {
    // 1) pause native output first so it stops consuming ring
    if (outputStream && typeof outputStream.pause === 'function') {
      outputStream.pause();
    }

    // 2) pause FFmpeg stdout so decoding blocks naturally
    if (ffmpegSupervisor) {
      ffmpegSupervisor.pauseOutput();
    } else if (ffmpegProc?.stdout) {
      ffmpegProc.stdout.pause();
    }
  } catch (e) {
    console.error('[audioEngine] pause error:', e);
  }

  isPaused = true;
}

function resume() {
  // Inspect native state before deciding whether to resume. We may get into a
  // state where JS thinks we're playing (isPaused=false) but the native layer
  // is still paused, which causes the ring buffer to stay full and hiss.
  const stats = (() => {
    try {
      return outputStream && exclusiveAudio?.getStats
        ? exclusiveAudio.getStats(outputStream.handle)
        : null;
    } catch {
      return null;
    }
  })();
  const nativePaused = !!(stats && stats.paused);
  if (stats) {
    console.log('[audioEngine] native stats before resume:', stats);
  }

  // If decoder died while paused/stalled, restart from current position so
  // resume doesn't unpause a drained ring with no producer.
  if (trackEnded) return; // finished; the next track (if any) is already on its way
  if (!ffmpegProc && !ffmpegSupervisor && !currentInputStream && currentFile) {
    isPaused = false;
    restartCurrent(absolutePosition()).catch((e) => {
      console.error('[audioEngine] resume restart failed:', e);
    });
    return;
  }

  // If we have no process AND native is not paused, nothing to do.
  if (!ffmpegProc && !ffmpegSupervisor && !nativePaused) return;

  try {
    // IMPORTANT ORDER:
    // 1) resume output first (so ring can drain again)
    if (outputStream && typeof outputStream.resume === 'function') {
      outputStream.resume();
    }

    // 2) then resume FFmpeg stdout
    if (ffmpegSupervisor) {
      ffmpegSupervisor.resumeOutput();
    } else if (ffmpegProc?.stdout) {
      ffmpegProc.stdout.resume();
    }
  } catch (e) {
    console.error('[audioEngine] resume error:', e);
  }

  isPaused = false;

  // The decoder may have finished while we were paused.
  if (pendingFinish) {
    const finish = pendingFinish;
    pendingFinish = null;
    finish();
  }

  // Confirm native resumed (helps diagnose devices that stay paused)
  try {
    const after = outputStream && exclusiveAudio?.getStats
      ? exclusiveAudio.getStats(outputStream.handle)
      : null;
    if (after) console.log('[audioEngine] native stats after resume:', after);
  } catch {}
}


function getStatus() {
  let nativeStats = null;
  try {
    nativeStats = outputStream && exclusiveAudio?.getStats ? exclusiveAudio.getStats(outputStream.handle) : null;
  } catch {}
  const output = currentOutputInfo ? { ...currentOutputInfo, ...(nativeStats || {}) } : (nativeStats || null);
  if (output && currentOutputInfo?.fallback) {
    output.fallback = true;
    output.fallbackReason = currentOutputInfo.fallbackReason || output.fallbackReason || '';
  }
  return {
    exclusiveAvailable: !!exclusiveAudio,
    exclusiveLoadError,
    playing: !!currentFile && !trackEnded,
    ended: trackEnded,
    duration: currentDuration || 0,
    paused: !!isPaused,
    currentFile: currentFile || null,
    currentTime: getTime(),
    volume: (lastOptions && Number.isFinite(lastOptions.volume)) ? lastOptions.volume : 100,
    source: currentSourceInfo,
    output,
    options: {
      deviceId: lastOptions?.deviceId || null,
      mode: lastOptions?.mode || null,
      sampleRatePolicy: lastOptions?.sampleRatePolicy || null,
      dsdTransport: lastOptions?.dsdTransport || null,
      bitPerfect: !!lastOptions?.bitPerfect,
      strictBitPerfect: !!lastOptions?.strictBitPerfect,
      backendHealthBypass: lastOptions?.__backendHealthBypass || null,
    },
    backendHealth: getBackendHealthSnapshot(),
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


function backendHealthKey(deviceId, mode) {
  return `${String(mode || '').toLowerCase()}::${String(deviceId || '')}`;
}

function getBackendHealthSnapshot() {
  return Array.from(backendHealth.values()).map((entry) => ({ ...entry }));
}

function markBackendUnhealthy(deviceId, mode, reason, fallbackDeviceId = null) {
  if (!deviceId || !mode) return;
  backendHealth.set(backendHealthKey(deviceId, mode), {
    deviceId,
    mode,
    healthy: false,
    reason: reason || 'backend failed',
    fallbackDeviceId: fallbackDeviceId || null,
    fallbackMode: mode === 'asio' ? 'exclusive' : 'shared',
    markedAt: new Date().toISOString(),
  });
}

function getBackendHealth(deviceId, mode) {
  return backendHealth.get(backendHealthKey(deviceId, mode)) || null;
}

function routePlaybackOptionsForBackendHealth(options = {}) {
  const requestedMode = options?.mode || 'exclusive';
  const health = getBackendHealth(options?.deviceId, requestedMode);
  if (!health || health.healthy !== false || options?.__ignoreBackendHealth) {
    return options || {};
  }

  const fallbackMode = health.fallbackMode || (requestedMode === 'asio' ? 'exclusive' : 'shared');
  const fallbackDeviceId = health.fallbackDeviceId || resolveWasapiFallbackDeviceId(options?.deviceId);
  return {
    ...(options || {}),
    deviceId: fallbackDeviceId,
    mode: fallbackMode,
    dsdTransport: fallbackMode === 'exclusive' && options?.dsdTransport === 'native' ? 'pcm' : options?.dsdTransport,
    __runtimeFallbackFromAsio: fallbackMode === 'exclusive' && requestedMode === 'asio' ? true : !!options?.__runtimeFallbackFromAsio,
    __runtimeFallbackToShared: fallbackMode === 'shared' ? true : !!options?.__runtimeFallbackToShared,
    __backendHealthBypass: {
      requestedDeviceId: options?.deviceId || null,
      requestedMode,
      fallbackDeviceId,
      fallbackMode,
      reason: health.reason,
    },
  };
}
function normalizeDeviceNameForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^\s*\[asio\]\s*/i, '')
    .replace(/\basio\b/g, ' ')
    .replace(/\bwasapi\b/g, ' ')
    .replace(/\bshared\b|\bexclusive\b/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isAsioNoCallbackStall(message) {
  const text = String(message || '');
  return /exclusive audio write stalled/i.test(text) &&
    /"backend":"asio"/.test(text) &&
    /"asioCallbacks":0\b/.test(text);
}
function resolveWasapiFallbackDeviceId(deviceId) {
  const requestedId = String(deviceId || '');
  if (!requestedId.startsWith('asio:')) {
    return deviceId || null;
  }

  const devices = getDevices();
  const asioDevice = devices.find((d) => String(d?.id || '') === requestedId);
  const asioNeedle = normalizeDeviceNameForMatch(asioDevice?.name || requestedId.replace(/^asio:/i, ''));
  if (!asioNeedle) {
    return null;
  }

  let best = null;
  let bestScore = 0;
  for (const device of devices) {
    const candidateId = String(device?.id || '');
    if (!candidateId || candidateId.startsWith('asio:')) continue;

    const candidateName = normalizeDeviceNameForMatch(device?.name || candidateId);
    if (!candidateName) continue;

    let score = 0;
    if (candidateName === asioNeedle) {
      score = 100;
    } else if (candidateName.includes(asioNeedle) || asioNeedle.includes(candidateName)) {
      score = 80;
    } else {
      const asioTokens = asioNeedle.split(' ').filter((token) => token.length > 1);
      const matches = asioTokens.filter((token) => candidateName.includes(token)).length;
      score = matches * 10;
    }

    if (score > bestScore) {
      best = device;
      bestScore = score;
    }
  }

  return bestScore >= 20 ? best.id : null;
}
function openAsioControlPanel(options = {}) {
  if (!exclusiveAudio || typeof exclusiveAudio.openAsioControlPanel !== 'function') {
    throw new Error('ASIO control panel is not available');
  }
  return exclusiveAudio.openAsioControlPanel(options);
}

function getTime() {
  const t = absolutePosition() - currentCueStart;
  if (!Number.isFinite(t) || t < 0) return 0;
  return currentDuration > 0 ? Math.min(t, currentDuration) : t;
}

function seek(time) {
  if (!currentFile || trackEnded) return;
  const rel = Math.max(0, Number(time) || 0);
  const target = currentDuration > 0 ? Math.min(rel, Math.max(0, currentDuration - 0.25)) : rel;
  console.log('[audioEngine] seeking to', target);
  // Keep the device open when its buffer is short enough that the leftover
  // audio is inaudible; otherwise reopen for an instant cut.
  let reuse = false;
  try {
    const stats = outputStream && exclusiveAudio?.getStats ? exclusiveAudio.getStats(outputStream.handle) : null;
    reuse = !!stats && Number(stats.ringDurationMs) > 0 && Number(stats.ringDurationMs) <= 260;
  } catch {}
  restartCurrent(target + currentCueStart, { __reuseOutput: reuse }).catch((e) => {
    console.error('[audioEngine] seek failed:', e);
  });
}

const audioEngineApi = {
  playFile,
  stop,
  pause,
  resume,
  getStatus,
  getDevices,
  openAsioControlPanel,
  getTime,
  setVolume,
  setPreamp,
  setReplayGainMode,
  seek,
  setEQ,
  getEQ,
  getPreamp: () => preampDb,
  getReplayGainMode: () => replayGainMode,
};

export default audioEngineApi;
