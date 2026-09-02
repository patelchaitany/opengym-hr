// The heart-rate surface: the live strip on the workout screen, a zone bar, and
// the summary block that appears on the finish sheet and in History.
//
// All three are read-only views over numbers computed elsewhere (lib/hrmetrics
// for the maths, store/useHR for the live feed), so they can be dropped into
// any screen without dragging state along.

import { useEffect, useState } from 'react'
import { useHR } from '../store/useHR.js'
import { useStore } from '../store/useStore.js'
import {
  ZONE_DEFS, zoneIndex, zoneColor, zoneName, hrConfig,
  maxHRIsEstimated, fmtMins, expand, seriesStats
} from '../lib/hrmetrics.js'
import { fmtNum } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import LineChart from './LineChart.jsx'

/* --------------------------------------------------------- live beat ----- */

// The pulse animation is driven by the actual rate, not a fixed loop: at 150
// bpm the badge beats at 150 bpm. It is the one piece of motion in the app that
// is data rather than decoration, and it makes "is this thing live?" answerable
// from across the room without reading the number.
function Beat({ bpm, dim }) {
  const dur = bpm > 0 ? Math.max(0.28, Math.min(1.4, 60 / bpm)) : 1
  return <Icon name="heart" className={'hr-beat' + (dim ? ' dim' : '')} style={{ animationDuration: dur + 's' }} />
}

// Deliberately not LineChart: no axes, no tooltip, no hover state, ~40 points.
// A 20-line path beats mounting the full chart in a header that re-renders on
// every beat.
export function HRSpark({ samples, color = 'var(--acc)', w = 54, h = 20 }) {
  if (!samples || samples.length < 2) return null
  const ys = samples.map(s => s.bpm)
  const lo = Math.min(...ys), hi = Math.max(...ys)
  const span = hi - lo || 1
  const t0 = samples[0].ms, t1 = samples[samples.length - 1].ms
  const dt = t1 - t0 || 1
  const d = samples.map((s, i) =>
    (i ? 'L' : 'M') + ((s.ms - t0) / dt * w).toFixed(1) + ',' + ((1 - (s.bpm - lo) / span) * (h - 3) + 1.5).toFixed(1)
  ).join(' ')
  return (
    <svg className="hrspark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/* --------------------------------------------------------- zone bar ------ */

/** Stacked proportional bar of seconds spent in each zone, with a legend. */
export function HRZoneBar({ zones, legend = true }) {
  const total = (zones || []).reduce((a, b) => a + b, 0)
  if (!total) return null
  return <>
    <div className="hrzbar">
      {zones.map((sec, i) => sec > 0 && (
        <i key={i} style={{ width: (sec / total * 100) + '%', background: ZONE_DEFS[i].color }}
          title={`${t(ZONE_DEFS[i].name)} · ${fmtMins(sec)}`} />
      ))}
    </div>
    {legend && <div className="hrzleg">
      {zones.map((sec, i) => sec > 0 && (
        <span key={i}><i style={{ background: ZONE_DEFS[i].color }} />{t(ZONE_DEFS[i].name)} {fmtMins(sec)}</span>
      ))}
    </div>}
  </>
}

/* ---------------------------------------------------------- summary ------ */

function Stat({ icon, value, label, tint }) {
  if (value == null) return null
  return <div className="hrstat">
    {icon && <Icon name={icon} style={tint ? { color: tint } : null} />}
    <b>{value}</b>
    <span>{label}</span>
  </div>
}

/**
 * The block of numbers for one window — a whole workout, or one exercise.
 * `hr` is what summarize() produced.
 */
export function HRSummary({ hr, compact }) {
  if (!hr) return null
  const rec = hr.recovery
  return <div className="hrsum">
    <div className="hrstats">
      <Stat icon="heart" value={hr.avg} label={t('avg bpm')} tint="var(--red)" />
      <Stat icon="arrowUp" value={hr.max} label={t('peak bpm')} tint={zoneColor(hr.peakZone)} />
      <Stat icon="bolt" value={hr.peakPctMax + '%'} label={t('of max')} tint="var(--orange)" />
      {hr.kcal != null && <Stat icon="flame" value={hr.kcal} label={t('kcal')} tint="var(--orange)" />}
      {hr.trimp > 0 && <Stat icon="chartLine" value={fmtNum(hr.trimp)} label={t('strain')} tint="var(--purple)" />}
      {hr.hrv != null && <Stat icon="sparkles" value={hr.hrv} label={t('HRV ms')} tint="var(--teal)" />}
      {rec && rec.drop > 0 && <Stat icon="arrowDown" value={'−' + rec.drop} label={t('recovery 60s')} tint="var(--green)" />}
    </div>
    {!compact && <HRZoneBar zones={hr.zones} />}
  </div>
}

/** The session curve, drawn back from the packed [sec, bpm] pairs on a workout. */
export function HRWorkoutChart({ hr, h = 130 }) {
  if (!hr?.series?.length) return null
  const pts = hr.series.map(([sec, bpm]) => ({ t: hr.startMs + sec * 1000, y: bpm }))
  return <LineChart points={pts} h={h} unit="bpm" color="var(--red)" axes={false} />
}

/* ---------------------------------------------- in-workout strip --------- */

/**
 * The one heart-rate element on the workout screen: live bpm, the zone it puts
 * you in, a two-minute trace, and what the set currently under way is doing.
 *
 * It sits under the progress bar rather than in the header because the header
 * already carries three things and this is a number you glance at repeatedly —
 * it needs to be readable at arm's length, mid-set, which a badge squeezed
 * between two icon buttons is not.
 *
 * Ticks on its own timer so a beat a second doesn't re-render the exercise tree
 * beneath it (the same reason Elapsed is its own component).
 */
export function HRStrip({ from, onClick }) {
  const S = useStore(s => s.S)
  const { bpm, stale, state, detail, source, samples } = useHR()
  const [, tick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => tick(n => n + 1), 2000)
    return () => clearInterval(iv)
  }, [])
  if (!S.hr?.on) return null

  const cfg = hrConfig(S)
  const live = bpm > 0 && !stale
  const z = live ? zoneIndex(bpm, cfg.maxBpm) : -1
  const setStats = from ? seriesStats(samples, from, Date.now()) : { n: 0 }
  const spark = samples.slice(-120)

  // Not live: say which kind of not-live it is. "Looking for your strap",
  // "Bluetooth is off" and "the bridge isn't running" send you to three
  // different places, and a single greyed-out heart sends you to none of them.
  const ble = source === 'ble'
  const trouble = detail === 'bluetooth-off' ? t('Bluetooth is off')
    : detail === 'no-device' ? t('No strap paired')
      : detail === 'pairing-required' ? t('Pair your strap in system settings')
        : state === 'error' ? (ble ? t('Bluetooth unavailable') : t('Bridge unreachable'))
          : state === 'offline' ? (ble ? t('Strap not found') : t('Bridge offline'))
            : state === 'connecting' || state === 'reconnecting' ? t('Connecting…')
              : state === 'waiting' ? t('Looking for your strap…')
                : stale ? t('Signal lost') : null

  return (
    <button className={'hrstrip' + (live ? '' : ' off')} style={{ '--hrz': zoneColor(z) }} onClick={onClick}>
      <Beat bpm={live ? bpm : 0} dim={!live} />
      <span className="hrs-n">{live ? bpm : '—'}</span>
      <span className="hrs-u">bpm</span>
      {live
        ? <span className="hrs-z">{zoneName(z)} · {Math.round(bpm / cfg.maxBpm * 100)}%</span>
        : <span className="hrs-z dim">{trouble || t('Heart rate off')}</span>}
      <span className="grow" />
      {setStats.n > 0 && <span className="hrs-set">
        {t('set')} <b>{setStats.avg}</b> / <b style={{ color: zoneColor(zoneIndex(setStats.max, cfg.maxBpm)) }}>{setStats.max}</b>
      </span>}
      {spark.length > 3 && <HRSpark samples={spark} color={live ? zoneColor(z) : 'var(--label-3)'} />}
    </button>
  )
}

