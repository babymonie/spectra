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

    // Expand candidates by searching any .node under bin directories
    const tryCandidates = [];
    for (const c of candidates) tryCandidates.push(c);
    const binDir = path.join(resourcesPath, 'app.asar.unpacked', 'bin');
    if (fs.existsSync(binDir) && fs.statSync(binDir).isDirectory()) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.isFile() && p.endsWith('.node')) tryCandidates.push(p);
        }
      };
      try { walk(binDir); } catch (_) {}
    }

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
  } catch (err) {
    // final fallback: leave native null and allow consumer to handle unsupported platform
    console.warn('[exclusiveAudio] native addon load failed:', (err && err.message) || (e && e.message));
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
    this.bufferMs = opts.bufferMs || 250;
    this.bitPerfect = !!opts.bitPerfect;
    this.strictBitPerfect = !!opts.strictBitPerfect;

    const result = native.openOutput({
      deviceId: this.deviceId,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitDepth: this.bitDepth,
      mode: this.mode,
      bufferMs: this.bufferMs,
      bitPerfect: this.bitPerfect,
      strictBitPerfect: this.strictBitPerfect,
    });

    this.handle = result.handle;
    this.actualSampleRate = result.sampleRate;
    this.actualChannels = result.channels;
    this.actualBitDepth = result.bitDepth;
    this.totalBytesWritten = 0;
    
    console.log(`[ExclusiveStream] Opened: handle=${this.handle}, rate=${this.actualSampleRate}, ch=${this.actualChannels}, depth=${this.actualBitDepth}`);
  }

  getElapsedTime() {
    if (!this.actualSampleRate || !this.actualChannels || !this.actualBitDepth) return 0;
    const bytesPerSample = this.actualBitDepth / 8;
    const bytesPerFrame = this.actualChannels * bytesPerSample;
    const bytesPerSecond = this.actualSampleRate * bytesPerFrame;
    if (bytesPerSecond === 0) return 0;
    return this.totalBytesWritten / bytesPerSecond;
  }

  _write(chunk, encoding, callback) {
    if (this._closed) return callback();

    let offset = 0;

    const tryWrite = () => {
      // Vital check: if stream was closed while waiting for setTimeout, abort immediately
      if (this._closed) return callback();

      try {
        const toWrite = chunk.subarray(offset);
        // Returns number of bytes written, or -1 on error (e.g. device lost)
        const written = native.write(this.handle, toWrite);
        
        if (written < 0) {
           this._closeNative();
           return callback(new Error('exclusive audio write failed (device lost?)'));
        }

        offset += written;
        this.totalBytesWritten += written;
        
        if (offset >= chunk.length) {
          callback();
        } else {
          // Buffer full, retry shortly. 5ms is aggressive but okay for low latency.
          setTimeout(tryWrite, 5);
        }
      } catch (err) {
        console.error('[ExclusiveStream] write error:', err);
        // If native call throws, assume fatal error
        this._closeNative();
        callback(err);
      }
    };

    tryWrite();
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

export default {
  createExclusiveStream,
  getDevices,
  isSupported,
  openOutput,
  write,
  drain,
  close,
};
