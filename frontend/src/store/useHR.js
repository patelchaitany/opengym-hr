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
import { connectDevice, nativeHRSupported } from '../lib/hrble.js'
import { seriesStats, zoneIndex } from '../lib/hrmetrics.js'
import { useStore } from './useStore.js'
import { MOBILE } from '../lib/mobile.js'

// A reading older than this is not "your heart rate", it is the last thing we
// heard before the strap fell off the treadmill. The badge greys out instead of
// standing there showing a confident stale number.
const STALE_MS = 12000
// 4 h at 1 Hz. Long enough that no real session is truncated, bounded so a
// bridge left connected overnight can't grow without limit.
const MAX_SAMPLES = 14400

let link = null
let staleTimer = null
let lingerTimer = null

export const useHR = create((set, get) => ({
  on: false,             // is a session connection wanted right now
  source: null,          // 'bridge' | 'ble' — which one is currently open
  state: 'off',          // off | connecting | reconnecting | live | waiting | offline | error
  detail: null,          // bridge-side status ('scanning', 'mixed-content', …)
  bpm: null,
  at: 0,                 // ms of the last reading
  stale: false,
  device: null,
  battery: null,
  samples: [],           // { ms, bpm, rr? } ascending — this session only
  mark: 0,               // start of the segment the next completed set will claim

  /**
   * Open the live connection. Idempotent — safe to call on every render pass.
   * @param {{source?: 'bridge'|'ble', url?: string, device?: {id,name}}} cfg
   */
  start(cfg = {}) {
    // A stop that was only lingering (see stopSoon) is cancelled here rather
    // than allowed to fire mid-session and cut the feed you just came back for.
    clearTimeout(lingerTimer); lingerTimer = null
    if (get().on) return
    const source = sourceOf(cfg.source)
    set({ on: true, source, state: 'connecting', detail: null, samples: [], bpm: null, at: 0, stale: false, device: null, battery: null })

    const handlers = {
      onStatus: (state, detail) => set({ state, detail: detail || null }),
      onDevice: device => device && set({ device }),
      onBattery: battery => set({ battery }),
      onReading: r => get()._ingest([r])
    }

    link = source === 'ble'
      ? connectDevice(cfg.device || {}, handlers)
      : connect(cfg.url || '', {
        ...handlers,
        onSnapshot: snap => {
          if (snap?.device) set({ device: snap.device })
          // Back-fill the chart from what the bridge already has, so opening
          // the app three sets in doesn't start the curve from nothing. The
          // on-device source has no equivalent — nothing was listening before
          // the phone connected.
          if (snap?.recent?.length) get()._ingest(snap.recent)
        }
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
    clearTimeout(lingerTimer); lingerTimer = null
    link?.close()
    link = null
    clearInterval(staleTimer)
    staleTimer = null
    // `samples` deliberately survives. Finishing a workout kicks off analysis
    // passes that run for another minute (the last exercise's recovery is
    // measured sixty seconds after its final set), and they read this array.
    // It is cleared on the next start(), so nothing stale is ever shown.
    set({ on: false, source: null, state: 'off', detail: null, bpm: null, at: 0, stale: false, mark: 0 })
  },

  /**
   * Stop, but not yet.
   *
   * A workout ends the moment you tap finish, and the interesting part of the
   * heart-rate trace starts right then: recovery is how far your pulse falls
   * over the following minute. Tearing the connection down at `finish` would
   * throw away the only window in which that can be measured — so the feed is
   * held open a little longer and then let go. Calling start() cancels it.
   */
  stopSoon(delayMs = 90000) {
    if (!get().on) return
    clearTimeout(lingerTimer)
    lingerTimer = setTimeout(() => { lingerTimer = null; get().stop() }, delayMs)
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
    // Nothing to repair against when this device is the receiver: what the
    // phone missed, nothing else was listening for. The samples it does have
    // are the whole record.
    if (get().source === 'ble') return get().samples
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

/**
 * Which source a profile means. Stored as null until someone chooses, so the
 * sensible default can follow the platform: the installed app reads the strap
 * itself, and a browser talks to the bridge.
 */
export function sourceOf(pref) {
  if (pref === 'ble') return nativeHRSupported() ? 'ble' : 'bridge'
  if (pref === 'bridge') return 'bridge'
  return MOBILE && nativeHRSupported() ? 'ble' : 'bridge'
}

/** Everything start() needs, read off the profile. */
export function hrSession(S) {
  const hr = S.hr || {}
  return { source: sourceOf(hr.source), url: hr.url || '', device: hr.device || null }
}

/** Is heart rate switched on for this profile? */
export const hrEnabled = () => !!useStore.getState().S.hr?.on
