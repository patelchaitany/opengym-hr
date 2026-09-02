// A fake heart-rate monitor with the same interface as HeartRateMonitor.
//
// Why this exists: the interesting half of this project is what the gym app
// does with a heart rate, and none of that should need a charged strap, a
// paired device and a machine with a Bluetooth radio to work on. Swap the
// monitor for this one (`HR_SIMULATE=1`) and everything downstream — the
// WebSocket, the range queries, the per-set capture in openGym, the zone
// maths, the finish summary — runs exactly as it does for real.
//
// It is not noise dressed up as a pulse. It walks a lifting session: a resting
// baseline, a fast climb while a set is under way, the overshoot that lands a
// few seconds *after* the set ends, and an exponential recovery during rest.
// That shape is what the app's recovery and time-in-zone numbers read, so a
// simulated session produces numbers that behave like a real one.

import { EventEmitter } from 'node:events';
import { logger } from '../util/logger.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class HeartRateSimulator extends EventEmitter {
  /**
   * @param {{ restBpm?: number, maxBpm?: number, intervalMs?: number,
   *           workSec?: number, restSec?: number }} [opts]
   */
  constructor(opts = {}) {
    super();
    this.restBpm = opts.restBpm ?? 62;
    this.maxBpm = opts.maxBpm ?? 178;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.workSec = opts.workSec ?? 40;   // a set, roughly
    this.restSec = opts.restSec ?? 90;   // openGym's default rest
    this.bpm = this.restBpm;
    this.phase = 'rest';
    this.phaseLeft = 25;                 // warm-up before the first set
    this.timer = null;
    this.device = {
      id: 'sim-0000',
      name: 'Simulated HR strap',
      address: 'sim:00:00:00:00:00',
      sensorLocation: 'Chest',
      battery: 87,
    };
  }

  _setStatus(status, detail) {
    this.status = status;
    logger.info(`[sim] ${status}${detail ? ` — ${detail}` : ''}`);
    this.emit('status', { status, detail: detail || null });
  }

  async start() {
    if (this.timer) return;
    this._setStatus('connecting', this.device.name);
    this.emit('connected', this.device);
    this.emit('sensorLocation', this.device.sensorLocation);
    this.emit('battery', this.device.battery);
    this._setStatus('streaming', 'simulated heart rate (HR_SIMULATE=1)');
    this.emit('streaming', this.device);
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    this.timer.unref?.();
  }

  _tick() {
    const dt = this.intervalMs / 1000;
    this.phaseLeft -= dt;
    if (this.phaseLeft <= 0) {
      this.phase = this.phase === 'work' ? 'rest' : 'work';
      this.phaseLeft = this.phase === 'work' ? this.workSec : this.restSec;
    }

    // Effort target: hard work drives toward ~88% of max, rest toward a floor
    // a little above true resting (you don't get all the way back between sets).
    const target = this.phase === 'work'
      ? this.restBpm + (this.maxBpm - this.restBpm) * 0.88
      : this.restBpm + (this.maxBpm - this.restBpm) * 0.28;
    // Asymmetric time constants: the climb under load is faster than the fall
    // after it, which is why peak lands a beat or two after the set is racked.
    const tau = this.phase === 'work' ? 12 : 34;
    this.bpm += (target - this.bpm) * (dt / tau) * 3;
    this.bpm += (Math.random() - 0.5) * 2.2; // beat-to-beat wobble
    this.bpm = clamp(this.bpm, this.restBpm - 4, this.maxBpm);

    const bpm = Math.round(this.bpm);
    // RR intervals are what HRV is computed from, so they have to be derived
    // from this beat's rate plus a little variability rather than invented.
    const base = 60000 / bpm;
    const rrIntervals = [Math.round(base + (Math.random() - 0.5) * (this.phase === 'work' ? 12 : 46))];

    const now = Date.now();
    const reading = {
      bpm,
      contact: true,
      energyExpended: null,
      rrIntervals,
      flags: 0x10,
      deviceId: this.device.id,
      simulated: true,
      ms: now,
      at: new Date(now).toISOString(),
    };
    this.lastReading = reading;
    this.emit('heartRate', reading);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._setStatus('disconnected', this.device.name);
    this.emit('disconnected', this.device);
  }
}