/**
 * Where an exercise stands so far, from its own sets' windows. Shown under the
 * set rows: the point of piping heart rate into a lifting app is being able to
 * see that today's squats sat ten beats higher than last week's for the same
 * load, and that comparison has to live next to the exercise, not in a summary
 * you read once at the end.
 */
export function HRExerciseLine({ entry }) {
  const S = useStore(s => s.S)
  const samples = useHR(s => s.samples)
  if (!S.hr?.on) return null
  const wins = (entry.sets || []).map(s => s.hrw).filter(Boolean)
  if (!wins.length) return null
  const cfg = hrConfig(S)
  const st = seriesStats(samples, Math.min(...wins.map(w => w[0])), Math.max(...wins.map(w => w[1])))
  if (!st.n) return null
  const z = zoneIndex(st.max, cfg.maxBpm)
  return <div className="hrexline">
    <Icon name="heart" style={{ color: 'var(--red)' }} />
    <span><b>{st.avg}</b> {t('avg')}</span>
    <span><b style={{ color: zoneColor(z) }}>{st.max}</b> {t('peak')}</span>
    <span className="muted">{zoneName(z)}</span>
    {wins.length > 1 && <span className="muted">· {t('{0} sets', wins.length)}</span>}
  </div>
}

/* --------------------------------------------------------- zone table ---- */

/** The five zones and where their boundaries land for this profile. */
export function HRZoneTable() {
  const S = useStore(s => s.S)
  const cfg = hrConfig(S)
  return <div className="hrztab">
    {ZONE_DEFS.map((z, i) => {
      const from = Math.round(z.lo * cfg.maxBpm)
      const to = i === ZONE_DEFS.length - 1 ? null : Math.round(z.hi * cfg.maxBpm) - 1
      return <div key={z.key} className="hrztab-r">
        <i style={{ background: z.color }} />
        <span className="grow">{t(z.name)}</span>
        <span className="muted">{Math.round(z.lo * 100)}–{i === 4 ? '100' : Math.round(z.hi * 100)}%</span>
        <b>{from}{to ? '–' + to : '+'}</b>
      </div>
    })}
    <div className="sect-f" style={{ padding: '8px 2px 0' }}>
      {maxHRIsEstimated(S.hr)
        ? t('Estimated from your age (211 − 0.64 × age). Enter a measured maximum for zones you can trust.')
        : t('Based on the maximum heart rate you entered.')}
    </div>
  </div>
}
