import { EventEmitter } from 'node:events';

/**
 * DeviceMonitor: polls audio device list for hot-plug changes (PnP).
 *
 * Events:
 *   device-added(device)    - new device appeared
 *   device-removed(device)  - device disconnected
 *   changed(added, removed) - batch update: arrays of added/removed devices
 */
export class DeviceMonitor extends EventEmitter {
  constructor({ getDevices, pollMs = 2000 } = {}) {
    super();
    this._getDevices = getDevices;
    this._pollMs = pollMs;
    this._timer = null;
    this._knownDevices = new Map(); // id → device
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._snapshot(); // populate initial state without emitting
    this._schedule();
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _schedule() {
    if (!this._running) return;
    this._timer = setTimeout(() => { this._poll(); }, this._pollMs);
  }

  _snapshot() {
    try {
      const devices = this._getDevices() || [];
      this._knownDevices.clear();
      for (const d of devices) {
        if (d?.id) this._knownDevices.set(String(d.id), d);
      }
    } catch {}
  }

  _poll() {
    if (!this._running) return;
    try {
      const current = new Map();
      for (const d of (this._getDevices() || [])) {
        if (d?.id) current.set(String(d.id), d);
      }

      const added = [];
      const removed = [];

      for (const [id, d] of current) {
        if (!this._knownDevices.has(id)) added.push(d);
      }
      for (const [id, d] of this._knownDevices) {
        if (!current.has(id)) removed.push(d);
      }

      this._knownDevices = current;

      if (added.length || removed.length) {
        for (const d of added) this.emit('device-added', d);
        for (const d of removed) this.emit('device-removed', d);
        this.emit('changed', added, removed);
      }
    } catch (err) {
      console.warn('[DeviceMonitor] poll error:', err?.message ?? err);
    }
    this._schedule();
  }

  getKnownDevices() {
    return Array.from(this._knownDevices.values());
  }
}
