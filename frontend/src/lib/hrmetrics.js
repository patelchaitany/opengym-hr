// Heart-rate maths. Pure functions over a sample series — no store, no network,
// no React — so every number the app shows can be unit-tested against a series
// you can read (see hrmetrics.test.js).
//
// A *series* is `[{ ms, bpm, rr? }]` sorted ascending by ms, exactly what the
// hr-bridge hands back from /api/heart-rate/range. `rr` is the list of R-R
// intervals in milliseconds carried by that notification, when the device
// sends them — the raw material for HRV.
//
// Everything here is time-weighted rather than sample-counted. A strap that
// drops out for 40 seconds mid-set produces a series with a hole in it, and a
// plain mean over samples would quietly treat that hole as though it never
// happened. Each sample is weighted by the gap to the next one, capped at
// GAP_CAP so a genuine dropout contributes its first second and then stops
// counting instead of smearing one stale reading across the whole gap.

import { t } from './i18n.js'
import { lastBW } from './history.js'

const GAP_CAP_MS = 10000   // longest gap one sample is allowed to represent

/* ---------------------------------------------------------------- profile */

// openGym stores body weight in the profile's own unit; every formula below
// wants kilograms.
export const toKg = (w, unit) => (unit === 'lb' ? w * 0.45359237 : w)

// Max heart rate. An explicitly measured one always wins — the formulae are
// population fits with a standard deviation around ±10 bpm, so a number you
// actually hit in a hard session is worth more than any of them. Falling back,
// this is Nes et al. (2013), which tracks real maxima better across ages than
// the 220−age everyone quotes. With no age either, 190 is a plain placeholder
// and the app says so rather than pretending the zones mean anything.
export function maxHRFor(cfg) {
  if (cfg?.maxBpm > 0) return Math.round(cfg.maxBpm)
  if (cfg?.age > 0) return Math.round(211 - 0.64 * cfg.age)
  return 190
}
export const maxHRIsEstimated = cfg => !(cfg?.maxBpm > 0)
export const restHRFor = cfg => (cfg?.restBpm > 0 ? Math.round(cfg.restBpm) : 60)

/**
 * Everything the formulae need, assembled from the profile. Body weight comes
 * from the weigh-in log rather than a second field to keep up to date, and from
 * the workout's own `bw` when there is one, so a session from last spring is
 * scored against what you weighed last spring.
 */
export function hrConfig(S, w) {
  const h = S.hr || {}
  const bw = w && w.bw > 0 ? { w: w.bw } : lastBW(S)
  return {
    maxBpm: maxHRFor(h),
    restBpm: restHRFor(h),
    // Reuses Settings' existing body-map choice — one question, not two.
    sex: S.body === 'female' ? 'female' : 'male',
    age: h.age > 0 ? h.age : null,
    weightKg: bw && bw.w > 0 ? toKg(bw.w, S.unit) : null
  }
}

/* ------------------------------------------------------------------ zones */

// Five zones by percentage of maximum heart rate — the split every gym chart
// and every wearable uses, so the colours mean the same thing here as they do
// on the treadmill display. `lo` is inclusive, `hi` exclusive except at the top.
export const ZONE_DEFS = [
  { key: 'z1', lo: 0.50, hi: 0.60, name: 'Warm up', color: 'var(--grey)' },
  { key: 'z2', lo: 0.60, hi: 0.70, name: 'Fat burn', color: 'var(--blue)' },
  { key: 'z3', lo: 0.70, hi: 0.80, name: 'Aerobic', color: 'var(--green)' },
  { key: 'z4', lo: 0.80, hi: 0.90, name: 'Threshold', color: 'var(--orange)' },
  { key: 'z5', lo: 0.90, hi: 1.20, name: 'Max', color: 'var(--red)' }
]

export function zonesOf(maxBpm) {
  return ZONE_DEFS.map((z, i) => ({
    ...z, i,
    from: Math.round(z.lo * maxBpm),
    to: i === ZONE_DEFS.length - 1 ? Infinity : Math.round(z.hi * maxBpm)
  }))
}

// Which zone a reading falls in, or -1 for anything below zone 1 (sitting on a
// bench between sets is not training, and counting it as zone 1 would make
// every session look like an hour of cardio).
export function zoneIndex(bpm, maxBpm) {
  const f = bpm / maxBpm
  if (f < ZONE_DEFS[0].lo) return -1
  for (let i = ZONE_DEFS.length - 1; i >= 0; i--) if (f >= ZONE_DEFS[i].lo) return i
  return -1
}
export const zoneName = i => (i < 0 ? t('Resting') : t(ZONE_DEFS[i].name))
export const zoneColor = i => (i < 0 ? 'var(--label-3)' : ZONE_DEFS[i].color)

