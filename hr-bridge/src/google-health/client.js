// Thin client for the Google Health API (steps, heart-rate history).
//
// NOTE ON STABILITY: the Google Health API is new (2026) and its exact request
// shapes are still settling, and all scopes are "Restricted". The endpoint
// paths and body shape below follow the documented v4 read/rollup pattern
// (every read returns rows under `dataPoints`). They're centralised here so
// that if Google adjusts a path you change it in exactly one place. The
// Bluetooth live-heart-rate side of this project does NOT depend on any of
// this and works fully offline.

import { GoogleAuth } from './auth.js';

const BASE_URL = 'https://health.googleapis.com/v4';

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export class GoogleHealthClient {
  constructor(opts = {}) {
    this.auth = opts.auth || new GoogleAuth(opts);
  }

  createAuthUrl() {
    return this.auth.createAuthUrl();
  }

  handleCallback(query) {
    return this.auth.exchangeCode(query);
  }

  isAuthorized() {
    return this.auth.isAuthorized();
  }

  async _get(pathAndQuery) {
    const token = await this.auth.getAccessToken();
    const res = await fetch(`${BASE_URL}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Google Health API ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * Daily step total for a date (defaults to today). Returns a normalized
   * shape; pass rawResponse=true via the caller to inspect the original.
   */
  async getSteps(date = todayISO()) {
    const q = new URLSearchParams({
      dataType: 'steps',
      startTime: `${date}T00:00:00Z`,
      endTime: `${date}T23:59:59Z`,
    });
    const raw = await this._get(`/dataPoints:list?${q.toString()}`);
    const points = raw.dataPoints || [];
    const total = points.reduce((sum, p) => sum + Number(p.value?.count ?? p.value ?? 0), 0);
    return { date, steps: total, points: points.length, source: 'google-health' };
  }

  /**
   * Heart-rate samples for a date (defaults to today).
   */
  async getHeartRate(date = todayISO()) {
    const q = new URLSearchParams({
      dataType: 'heartRate',
      startTime: `${date}T00:00:00Z`,
      endTime: `${date}T23:59:59Z`,
    });
    const raw = await this._get(`/dataPoints:list?${q.toString()}`);
    const points = (raw.dataPoints || []).map((p) => ({
      at: p.startTime || p.time || null,
      bpm: Number(p.value?.bpm ?? p.value ?? 0),
    }));
    return { date, samples: points, count: points.length, source: 'google-health' };
  }
}
