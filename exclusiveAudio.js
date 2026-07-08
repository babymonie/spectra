// exclusiveAudio.js
import { Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import bindings from 'bindings';

// Attempt to load the native addon using the usual bindings helper first.
// If that fails (packaged app / asar-unpacked layout), fall back to common
// unpacked paths under `process.resourcesPath` (app.asar.unpacked) and `bin/`.
let native = null;
try {
  native = bindings('exclusive_audio'); // typical dev load: build/Release/exclusive_audio.node
} catch (e) {
  // Fallback loader for packaged apps and prebuilt bin folders
  try {
    const require = createRequire(import.meta.url);
    const resourcesPath = process.resourcesPath || path.join(process.cwd(), 'resources');
    const candidates = [
      path.join(resourcesPath, 'app.asar.unpacked', 'build', 'Release', 'exclusive_audio.node'),
      path.join(resourcesPath, 'app.asar.unpacked', 'build', 'default', 'exclusive_audio.node'),
      path.join(resourcesPath, 'app.asar.unpacked', 'bin', 'spectra.node'),
      path.join(resourcesPath, 'app.asar.unpacked', 'bin'),
      path.join(process.cwd(), 'bin'),
      path.join(process.cwd(), 'build', 'Release', 'exclusive_audio.node'),
    ];

    // Expand candidates by searching any .node under known bin directories
    const tryCandidates = [];
    for (const c of candidates) tryCandidates.push(c);

    const walkNodeFiles = (dir, out) => {
      try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walkNodeFiles(p, out);
          else if (entry.isFile() && p.endsWith('.node')) out.push(p);
        }
      } catch (walkErr) {
        console.warn('[exclusiveAudio] bin walk error:', walkErr?.message ?? walkErr);
      }
    };

    // Packaged path
    walkNodeFiles(path.join(resourcesPath, 'app.asar.unpacked', 'bin'), tryCandidates);
    // Development path (bin/win32-x64-NNN/spectra.node etc.)
    walkNodeFiles(path.join(process.cwd(), 'bin'), tryCandidates);

    for (const cand of tryCandidates) {
      try {
        if (fs.existsSync(cand)) {
          native = require(cand);
          console.log('[exclusiveAudio] loaded native addon from', cand);
          break;
        }
      } catch (err) {
        // ignore and try next
      }
    }
  } catch (fallbackErr) {
    // final fallback: leave native null and allow consumer to handle unsupported platform
    console.warn('[exclusiveAudio] native addon load failed:', fallbackErr?.message ?? e?.message ?? String(fallbackErr));
  }
}

if (!native) {
  // If native is still null, create a dummy object that throws on use to make errors clearer
  native = {
    isSupported: () => false,
    openOutput: () => { throw new Error('native addon not loaded'); },
    write: () => { throw new Error('native addon not loaded'); },
    drain: () => {},
    close: () => {},
  };
}

class ExclusiveStream extends Writable {
  constructor(handleOrOptions) {
    super({ highWaterMark: 0 }); // We handle backpressure manually via native.write
    this._handle = 0;
    this._closed = false;
    this._pendingWrites = 0;

    let opts = {};
    if (typeof handleOrOptions === 'object') {
      opts = handleOrOptions || {};
    }

    this.deviceId = opts.deviceId || null;
    this.sampleRate = opts.sampleRate || 44100;
    this.channels = opts.channels || 2;
    this.bitDepth = opts.bitDepth || 32;
    this.mode = opts.mode || 'shared';
    const parsedBufferMs = Number(opts.bufferMs);
    this.bufferMs = Number.isFinite(parsedBufferMs) && parsedBufferMs > 0 ? parsedBufferMs : 0;
    this.bufferFrames = Number.isFinite(Number(opts.bufferFrames)) ? Number(opts.bufferFrames) : 0;
    this.bitPerfect = !!opts.bitPerfect;
    this.strictBitPerfect = !!opts.strictBitPerfect;
    this.dsdNative = !!opts.dsdNative;
    this.windowHandle = opts.windowHandle || null;

    const result = native.openOutput({
      deviceId: this.deviceId,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitDepth: this.bitDepth,
      mode: this.mode,
      bufferMs: this.bufferMs,
      bufferFrames: this.bufferFrames,
      bitPerfect: this.bitPerfect,
      strictBitPerfect: this.strictBitPerfect,
      dsdNative: this.dsdNative,
      windowHandle: this.windowHandle,
    });

    this.handle = result.handle;
    this.actualSampleRate = result.sampleRate;
    this.actualChannels = result.channels;
    this.actualBitDepth = result.bitDepth;
    this.actualSampleFormat = result.sampleFormat || (
      this.actualBitDepth === 32 ? 'f32le' : `s${this.actualBitDepth}le`
    );
    this.actualBufferFrames = result.bufferFrames || 0;
    this.actualBufferMs = result.bufferMs || 0;
    this.actualBackend = result.backend || this.mode;
    this.fallback = !!result.fallback;
    this.fallbackReason = result.fallbackReason || '';
    this.totalBytesWritten = 0;
    
    console.log(`[ExclusiveStream] Opened: handle=${this.handle}, backend=${this.actualBackend}, rate=${this.actualSampleRate}, ch=${this.actualChannels}, format=${this.actualSampleFormat}, buffer=${this.actualBufferFrames || 0} frames`);
  }