export const pctMax = (bpm, maxBpm) => (maxBpm > 0 ? bpm / maxBpm : 0)
// Karvonen: where a reading sits between resting and maximum, which is the
// honest way to compare two people (or the same person before and after a few
// months of training) — 140 bpm is not the same effort from a resting 45 as
// from a resting 75.
export function pctReserve(bpm, restBpm, maxBpm) {
  const span = maxBpm - restBpm
  if (!(span > 0)) return 0
  return Math.max(0, Math.min(1, (bpm - restBpm) / span))
}

/* ----------------------------------------------------------------- series */

export function sliceSeries(series, from, to) {
  if (!series?.length) return []
  const lo = from == null ? -Infinity : from
  const hi = to == null ? Infinity : to
  return series.filter(s => s.ms >= lo && s.ms <= hi)
}

// Per-sample weights: how long each reading stood for. The last sample gets the
// median of the gaps before it rather than zero, or a two-sample window would
// weigh its second reading at nothing.
function weights(rows) {
  const n = rows.length
  if (n === 0) return []
  if (n === 1) return [1000]
  const w = new Array(n)
  let sum = 0
  for (let i = 0; i < n - 1; i++) {
    w[i] = Math.max(0, Math.min(GAP_CAP_MS, rows[i + 1].ms - rows[i].ms))
    sum += w[i]
  }
  w[n - 1] = Math.min(GAP_CAP_MS, Math.round(sum / (n - 1)) || 1000)
  return w
}

/**
 * Min / mean / max over a window, plus how long the window actually holds data.
 * `secs` is coverage, not wall-clock: a set you spent 50 s on with 20 s of
 * dropout reports 30.
 * @returns {{n:number, avg:number|null, max:number|null, min:number|null,
 *            start:number|null, end:number|null, secs:number,
 *            from:number|null, to:number|null}}
 */
export function seriesStats(series, from, to, { nearestMs = 0 } = {}) {
  let rows = sliceSeries(series, from, to)
  const empty = { n: 0, avg: null, max: null, min: null, start: null, end: null, secs: 0, from: null, to: null }
  // A window can be shorter than the strap's sampling interval — a set banged
  // out in four seconds, a rest skipped the instant it started — and then hold
  // no sample at all, even with a perfectly healthy feed. Reporting nothing
  // there is wrong: the beat either side of it *is* the heart rate at that
  // moment. So fall back to the nearest reading within `nearestMs` of the
  // instant the window closed. `n: 1` in the result says how thin it is.
  if (!rows.length && nearestMs > 0 && series?.length) {
    const anchor = to == null ? series[series.length - 1].ms : to
    let best = null
    for (const s of series) {
      const d = Math.abs(s.ms - anchor)
      if (d <= nearestMs && (!best || d < Math.abs(best.ms - anchor))) best = s
    }
    if (best) rows = [best]
  }
  if (!rows.length) return empty
  const w = weights(rows)
  let wsum = 0, acc = 0, min = Infinity, max = -Infinity
  rows.forEach((r, i) => {
    acc += r.bpm * w[i]; wsum += w[i]
    if (r.bpm < min) min = r.bpm
    if (r.bpm > max) max = r.bpm
  })
  return {
    n: rows.length,
    avg: Math.round(acc / (wsum || 1)),
    max, min,
    start: rows[0].bpm,
    end: rows[rows.length - 1].bpm,
    secs: Math.round(wsum / 1000),
    from: rows[0].ms,
    to: rows[rows.length - 1].ms
  }
}

/** Seconds spent in each of the five zones over a window. Index 0 = zone 1. */
export function timeInZones(series, maxBpm, from, to) {
  const rows = sliceSeries(series, from, to)
  const out = [0, 0, 0, 0, 0]
  if (!rows.length) return out
  const w = weights(rows)
  rows.forEach((r, i) => {
    const z = zoneIndex(r.bpm, maxBpm)
    if (z >= 0) out[z] += w[i] / 1000
  })
  return out.map(s => Math.round(s))
}

/**
 * Banister TRIMP — one number for "how much training was that", weighting time
 * by intensity exponentially, so ten minutes near threshold counts for far more
 * than an hour of standing around. The sex-specific constants are Banister's;
 * with none given the male fit is used and the number is still comparable to
 * your own past sessions, which is all it is ever used for here.
 */
