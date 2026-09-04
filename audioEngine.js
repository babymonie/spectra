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
    const cueOptions = { ...options };
    if (Number.isFinite(cueSec)) cueOptions.startTime = cueSec;
    if (Number.isFinite(cueEnd)) cueOptions.__cueEndSec = cueEnd;
    return playFile(audioFile, onEnd, onError, cueOptions);
  }

  options = applyEqPlaybackCompatibility(routePlaybackOptionsForBackendHealth(options));
  try {
    const startAt = Number(options?.startTime ?? 0);
    const trackPath = options?.track?.path;
    const currentTrackPath = lastOptions?.track?.path;
    const sameByTrack = trackPath && currentTrackPath && trackPath === currentTrackPath;
    const sameByFile = currentFile && filePath && currentFile === filePath;
    const sameFile = ffmpegProc && (sameByTrack || sameByFile);
    const outputChanged = hasOutputOptionDelta(options, lastOptions);
    if (sameFile && startAt < 0.05 && !outputChanged) {
      console.log('[audioEngine] playFile dedup: already playing this file, ignoring duplicate request');
      return;
    }
  } catch {}

  // Gapless mode: reuse existing outputStream if format will match, only kill decoder.
  const wantGapless = options.gapless === true && outputStream && !outputStream._closed;
  if (wantGapless) {
    // Stop only the decoder, keep outputStream alive
    if (ffmpegSupervisor) { try { ffmpegSupervisor.kill(); } catch {} ffmpegSupervisor = null; }
    if (ffmpegProc) { try { ffmpegProc.kill('SIGTERM'); } catch {} ffmpegProc = null; }
    if (currentGainStream) { try { currentGainStream.unpipe(); currentGainStream.destroy(); } catch {} currentGainStream = null; }
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
    currentStartTime = 0;
  } else {
    stop();
  }

  try {
    console.log('[audioEngine] playFile called for', filePath, wantGapless ? '(gapless)' : '');
  } catch {}
  currentStartTime = options.startTime || 0;

  currentFile = filePath;
  lastOnEnd = onEnd;
  lastOnError = onError;
  lastOptions = options;
  isPaused = false;

  let meta;
  try {
    // Use native:true to get gapless + RG tags when available
    meta = await parseFile(filePath, { native: true });
  } catch {
    meta = {};
  }

  // Extract ReplayGain from parsed tags and store for gain computation
  const metaCommon = meta?.common || {};
  const metaNative = meta?.native || {};
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
  // Pass RG into options so attachPipeline and computeTotalGain can use it
  options = { ...options, __replaygain: trackRgMeta };
  const fmt = meta?.format || {};
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

  // For gapless: check if existing outputStream format matches next track.
  // If it matches, reuse it; otherwise fall through to open a new one.
  let gaplessReused = false;
  if (wantGapless && outputStream && !outputStream._closed) {
    const fmtOk =
      (outputStream.actualSampleRate || 0) === sampleRate &&
      (outputStream.actualChannels || 0) === channels &&
      (outputStream.actualBitDepth || 0) === bitDepth;
    if (fmtOk) {
      gaplessReused = true;
      console.log('[audioEngine] gapless: reusing outputStream (format match)');
    } else {
      console.log('[audioEngine] gapless: format mismatch, reopening outputStream');
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
      if (onError) onError(err);
      return;
    }
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
    if (onError) onError(err);
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
      // SoX resampler: high-quality SRC + dithering for bit-depth reduction.
      // FFmpeg no-ops the resample step if rate already matches.
      filters.push('aresample=resampler=soxr:precision=28:cutoff=0.96:dither_method=modified_e_weighted');
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
    }

    _tpdf() {
      // Two independent LCG streams, subtracted → triangular [-1, 1] distribution
      this._r1 = (this._r1 * 1664525 + 1013904223) >>> 0;
      this._r2 = (this._r2 * 22695477 + 1) >>> 0;
      return ((this._r1 >>> 16) - (this._r2 >>> 16)) / 65536.0; // [-1, 1]
    }

    _transform(chunk, encoding, callback) {
      try {
        if (this.gain === 1) {
          this.push(chunk);
          return callback();
        }

        if (this.format === 's16le') {
          const out = Buffer.allocUnsafe(chunk.length);
          for (let i = 0; i + 1 < chunk.length; i += 2) {
            const s = chunk.readInt16LE(i);
            // TPDF dither: ±0.5 LSB triangular noise before quantization
            let v = s * this.gain + this._tpdf() * 0.5;
            v = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
            out.writeInt16LE(v, i);
          }
          this.push(out);
          return callback();
        }

        if (this.format === 'f32le') {
          const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.length);
          const out = Buffer.allocUnsafe(chunk.length);
          for (let i = 0; i + 3 < chunk.length; i += 4) {
            let v = view.getFloat32(i, true) * this.gain;
            v = v > 1 ? 1 : v < -1 ? -1 : v;
            out.writeFloatLE(v, i);
          }
          this.push(out);
          return callback();
        }

        if (this.format === 's32le') {
          const out = Buffer.allocUnsafe(chunk.length);
          for (let i = 0; i + 3 < chunk.length; i += 4) {
            const s = chunk.readInt32LE(i);
            let v = s * this.gain + this._tpdf() * 0.5;
            v = v > 2147483647 ? 2147483647 : v < -2147483648 ? -2147483648 : Math.round(v);
            out.writeInt32LE(v, i);
          }
          this.push(out);
          return callback();
        }

        if (this.format === 's24le') {
          const out = Buffer.allocUnsafe(chunk.length);
          for (let i = 0; i + 2 < chunk.length; i += 3) {
            let s = chunk[i] | (chunk[i + 1] << 8) | (chunk[i + 2] << 16);
            if (s & 0x800000) s |= 0xff000000; // sign-extend to int32
            let v = s * this.gain + this._tpdf() * 0.5;
            v = v > 0x7fffff ? 0x7fffff : v < -0x800000 ? -0x800000 : Math.round(v);
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

    const gain = new GainTransform(ffmpegFormat, actualChannels, totalGain, trackRg);
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
    console.log('[audioEngine] FFmpeg exited — code:', code, 'signal:', signal);
    ffmpegProc = null;
    if (!isPaused && onEnd && code === 0) onEnd();
  });

  thisSupervisor.on('error', (err) => {
    if (thisSupervisor !== ffmpegSupervisor) return;
    console.error('[audioEngine] FFmpeg supervisor gave up:', err.message);
    ffmpegProc = null;
    if (onError) onError(err);
    stop();
  });

  thisSupervisor.start(buildArgs(options.startTime || 0), {
    bytesPerSecond: bytesPerSec,
    startTime: options.startTime || 0,
    getArgs: buildArgs,
  });

  if (outputStream && typeof outputStream.on === 'function') {
    outputStream.on('error', (err) => {
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
        const restartAt = getTime();
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
      if (onError) onError(err);
      stop();
    });
  }
}

function stop() {
  currentStartTime = 0;
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
  if ((!ffmpegProc && !ffmpegSupervisor && !currentInputStream) || isPaused) return;

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
  if (!ffmpegProc && !ffmpegSupervisor && currentFile) {
    const restartAt = getTime();
    playFile(currentFile, lastOnEnd, lastOnError, {
      ...(lastOptions || {}),
      startTime: Number.isFinite(restartAt) ? restartAt : 0,
    }).catch((e) => {
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

  // Confirm native resumed (helps diagnose devices that stay paused)
  try {
    const after = exclusiveAudio?.getStats
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
    playing: !!(ffmpegProc || currentInputStream || outputStream),
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