  getElapsedTime() {
    if (!this.actualSampleRate || !this.actualChannels || !this.actualBitDepth) return 0;
    const bytesPerSample = this.actualBitDepth / 8;
    const bytesPerFrame = this.actualChannels * bytesPerSample;
    const bytesPerSecond = this.actualSampleRate * bytesPerFrame;
    if (bytesPerSecond === 0) return 0;
    const queuedSeconds = this.totalBytesWritten / bytesPerSecond;
    // Subtract buffered-but-not-yet-played latency so the reported position
    // tracks actual playback rather than bytes enqueued.
    try {
      const stats = native.getStats(this.handle);
      if (stats) {
        const latencySec = ((stats.ringLatencyMs || 0) + (stats.hardwareLatencyMs || 0)) / 1000;
        return Math.max(0, queuedSeconds - latencySec);
      }
    } catch (statsErr) {
      // Non-fatal: fall back to queued-bytes estimate
      console.warn('[ExclusiveStream] getStats failed in getElapsedTime:', statsErr?.message ?? statsErr);
    }
    return queuedSeconds;
  }
_write(chunk, encoding, callback) {
  if (this._closed) return callback();

  let doneCalled = false;
  const zeroWriteStartedAt = Date.now();
  let zeroWriteCount = 0;
  const done = (err) => {
    if (doneCalled) return;
    doneCalled = true;
    callback(err);
  };

  // Retry until all bytes are written or stream closes.
  const writeFrom = (offset) => {
    if (this._closed) return done();
    const slice = offset === 0 ? chunk : chunk.slice(offset);
    try {
      native.writeAsync(this.handle, slice, (err, written) => {
        if (this._closed) return done();
        if (err) {
          this._closeNative();
          return done(new Error(err));
        }
        if (written < 0) {
          this._closeNative();
          return done(new Error('exclusive audio write failed (device lost?)'));
        }
        if (written === 0) {
          // If output is paused, zero-byte writes are expected while the ring
          // is intentionally not draining.
          try {
            const stats = native.getStats ? native.getStats(this.handle) : null;
            if (stats && stats.paused) {
              setTimeout(() => writeFrom(offset), 20);
              return;
            }
          } catch {}

          zeroWriteCount += 1;
          const stalledMs = Date.now() - zeroWriteStartedAt;
          if (stalledMs > 2500 || zeroWriteCount > 400) {
            let stallStats = null;
            try {
              stallStats = native.getStats ? native.getStats(this.handle) : null;
            } catch {}
            const detail = stallStats ? `; stats=${JSON.stringify(stallStats)}` : '';
            this._closeNative();
            return done(new Error(`exclusive audio write stalled (device not consuming audio)${detail}`));
          }
          // Ring is full for now, retry same offset shortly.
          setTimeout(() => writeFrom(offset), 5);
          return;
        }
        zeroWriteCount = 0;
        this.totalBytesWritten += written;
        const next = offset + written;
        if (next < chunk.length) {
          // Partial write - retry remaining bytes.
          writeFrom(next);
        } else {
          done();
        }
      }, true);
    } catch (e) {
      try { this._closeNative(); } catch {}
      done(e instanceof Error ? e : new Error(String(e)));
    }
  };

  writeFrom(0);
}

  _final(callback) {
    console.log('[ExclusiveStream] _final called');
    if (this._closed) return callback();

    try {
      native.drain(this.handle);
    } catch (e) {
      console.error('[ExclusiveStream] drain error:', e);
    }
    this._closeNative();
    callback();
  }

  _closeNative() {
    if (this._closed) return;
    try {
      if (this.handle) native.close(this.handle);
    } catch (_) {
      // ignore
    }
    this._closed = true;
  }

  pause() {
    if (this._closed) return;
    try {
      if (native.pause) native.pause(this.handle);
    } catch (e) {
      console.error('[ExclusiveStream] pause error:', e);
    }
  }

  resume() {
    if (this._closed) return;
    try {
      if (native.resume) native.resume(this.handle);
    } catch (e) {
      console.error('[ExclusiveStream] resume error:', e);
    }
  }

  _destroy(err, callback) {
    console.log('[ExclusiveStream] _destroy called', err);
    this._closeNative();
    callback(err);
  }
}

function createExclusiveStream(options) {
  return new ExclusiveStream(options);
}

function getDevices() {
  try {
    const devs = native.getDevices() || [];
    const seen = new Set();
    const out = [];
    for (const d of devs) {
      if (!d || !d.id) continue;
      const key = String(d.id).trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  } catch (e) {
    return [];
  }
}

function isSupported() {
  try {
    return !!native.isSupported && native.isSupported();
  } catch {
    return false;
  }
}

function openOutput(options) {
  return native.openOutput(options);
}

function write(handle, buffer, blocking = false) {
  return native.write(handle, buffer, blocking);
}

function drain(handle) {
  return native.drain(handle);
}

function close(handle) {
  return native.close(handle);
}
function getStats(handle) {
  return native.getStats(handle);
}

function openAsioControlPanel(options = {}) {
  if (!native.openAsioControlPanel) {
    throw new Error("ASIO control panel is not supported by this native addon");
  }
  return native.openAsioControlPanel(options);
}
export default {
  createExclusiveStream,
  getDevices,
  isSupported,
  openOutput,
  write,
  drain,
  close,
  getStats,
  openAsioControlPanel,
};