export function trimp(series, { restBpm, maxBpm, sex }, from, to) {
  const rows = sliceSeries(series, from, to)
  if (!rows.length) return 0
  const w = weights(rows)
  const [k, e] = sex === 'female' ? [0.86, 1.67] : [0.64, 1.92]
  let total = 0
  rows.forEach((r, i) => {
    const hrr = pctReserve(r.bpm, restBpm, maxBpm)
    total += (w[i] / 60000) * hrr * k * Math.exp(e * hrr)
  })
  return Math.round(total * 10) / 10
}

/**
 * Energy expenditure from heart rate — Keytel et al. (2005), the equation
 * behind most consumer "calories from HR" readouts. It is a regression on
 * steady-state exercise, so treat it as an estimate with real error bars,
 * especially for lifting where the HR response lags the actual work.
 * Needs body weight and age; without them it declines to guess and returns null
 * rather than printing a confident wrong number.
 */
export function kcalOf(series, { weightKg, age, sex }, from, to) {
  if (!(weightKg > 0) || !(age > 0)) return null
  const rows = sliceSeries(series, from, to)
  if (!rows.length) return null
  const w = weights(rows)
  let kcal = 0
  rows.forEach((r, i) => {
    const perMin = sex === 'female'
      ? (-20.4022 + 0.4472 * r.bpm - 0.1263 * weightKg + 0.074 * age) / 4.184
      : (-55.0969 + 0.6309 * r.bpm + 0.1988 * weightKg + 0.2017 * age) / 4.184
    kcal += Math.max(0, perMin) * (w[i] / 60000)
  })
  return Math.round(kcal)
}

/**
 * RMSSD — the standard short-window HRV measure: the root mean square of the
 * differences between successive beats, in milliseconds. Higher is a more
 * variable (more parasympathetic, better recovered) heart. Only meaningful
 * from a device that reports R-R intervals; chest straps do, most optical
 * wrist sensors don't, so this returns null rather than a fabricated 0.
 */
export function rmssd(series, from, to) {
  const rows = sliceSeries(series, from, to)
  const rr = []
  for (const r of rows) if (r.rr?.length) rr.push(...r.rr)
  if (rr.length < 3) return null
  let acc = 0, n = 0
  for (let i = 1; i < rr.length; i++) {
    // A dropped beat shows up as one interval roughly twice its neighbours and
    // would dominate the mean square. Anything past a 30% jump is discarded as
    // an artefact rather than read as variability.
    const a = rr[i - 1], b = rr[i]
    if (!(a > 250 && a < 2000 && b > 250 && b < 2000)) continue
    if (Math.abs(b - a) > 0.3 * a) continue
    acc += (b - a) ** 2; n++
  }
  if (n < 2) return null
  return Math.round(Math.sqrt(acc / n))
}

/**
 * Heart-rate recovery: how far the pulse falls in the `sec` seconds after a
 * peak. The single most-quoted marker of cardiovascular fitness there is — a
 * drop of 12+ bpm in the first minute after hard work is the usual healthy
 * threshold, and it improves visibly with training, which makes it worth
 * tracking set over set.
 * @param {number} peakMs when the effort ended (peak is searched around it)
 */
export function recovery(series, peakMs, sec = 60) {
  if (!series?.length) return null
  // The true peak lands a few seconds after the bar is racked, not at the
  // moment you tap the checkbox, so look in a short window either side.
  const around = sliceSeries(series, peakMs - 5000, peakMs + 15000)
  if (!around.length) return null
  const peak = Math.max(...around.map(s => s.bpm))
  const peakAt = around.find(s => s.bpm === peak).ms
  // Take the reading nearest the target instant, within ±10 s of it.
  const target = peakAt + sec * 1000
  const near = sliceSeries(series, target - 10000, target + 10000)
  if (!near.length) return null
  let best = near[0]
  for (const s of near) if (Math.abs(s.ms - target) < Math.abs(best.ms - target)) best = s
  return { peak, after: best.bpm, drop: peak - best.bpm, sec, at: peakAt }
}

/**
 * Thin a series down for storage. A workout keeps its own heart-rate curve so
 * History can draw it months later, but at 1 Hz an hour is 3600 points and the
 * whole profile is re-uploaded on every edit. One point per `everySec` (the
 * max of each bucket, so peaks survive) keeps the shape and cuts it by 10×.
 * Stored as [secondsFromStart, bpm] pairs — a third the JSON of objects.
 */
