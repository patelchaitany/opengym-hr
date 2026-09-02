// In-memory session + reading store.
//
// A "session" is one continuous stretch of heart-rate streaming (e.g. a
// workout). We keep the current live state plus a rolling buffer of recent
// readings so a dashboard that connects mid-session can back-fill its chart.
//
// The buffer is also what makes the openGym integration accurate. The gym app
// receives readings live over the WebSocket, but a phone that locks its screen
// or backgrounds the tab stops receiving them — and the set you just finished
// is exactly the window you care about. So the buffer is kept for hours and is
// queryable by time range (`range(from, to)`): when a set is checked off, the
// app asks the bridge for the beats that happened during it and gets the real
// series, gaps included, regardless of what the tab was doing at the time.
//
// Everything lives in memory — restart the bridge and it resets. Durable
// history is the gym app's job (it writes the per-set numbers into the
// workout), and Google Health's for whole-day data.

import { randomUUID } from 'node:crypto';

export class SessionStore {
  /** @param {{ retentionSec?: number }} [opts] */
  constructor(opts = {}) {
    this.retentionMs = (opts.retentionSec || 4 * 3600) * 1000;
    this.sessions = new Map();
    this.currentId = null;
    this.buffer = []; // readings, ascending by `ms`, trimmed to retentionMs
    this.device = null;
    this.status = 'idle';
    this.lastReading = null;
  }

  startSession(device) {
    const id = randomUUID();
    const session = {
      id,
      device: device || null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      count: 0,
      minBpm: null,
      maxBpm: null,
      sumBpm: 0,
    };
    this.sessions.set(id, session);
    this.currentId = id;
    this.device = device || null;
    return session;
  }

  endSession() {
    const session = this.sessions.get(this.currentId);
    if (session && !session.endedAt) session.endedAt = new Date().toISOString();
    this.currentId = null;
  }

  addReading(reading) {
    if (!this.currentId) this.startSession(this.device);
    const session = this.sessions.get(this.currentId);
    session.count += 1;
    session.sumBpm += reading.bpm;
    session.minBpm = session.minBpm === null ? reading.bpm : Math.min(session.minBpm, reading.bpm);
    session.maxBpm = session.maxBpm === null ? reading.bpm : Math.max(session.maxBpm, reading.bpm);

    this.lastReading = reading;
    // `ms` is the epoch millisecond the sample landed. The ISO `at` stays for
    // humans reading the JSON; every lookup here is numeric.
    this.buffer.push(reading);
    this._trim();
  }

  _trim() {
    const cutoff = Date.now() - this.retentionMs;
    // Ascending buffer, so everything expired is at the front.
    let drop = 0;
    while (drop < this.buffer.length && this.buffer[drop].ms < cutoff) drop++;
    if (drop) this.buffer.splice(0, drop);
  }

  /**
   * Readings whose timestamp falls in [from, to], inclusive. Both are epoch ms;
   * an open end means "everything up to now".
   * @param {number} from
   * @param {number} [to]
   */
  range(from, to = Infinity) {
    const lo = Number(from) || 0;
    const hi = to === undefined || to === null ? Infinity : Number(to);
    return this.buffer.filter((r) => r.ms >= lo && r.ms <= hi);
  }

  /** Min/avg/max over a time range, plus the RR intervals inside it (for HRV). */
  statsFor(from, to) {
    const rows = this.range(from, to);
    if (!rows.length) return { n: 0, avgBpm: null, minBpm: null, maxBpm: null, rr: [] };
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    const rr = [];
    for (const r of rows) {
      sum += r.bpm;
      if (r.bpm < min) min = r.bpm;
      if (r.bpm > max) max = r.bpm;
      if (r.rrIntervals?.length) rr.push(...r.rrIntervals);
    }
    return {
      n: rows.length,
      avgBpm: Math.round(sum / rows.length),
      minBpm: min,
      maxBpm: max,
      startBpm: rows[0].bpm,
      endBpm: rows[rows.length - 1].bpm,
      from: rows[0].ms,
      to: rows[rows.length - 1].ms,
      rr,
    };
  }

  setStatus(status) {
    this.status = status;
  }

  setDevice(device) {
    this.device = device;
  }

  summary(session) {
    const s = session || this.sessions.get(this.currentId);
    if (!s) return null;
    return {
      ...s,
      avgBpm: s.count ? Math.round(s.sumBpm / s.count) : null,
    };
  }

  snapshot() {
    return {
      status: this.status,
      device: this.device,
      lastReading: this.lastReading,
      session: this.summary(),
      recent: this.buffer.slice(-120), // last ~2 minutes
    };
  }

  listSessions() {
    return [...this.sessions.values()].map((s) => this.summary(s));
  }
}
