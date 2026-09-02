import { describe, it, expect } from 'vitest'
import {
  toKg, maxHRFor, maxHRIsEstimated, restHRFor, hrConfig,
  zonesOf, zoneIndex, pctReserve,
  seriesStats, timeInZones, trimp, kcalOf, rmssd, recovery,
  downsample, expand, summarize, analyzeWorkout
} from './hrmetrics.js'

const T0 = 1700000000000
// A series at a steady 1 Hz, one entry per bpm given.
const at = (bpms, start = T0, stepMs = 1000) =>
  bpms.map((bpm, i) => ({ ms: start + i * stepMs, bpm }))

describe('profile numbers', () => {
  it('prefers a measured maximum over any estimate', () => {
    expect(maxHRFor({ maxBpm: 194, age: 30 })).toBe(194)
    expect(maxHRIsEstimated({ maxBpm: 194 })).toBe(false)
  })
  it('falls back to Nes (211 − 0.64·age), not 220 − age', () => {
    expect(maxHRFor({ age: 30 })).toBe(192)     // 220−age would say 190
    expect(maxHRFor({ age: 50 })).toBe(179)     // 220−age would say 170
    expect(maxHRIsEstimated({ age: 30 })).toBe(true)
  })
  it('uses a flat placeholder when it knows nothing', () => {
    expect(maxHRFor({})).toBe(190)
    expect(maxHRFor(null)).toBe(190)
  })
  it('defaults resting to 60 rather than 0', () => {
    expect(restHRFor({})).toBe(60)
    expect(restHRFor({ restBpm: 48 })).toBe(48)
  })
  it('converts pounds for the formulae that want kilos', () => {
    expect(toKg(100, 'kg')).toBe(100)
    expect(toKg(220, 'lb')).toBeCloseTo(99.79, 1)
  })
})

describe('hrConfig', () => {
  const S = {
    unit: 'kg', body: 'female',
    hr: { maxBpm: 186, restBpm: 52, age: 34 },
    bodyweight: [{ d: '2024-01-01', w: 60 }, { d: '2024-06-01', w: 64 }]
  }
  it('reads sex from the body-map setting rather than asking twice', () => {
    expect(hrConfig(S).sex).toBe('female')
    expect(hrConfig({ ...S, body: 'male' }).sex).toBe('male')
  })
  it('takes body weight from the latest weigh-in', () => {
    expect(hrConfig(S).weightKg).toBe(64)
  })
  it("prefers the workout's own weigh-in, so an old session is scored as it was", () => {
    expect(hrConfig(S, { bw: 58 }).weightKg).toBe(58)
  })
  it('carries the max and resting values through', () => {
    expect(hrConfig(S)).toMatchObject({ maxBpm: 186, restBpm: 52, age: 34 })
  })
})

describe('zones', () => {
  it('places boundaries at 50/60/70/80/90% of max', () => {
    const z = zonesOf(200)
    expect(z.map(x => x.from)).toEqual([100, 120, 140, 160, 180])
    expect(z[4].to).toBe(Infinity)
  })
  it('reports anything under 50% as no zone at all, not zone 1', () => {
    expect(zoneIndex(80, 200)).toBe(-1)   // sitting on the bench is not training
    expect(zoneIndex(99, 200)).toBe(-1)
    expect(zoneIndex(100, 200)).toBe(0)
  })
  it('puts a reading in the zone its lower bound opens', () => {
    expect(zoneIndex(139, 200)).toBe(1)
    expect(zoneIndex(140, 200)).toBe(2)
    expect(zoneIndex(179, 200)).toBe(3)
    expect(zoneIndex(180, 200)).toBe(4)
    expect(zoneIndex(210, 200)).toBe(4)   // above max is still zone 5
  })
  it('measures reserve from resting, not from zero', () => {
    expect(pctReserve(60, 60, 180)).toBe(0)
    expect(pctReserve(120, 60, 180)).toBeCloseTo(0.5)
    expect(pctReserve(180, 60, 180)).toBe(1)
    expect(pctReserve(40, 60, 180)).toBe(0)    // clamped, never negative
    expect(pctReserve(200, 60, 180)).toBe(1)
  })
})