export function downsample(series, startMs, everySec = 10) {
  if (!series?.length) return []
  const out = []
  let bucket = -1, peak = 0
  for (const s of series) {
    const b = Math.floor((s.ms - startMs) / (everySec * 1000))
    if (b !== bucket) {
      if (bucket >= 0) out.push([bucket * everySec, peak])
      bucket = b; peak = s.bpm
    } else if (s.bpm > peak) peak = s.bpm
  }
  if (bucket >= 0) out.push([bucket * everySec, peak])
  return out
}
/** Inverse of downsample — back to a series the functions above can read. */
export const expand = (packed, startMs) =>
  (packed || []).map(([sec, bpm]) => ({ ms: startMs + sec * 1000, bpm }))

/* --------------------------------------------------------------- analysis */

/**
 * Everything the app records about the heart during one window: the summary
 * shape stored on a set, an exercise and a whole workout alike.
 */
export function summarize(series, cfg, from, to) {
  // 10 s of tolerance: long enough to bracket any real gap in a 1 Hz feed,
  // short enough that a window in the middle of a genuine dropout still
  // reports nothing rather than borrowing a reading from a minute away.
  const st = seriesStats(series, from, to, { nearestMs: 10000 })
  if (!st.n) return null
  return {
    avg: st.avg, max: st.max, min: st.min,
    start: st.start, end: st.end,
    secs: st.secs, n: st.n, from: st.from, to: st.to,
    pctMax: Math.round(pctMax(st.avg, cfg.maxBpm) * 100),
    peakPctMax: Math.round(pctMax(st.max, cfg.maxBpm) * 100),
    zone: zoneIndex(st.avg, cfg.maxBpm),
    peakZone: zoneIndex(st.max, cfg.maxBpm),
    zones: timeInZones(series, cfg.maxBpm, from, to),
    trimp: trimp(series, cfg, from, to),
    kcal: kcalOf(series, cfg, from, to),
    hrv: rmssd(series, from, to)
  }
}

/**
 * The whole-session pass, run once when a workout is finished.
 *
 * Per-set capture during the session is a live convenience — it is computed
 * from whatever the tab happened to receive. This runs afterwards over the full
 * series fetched from the bridge, so a phone that slept through half the
 * session still ends up with correct numbers, and it is the only place that can
 * compute the things needing hindsight: an exercise's recovery is measured a
 * minute after its last set, which hasn't happened yet when that set is ticked.
 *
 * @param {object} w        the finished workout ({ start, end, entries:[{ id, sets:[{hrw:[from,to]}] }] })
 * @param {Array}  series   full-session samples
 * @param {object} cfg      { maxBpm, restBpm, sex, age, weightKg }
 * @returns {object|null}   summary to store as w.hr
 */
export function analyzeWorkout(w, series, cfg) {
  if (!series?.length) return null
  const overall = summarize(series, cfg, w.start, w.end)
  if (!overall) return null

  // Positional, not keyed by exercise id: a session can hold the same exercise
  // twice (a second run of dips at the end), and keying by id would give both
  // the first one's numbers.
  const exercises = w.entries.map((e, idx) => {
    // An exercise's window runs from the start of its first logged set to the
    // end of its last: the work plus the rest between its own sets, which is
    // the thing you would point at and call "the squats".
    const wins = e.sets.map(s => s.hrw).filter(Boolean)
    if (!wins.length) return { i: idx, id: e.id, hr: null }
    const from = Math.min(...wins.map(x => x[0]))
    const to = Math.max(...wins.map(x => x[1]))
    const hr = summarize(series, cfg, from, to)
    if (hr) {
      hr.recovery = recovery(series, to, 60)
      // Per set, recomputed from the full series rather than trusting whatever
      // the live capture managed to see.
      hr.sets = e.sets.map(s => (s.hrw ? summarize(series, cfg, s.hrw[0], s.hrw[1]) : null))
    }
    return { i: idx, id: e.id, hr }
  })

  return {
    ...overall,
    exercises,
    // The curve itself, so History can draw the session back.
    series: downsample(series, w.start, 10),
    startMs: w.start,
    cfg: { maxBpm: cfg.maxBpm, restBpm: cfg.restBpm }
  }
}

/* ------------------------------------------------------------- formatting */

export const fmtBpm = n => (n == null ? '—' : Math.round(n) + ' bpm')
export function fmtMins(sec) {
  if (!sec) return '0:00'
  const s = Math.round(sec)
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}
