// Live heart-rate state for the current session.
//
// Deliberately separate from useStore: everything here is ephemeral and
// high-frequency. A beat a second through the persisted store would mean a
// localStorage write and a debounced upload to the server every second, for a
// number that is meaningless ten seconds later. What gets *kept* is decided at
// the end of a set and at the end of a workout, and that goes through useStore
// like every other piece of workout data.

import { create } from 'zustand'
import { connect, fetchRange } from '../lib/hrbridge.js'
import { seriesStats, zoneIndex } from '../lib/hrmetrics.js'
import { useStore } from './useStore.js'

// A reading older than this is not "your heart rate", it is the last thing we
// heard before the strap fell off the treadmill. The badge greys out instead of
// standing there showing a confident stale number.
const STALE_MS = 12000
// 4 h at 1 Hz. Long enough that no real session is truncated, bounded so a
// bridge left connected overnight can't grow without limit.
const MAX_SAMPLES = 14400

let link = null
let staleTimer = null

export const useHR = create((set, get) => ({
  on: false,             // is a session connection wanted right now
  state: 'off',          // off | connecting | reconnecting | live | waiting | offline | error
  detail: null,          // bridge-side status ('scanning', 'mixed-content', …)
  bpm: null,
  at: 0,                 // ms of the last reading
  stale: false,
  device: null,
  battery: null,
  samples: [],           // { ms, bpm, rr? } ascending — this session only
  mark: 0,               // start of the segment the next completed set will claim

  /** Open the live connection. Idempotent — safe to call on every render pass. */
  start(base) {
    if (get().on) return
    set({ on: true, state: 'connecting', samples: [], bpm: null, at: 0, stale: false })
    link = connect(base, {
      onStatus: (state, detail) => set({ state, detail: detail || null }),
      onDevice: device => device && set({ device }),
      onBattery: battery => set({ battery }),
      onSnapshot: snap => {
        if (snap?.device) set({ device: snap.device })
        // Back-fill the chart from what the bridge already has, so opening the
        // app three sets into a session doesn't start the curve from nothing.
        if (snap?.recent?.length) get()._ingest(snap.recent)
      },
      onReading: r => get()._ingest([r])
    })
    clearInterval(staleTimer)
    staleTimer = setInterval(() => {
      const { at, stale } = get()
      const now = Date.now()
      const s = !!at && now - at > STALE_MS
      if (s !== stale) set({ stale: s })
    }, 2000)
  },

  stop() {
    link?.close()
    link = null
    clearInterval(staleTimer)
    staleTimer = null
    set({ on: false, state: 'off', detail: null, bpm: null, at: 0, stale: false, samples: [], mark: 0 })
  },

  _ingest(rows) {
    if (!rows?.length) return
    const cur = get().samples
    const lastMs = cur.length ? cur[cur.length - 1].ms : 0
    const add = []
    for (const r of rows) {
      const ms = r.ms || (r.at ? Date.parse(r.at) : Date.now())
      if (!(r.bpm > 0) || ms <= lastMs) continue      // dedupe the snapshot overlap
      add.push({ ms, bpm: r.bpm, ...(r.rrIntervals?.length ? { rr: r.rrIntervals } : r.rr ? { rr: r.rr } : {}) })
    }
    if (!add.length) return
    const next = cur.concat(add)
    const last = add[add.length - 1]
    set({
      samples: next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next,
      bpm: last.bpm, at: last.ms, stale: false
    })
  },

  /** Begin a new segment here — called when rest ends and when a set is logged. */
  setMark(ms) { set({ mark: ms || Date.now() }) },

  /** Live min/avg/max for a window, straight from what this tab has received.
      The tolerance matches summarize(): a set finished inside one sampling
      interval still gets the beat that bracketed it. */
  stats(from, to) { return seriesStats(get().samples, from, to, { nearestMs: 10000 }) },

  /** Current zone index for the badge, or -1. */
  zone(maxBpm) {
    const { bpm, stale } = get()
    return bpm && !stale ? zoneIndex(bpm, maxBpm) : -1
  },

  /**
   * Ask the bridge for a window, merge it in, and return the merged series.
   * This is the repair pass: what the socket missed while the screen was off,
   * the bridge still has. Falls back to the local samples when the bridge is
   * unreachable, so finishing a workout never fails on a network error.
   */
  async backfill(base, from, to) {
    try {
      const rows = await fetchRange(base, from, to)
      if (rows.length) {
        // Bridge history is authoritative for the window it covers; anything
        // this tab holds outside it (a gap at either end) is kept.
        const mine = get().samples
        const lo = rows[0].ms, hi = rows[rows.length - 1].ms
        const merged = mine.filter(s => s.ms < lo || s.ms > hi).concat(rows)
          .sort((a, b) => a.ms - b.ms)
        set({ samples: merged.length > MAX_SAMPLES ? merged.slice(merged.length - MAX_SAMPLES) : merged })
      }
    } catch { /* bridge unreachable — the live samples are what we have */ }
    return get().samples
  }
}))

/** The bridge address this profile is configured to use. */
export const hrBase = () => useStore.getState().S.hr?.url || ''
/** Is heart rate switched on for this profile? */
export const hrEnabled = () => !!useStore.getState().S.hr?.on
