// exclusiveAudio.js
import { Writable } from 'stream';
import bindings from 'bindings';

const native = bindings('exclusive_audio'); // loads build/Release/exclusive_audio.node

class ExclusiveStream extends Writable {
  constructor(handleOrOptions) {
    super({ highWaterMark: 0 });
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
    // console.log('[ExclusiveStream] _write chunk len:', chunk.length);
    if (this._closed) return callback();

    let offset = 0;

    const tryWrite = () => {
      if (this._closed) return callback();
      try {
        // native.write returns number of bytes written, or -1 on error
        const toWrite = chunk.subarray(offset);
        const written = native.write(this.handle, toWrite);
        
        if (written < 0) {
           return callback(new Error('exclusive audio write failed'));
        }

        offset += written;
        this.totalBytesWritten += written;
        if (offset >= chunk.length) {
          callback();
        } else {
          // Buffer full, retry shortly
          // console.log('[ExclusiveStream] buffer full, retrying...');
          setTimeout(tryWrite, 5);
        }
      } catch (err) {
        console.error('[ExclusiveStream] write error:', err);
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
      if (!this._closed) {
      try {
        native.close(this.handle);
      } catch (_) {
        // ignore
      }
      this._closed = true;
    }
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
