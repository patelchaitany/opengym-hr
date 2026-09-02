// Client for the heart-rate bridge (../../hr-bridge) — the half of this app
// that talks to the Fitbit Air.
//
// Two channels, on purpose:
//
//   · the WebSocket at /ws is the live one. Every beat the strap sends arrives
//     here about a second later, which is what puts a number on the screen
//     while you are under the bar.
//   · /api/heart-rate/range is the accurate one. A phone that locked its screen
//     mid-set received none of those beats, but the bridge did — it keeps hours
//     of history — so when a set is checked off, and again when the workout is
//     finished, the app asks for the samples that actually happened rather than
//     trusting what its own socket managed to catch.
//
// Nothing here is authenticated: the bridge is a box on your own network
// handing out a pulse, and adding a login to it would mean a second set of
// credentials for a number your gym's treadmill will also happily broadcast.

import { MOBILE } from './mobile.js'

// Same-origin by default: the nginx in front of openGym proxies /hr to the
// bridge, so the phone needs no address and no CORS. An explicit URL in
// Settings (http://192.168.1.20:3001) is for running the app straight from
// Vite, or pointing at a bridge on another machine.
export const DEFAULT_BASE = '/hr'

export function normalizeBase(url) {
  const u = (url || '').trim().replace(/\/+$/, '')
  if (!u) return DEFAULT_BASE
  if (/^https?:\/\//i.test(u) || u.startsWith('/')) return u
  return 'http://' + u
}

export function httpBase(url) {
  const b = normalizeBase(url)
  return b.startsWith('/') ? location.origin + b : b
}

export function wsUrl(url) {
  const b = httpBase(url)
  return b.replace(/^http/i, 'ws') + '/ws'
}

// A page served over HTTPS cannot open ws:// or fetch http:// — the browser
// drops it with no useful error. Worth naming, because "bridge offline" is the
// wrong diagnosis and sends people looking at their strap.
//
// The native build is the exception, and it matters: Capacitor serves the app
// from https://localhost, and the bridge on your LAN is plain http, so this
// would refuse every connection the Android app will ever make. There the
// WebView is explicitly configured to allow it (android.allowMixedContent in
// capacitor.config.json, plus network_security_config.xml), so the block this
// is warning about does not apply.
export function mixedContentBlocked(url) {
  if (MOBILE) return false
  const b = httpBase(url)
  return location.protocol === 'https:' && b.startsWith('http:')
}

const FETCH_TIMEOUT = 6000

async function getJSON(url, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.json()
  } finally { clearTimeout(timer) }
}

/** Is a bridge there, and what is it connected to? Used by Settings' test button. */
export const fetchInfo = base => getJSON(httpBase(base) + '/api/info')

/** Every sample between two instants (epoch ms). The accurate channel. */
export async function fetchRange(base, from, to) {
  const q = new URLSearchParams({ from: String(Math.round(from)) })
  if (to != null) q.set('to', String(Math.round(to)))
  // A whole session can be thousands of samples over a phone's Wi-Fi; give it
  // longer than a liveness check gets.
  const data = await getJSON(`${httpBase(base)}/api/heart-rate/range?${q}`, 15000)
  return data.samples || []
}

/**
 * Hold a live connection to the bridge, reconnecting on its own.
 *
 * The socket is the thing most likely to go away mid-workout — the laptop
 * sleeps, the Wi-Fi hands over, the strap slips — and none of that should need
 * the person mid-set to do anything. Backoff climbs to 15 s so a bridge that is
 * simply not running doesn't get hammered for an hour.
 *
 * @param {string} base
 * @param {{ onReading?:fn, onStatus?:fn, onSnapshot?:fn, onDevice?:fn, onBattery?:fn }} h
 * @returns {{ close: () => void }}
 */
export function connect(base, h = {}) {
  let ws = null
  let closed = false
  let attempt = 0
  let retry = null

  const say = (state, detail) => h.onStatus?.(state, detail)

  const open = () => {
    if (closed) return
    if (mixedContentBlocked(base)) {
      say('error', 'mixed-content')
      return // retrying cannot help; the browser will refuse every time
    }
    say(attempt === 0 ? 'connecting' : 'reconnecting')
    let sock
    try { sock = new WebSocket(wsUrl(base)) } catch (e) { schedule(); return }
    ws = sock

    sock.onopen = () => { attempt = 0; say('live') }
    sock.onmessage = ev => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const p = msg.payload
      switch (msg.type) {
        case 'snapshot':
          h.onSnapshot?.(p)
          break
        case 'heartRate':
          h.onReading?.(p)
          break
        case 'device':
          h.onDevice?.(p)
          break
        case 'battery':
          h.onBattery?.(p)
          break
        case 'status':
          // The bridge's own view of the strap — "scanning" means it is up but
          // has nothing to listen to, which is a different problem from a
          // bridge that isn't running, and the app says so.
          h.onDevice?.(p?.device)
          say(p?.status === 'streaming' ? 'live' : 'waiting', p?.status)
          break
        default:
      }
    }
    sock.onerror = () => { /* onclose always follows; handle it there */ }
    sock.onclose = () => { if (ws === sock) { ws = null; schedule() } }
  }

  const schedule = () => {
    if (closed) return
    say('offline')
    const delay = Math.min(15000, 1000 * 2 ** attempt++)
    clearTimeout(retry)
    retry = setTimeout(open, delay)
  }

  open()

  return {
    close() {
      closed = true
      clearTimeout(retry)
      try { ws?.close() } catch { /* already gone */ }
      ws = null
    }
  }
}