describe('seriesStats', () => {
  it('returns an empty shape rather than throwing on no data', () => {
    expect(seriesStats([], 0, 1)).toMatchObject({ n: 0, avg: null, max: null })
    expect(seriesStats(null, 0, 1).n).toBe(0)
  })
  it('gives min, mean and max over the window', () => {
    const st = seriesStats(at([100, 110, 120, 130]), T0, T0 + 3000)
    expect(st).toMatchObject({ n: 4, min: 100, max: 130, start: 100, end: 130 })
    expect(st.avg).toBe(115)
  })
  it('only counts samples inside the window', () => {
    const s = at([100, 200, 100])
    expect(seriesStats(s, T0 + 1000, T0 + 1000)).toMatchObject({ n: 1, avg: 200 })
  })
  it('weights each sample by how long it stood for, not by sample count', () => {
    // 100 bpm held for 10 s, then a single 200 bpm reading. Counting samples
    // would say 150; time says the 100 dominates.
    const s = [{ ms: T0, bpm: 100 }, { ms: T0 + 10000, bpm: 200 }]
    expect(seriesStats(s, T0, T0 + 20000).avg).toBe(150)   // 10 s each (last sample capped at the gap)
    const s2 = [...at([100, 100, 100, 100, 100]), { ms: T0 + 5000, bpm: 200 }]
    expect(seriesStats(s2, T0, T0 + 6000).avg).toBeLessThan(120)
  })
  it('takes no nearest sample unless asked', () => {
    expect(seriesStats(at([100, 110]), T0 + 5000, T0 + 5100).n).toBe(0)
  })
  it('falls back to the bracketing beat for a window shorter than one sample', () => {
    // A set ticked four seconds after the last reading: strictly empty, but the
    // beat either side of it is still the heart rate at that moment.
    const s = at([100, 150, 120])          // T0, +1s, +2s
    const st = seriesStats(s, T0 + 2400, T0 + 2500, { nearestMs: 10000 })
    expect(st).toMatchObject({ n: 1, avg: 120, max: 120 })
  })
  it('will not borrow a reading from outside the tolerance', () => {
    const s = at([100, 150, 120])
    expect(seriesStats(s, T0 + 60000, T0 + 60100, { nearestMs: 10000 }).n).toBe(0)
  })
  it('caps how long one sample may represent, so a dropout cannot smear', () => {
    // A 10-minute gap must not let one stale reading count for ten minutes.
    const s = [{ ms: T0, bpm: 180 }, { ms: T0 + 600000, bpm: 60 }]
    expect(seriesStats(s, T0, T0 + 700000).secs).toBeLessThanOrEqual(20)
  })
})

describe('timeInZones', () => {
  it('attributes each second to the zone the reading was in', () => {
    // max 200 → z3 starts at 140, z4 at 160
    const s = at([145, 145, 145, 165, 165])
    const z = timeInZones(s, 200, T0, T0 + 5000)
    expect(z[2]).toBe(3)
    expect(z[3]).toBe(2)
    expect(z[0] + z[1] + z[4]).toBe(0)
  })
  it('drops sub-zone-1 time entirely', () => {
    expect(timeInZones(at([70, 70, 70]), 200, T0, T0 + 3000)).toEqual([0, 0, 0, 0, 0])
  })
  it('is all zeroes for an empty window instead of undefined', () => {
    expect(timeInZones([], 200, 0, 1)).toEqual([0, 0, 0, 0, 0])
  })
})

describe('trimp', () => {
  const cfg = { restBpm: 60, maxBpm: 180, sex: 'male' }
  it('is zero at rest and rises with intensity', () => {
    expect(trimp(at([60, 60, 60]), cfg, T0, T0 + 3000)).toBe(0)
    const easy = trimp(at(Array(60).fill(100)), cfg, T0, T0 + 60000)
    const hard = trimp(at(Array(60).fill(170)), cfg, T0, T0 + 60000)
    expect(easy).toBeGreaterThan(0)
    expect(hard).toBeGreaterThan(easy)
  })
  it('weights intensity exponentially, not linearly', () => {
    // Same total time; the harder minute must be worth more than twice the easy
    // one at double the reserve, which a linear score could not produce.
    const half = trimp(at(Array(60).fill(120)), cfg, T0, T0 + 60000)   // 50% reserve
    const full = trimp(at(Array(60).fill(180)), cfg, T0, T0 + 60000)   // 100% reserve
    expect(full).toBeGreaterThan(2 * half)
  })
  it('uses the female constants when asked', () => {
    const s = at(Array(60).fill(150))
    const m = trimp(s, cfg, T0, T0 + 60000)
    const f = trimp(s, { ...cfg, sex: 'female' }, T0, T0 + 60000)
    expect(f).not.toBe(m)
  })
  it('scales with duration', () => {
    const one = trimp(at(Array(60).fill(150)), cfg, T0, T0 + 60000)
    const two = trimp(at(Array(120).fill(150)), cfg, T0, T0 + 120000)
    expect(two).toBeCloseTo(2 * one, 0)
  })
})

