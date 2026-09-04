import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * FFmpegSupervisor: managed FFmpeg subprocess with auto-restart on crash.
 *
 * Events:
 *   spawned(proc)           - new process started (initial + restarts)
 *   stderr(data)            - raw stderr Buffer from FFmpeg
 *   restarting(restartAt)   - about to restart; restartAt is seconds into track
 *   crash(code, signal)     - unexpected exit (before restart attempt)
 *   proc-error(err)         - spawn-level error (before restart attempt)
 *   close(code, signal)     - deliberate kill or clean end (no restart)
 *   error(err)              - max restarts exceeded; playback must stop
 */
export class FFmpegSupervisor extends EventEmitter {
  constructor({ ffmpegPath, maxRestarts = 3, restartWindowMs = 30_000, watchdogMs = 20_000 } = {}) {
    super();
    this._ffmpegPath = ffmpegPath;
    this._maxRestarts = maxRestarts;
    this._restartWindowMs = restartWindowMs;
    this._watchdogMs = watchdogMs;
    this._proc = null;
    this._killed = false;
    this._watchdogTimer = null;
    this._restartTimes = [];
    this._bytesOutput = 0;
    this._bytesPerSecond = 0;
    this._startTime = 0;
    this._getArgs = null;
  }

  get currentProc() { return this._proc; }
  get bytesOutput() { return this._bytesOutput; }

  /**
   * @param {string[]} args - initial FFmpeg args
   * @param {object} opts
   * @param {number} opts.bytesPerSecond - decoded bytes/sec (for position tracking)
   * @param {number} opts.startTime - seek offset of first spawn (seconds)
   * @param {function} opts.getArgs - fn(restartAt: number) => string[] for restarts
   */
  start(args, { bytesPerSecond = 0, startTime = 0, getArgs } = {}) {
    this._killed = false;
    this._bytesOutput = 0;
    this._bytesPerSecond = bytesPerSecond;
    this._startTime = startTime;
    this._getArgs = getArgs || (() => args);
    this._restartTimes = [];
    this._doSpawn(args);
  }

  _doSpawn(args) {
    if (this._killed) return;
    const proc = spawn(this._ffmpegPath, args);
    this._proc = proc;
    this._resetWatchdog();

    proc.stdout?.on('data', (chunk) => {
      this._bytesOutput += chunk.length;
      this._resetWatchdog();
    });

    proc.stderr?.on('data', (data) => this.emit('stderr', data));

    proc.on('error', (err) => {
      if (proc !== this._proc) return;
      this._clearWatchdog();
      this.emit('proc-error', err);
      this._tryRestart(err);
    });

    proc.on('close', (code, signal) => {
      if (proc !== this._proc) return;
      this._clearWatchdog();
      const killedByUs = this._killed || signal === 'SIGTERM' || code === 255;
      if (killedByUs || code === 0) {
        this.emit('close', code, signal);
        return;
      }
      this.emit('crash', code, signal);
      this._tryRestart(new Error(`FFmpeg exited with code ${code}`));
    });

    this.emit('spawned', proc);
  }

  _tryRestart(reason) {
    if (this._killed) return;
    const now = Date.now();
    this._restartTimes = this._restartTimes.filter(t => now - t < this._restartWindowMs);
    if (this._restartTimes.length >= this._maxRestarts) {
      this.emit('error', new Error(
        `FFmpeg crashed ${this._maxRestarts}x in ${this._restartWindowMs}ms: ${reason?.message ?? reason}`
      ));
      return;
    }
    this._restartTimes.push(now);
    const elapsedSec = this._bytesPerSecond > 0 ? this._bytesOutput / this._bytesPerSecond : 0;
    const restartAt = this._startTime + elapsedSec;
    console.warn(`[FFmpegSupervisor] crash #${this._restartTimes.length}/${this._maxRestarts}, restarting at ${restartAt.toFixed(2)}s`);
    this.emit('restarting', restartAt);
    setTimeout(() => { if (!this._killed) this._doSpawn(this._getArgs(restartAt)); }, 250);
  }

  _resetWatchdog() {
    this._clearWatchdog();
    if (this._watchdogMs <= 0) return;
    this._watchdogTimer = setTimeout(() => {
      if (this._killed || !this._proc) return;
      console.warn(`[FFmpegSupervisor] watchdog: no output for ${this._watchdogMs}ms, restarting`);
      try { this._proc.kill('SIGTERM'); } catch {}
      this._tryRestart(new Error('watchdog timeout'));
    }, this._watchdogMs);
  }

  _clearWatchdog() {
    if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
  }

  kill(signal = 'SIGTERM') {
    this._killed = true;
    this._clearWatchdog();
    if (this._proc) {
      try { this._proc.kill(signal); } catch {}
      this._proc = null;
    }
  }

  pauseOutput() { this._proc?.stdout?.pause(); }
  resumeOutput() { this._proc?.stdout?.resume(); }
}