describe('kcalOf', () => {
  const who = { weightKg: 80, age: 30, sex: 'male' }
  it('declines to guess without body weight or age', () => {
    expect(kcalOf(at([150]), { age: 30, sex: 'male' })).toBeNull()
    expect(kcalOf(at([150]), { weightKg: 80, sex: 'male' })).toBeNull()
  })
  it('matches Keytel by hand for a steady minute', () => {
    // (−55.0969 + 0.6309·150 + 0.1988·80 + 0.2017·30) / 4.184 = 14.70 kcal/min
    const s = at(Array(60).fill(150))
    expect(kcalOf(s, who, T0, T0 + 60000)).toBe(15)
  })
  it('rises with heart rate and with duration', () => {
    const easy = kcalOf(at(Array(60).fill(110)), who, T0, T0 + 60000)
    const hard = kcalOf(at(Array(60).fill(170)), who, T0, T0 + 60000)
    const long = kcalOf(at(Array(300).fill(110)), who, T0, T0 + 300000)
    expect(hard).toBeGreaterThan(easy)
    expect(long).toBeGreaterThan(easy)
  })
  it('never returns a negative burn at a low heart rate', () => {
    expect(kcalOf(at(Array(60).fill(50)), who, T0, T0 + 60000)).toBe(0)
  })
})

describe('rmssd', () => {
  it('is null without R-R intervals — a wrist sensor gets no fake HRV', () => {
    expect(rmssd(at([100, 100, 100]))).toBeNull()
  })
  it('is 0 for a perfectly regular beat and rises with variability', () => {
    const flat = [{ ms: T0, bpm: 60, rr: [1000, 1000, 1000, 1000] }]
    const varied = [{ ms: T0, bpm: 60, rr: [1000, 1050, 1000, 1050] }]
    expect(rmssd(flat)).toBe(0)
    expect(rmssd(varied)).toBe(50)
  })
  it('discards a dropped beat instead of reading it as variability', () => {
    // 2000 ms is two beats merged; without rejection it would dominate.
    const s = [{ ms: T0, bpm: 60, rr: [1000, 1000, 2000, 1000, 1000, 1000] }]
    expect(rmssd(s)).toBe(0)
  })
})

describe('recovery', () => {
  it('measures the drop from the peak to a minute later', () => {
    // 60 s climbing to 170, then a minute falling to 120.
    const climb = at(Array(30).fill(170))
    const fall = at(Array(70).fill(120), T0 + 30000)
    const r = recovery(climb.concat(fall), T0 + 29000, 60)
    expect(r.peak).toBe(170)
    expect(r.after).toBe(120)
    expect(r.drop).toBe(50)
  })
  it('finds the true peak just after the set ended, not at the tick', () => {
    // Peak lands 6 s after the checkbox — the window looks forward for it.
    const s = at([150, 155, 160, 168, 172, 170, 165, 160])
    const r = recovery(s.concat(at(Array(70).fill(130), T0 + 8000)), T0 + 1000, 60)
    expect(r.peak).toBe(172)
  })
  it('is null when nothing was recorded a minute later', () => {
    expect(recovery(at([170, 170]), T0, 60)).toBeNull()
    expect(recovery([], T0, 60)).toBeNull()
  })
})

describe('downsample / expand', () => {
  it('keeps the peak of each bucket, so spikes survive the shrink', () => {
    const s = at([100, 180, 100, 100, 100, 100, 100, 100, 100, 100, 90])
    const packed = downsample(s, T0, 10)
    expect(packed[0]).toEqual([0, 180])
    expect(packed[1]).toEqual([10, 90])
  })
  it('shrinks an hour at 1 Hz by roughly ten times', () => {
    const hour = at(Array(3600).fill(140))
    expect(downsample(hour, T0, 10).length).toBe(360)
  })
  it('round-trips back to a readable series', () => {
    const s = at([100, 120, 140])
    const back = expand(downsample(s, T0, 10), T0)
    expect(back[0]).toEqual({ ms: T0, bpm: 140 })
  })
  it('handles an empty series', () => {
    expect(downsample([], T0)).toEqual([])
    expect(expand(null, T0)).toEqual([])
  })
})

describe('summarize', () => {
  const cfg = { maxBpm: 200, restBpm: 60, sex: 'male', age: 30, weightKg: 80 }
  it('is null for a window with no samples', () => {
    expect(summarize([], cfg, T0, T0 + 1000)).toBeNull()
  })
  it('reports percentages against max for both mean and peak', () => {
    const hr = summarize(at([140, 150, 160]), cfg, T0, T0 + 3000)
    expect(hr.avg).toBe(150)
    expect(hr.pctMax).toBe(75)
    expect(hr.peakPctMax).toBe(80)
    expect(hr.zone).toBe(2)
    expect(hr.peakZone).toBe(3)
  })
})

describe('analyzeWorkout', () => {
  const cfg = { maxBpm: 200, restBpm: 60, sex: 'male', age: 30, weightKg: 80 }
  // Two exercises, two sets each, 40 s apart, then two quiet minutes.
  const w = {
    start: T0, end: T0 + 200000,
    entries: [
      { id: 'squat', sets: [{ done: true, hrw: [T0, T0 + 20000] }, { done: true, hrw: [T0 + 40000, T0 + 60000] }] },
      { id: 'bench', sets: [{ done: true, hrw: [T0 + 90000, T0 + 110000] }, { done: false }] }
    ]
  }
  const series = at(
    [...Array(60).fill(160), ...Array(30).fill(100), ...Array(20).fill(150), ...Array(90).fill(105)]
  )

  it('is null with no heart-rate data at all', () => {
    expect(analyzeWorkout(w, [], cfg)).toBeNull()
  })

  it('summarises the whole session and every exercise in it', () => {
    const hr = analyzeWorkout(w, series, cfg)
    expect(hr.avg).toBeGreaterThan(100)
    expect(hr.exercises).toHaveLength(2)
    expect(hr.exercises[0].id).toBe('squat')
    expect(hr.exercises[0].hr.max).toBe(160)
    expect(hr.exercises[1].hr.max).toBe(150)
  })

  it('indexes exercises positionally, so the same lift twice keeps both', () => {
    const twice = {
      ...w,
      entries: [w.entries[0], { id: 'squat', sets: [{ done: true, hrw: [T0 + 90000, T0 + 110000] }] }]
    }
    const hr = analyzeWorkout(twice, series, cfg)
    expect(hr.exercises.map(e => e.i)).toEqual([0, 1])
    expect(hr.exercises[0].hr.max).not.toBe(hr.exercises[1].hr.max)
  })

  it('spans an exercise from its first set to its last, rest between included', () => {
    const hr = analyzeWorkout(w, series, cfg)
    // The squat spans T0..T0+60000: sixty seconds at 160, plus the one sample
    // sitting exactly on the closing instant. Window ends are inclusive — the
    // beat at the moment you tick the box belongs to the set you just did —
    // so that first 100 is in, and pulls the mean down by a beat.
    expect(hr.exercises[0].hr.avg).toBe(159)
  })

  it('still scores a set logged faster than the strap samples', () => {
    // Both sets of the second exercise close inside a single sampling gap.
    const quick = {
      ...w,
      entries: [{ id: 'row', sets: [{ done: true, hrw: [T0 + 30400, T0 + 30500] }] }]
    }
    const hr = analyzeWorkout(quick, series, cfg).exercises[0].hr
    expect(hr.n).toBe(1)
    expect(hr.avg).toBeGreaterThan(0)
  })
  it('gives an exercise with no logged window no summary rather than a zero one', () => {
    const none = { ...w, entries: [{ id: 'curl', sets: [{ done: false }] }] }
    expect(analyzeWorkout(none, series, cfg).exercises[0].hr).toBeNull()
  })

  it('keeps a per-set breakdown and a recovery reading', () => {
    const hr = analyzeWorkout(w, series, cfg)
    expect(hr.exercises[0].hr.sets).toHaveLength(2)
    expect(hr.exercises[0].hr.sets[0].max).toBe(160)
    expect(hr.exercises[0].hr.recovery.drop).toBeGreaterThan(0)   // 160 → 100 after the last squat set
  })

  it('carries the curve and the constants it was scored against', () => {
    const hr = analyzeWorkout(w, series, cfg)
    expect(hr.series.length).toBeGreaterThan(0)
    expect(hr.startMs).toBe(T0)
    expect(hr.cfg).toEqual({ maxBpm: 200, restBpm: 60 })
  })
})
