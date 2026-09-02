// Heart rate read by this device's own Bluetooth radio.
//
// The other source (hrbridge.js) has a computer do the Bluetooth and hand the
// numbers over Wi-Fi. That works, but it means carrying a laptop to the gym.
// This one talks to the strap directly, so the phone is the whole system.
//
// It speaks exactly the same profile the bridge does — Heart Rate Service
// 0x180D, Heart Rate Measurement 0x2A37, the Bluetooth SIG standard that gym
// equipment, Peloton and Zwift all use — and exposes the same interface as
// `connect()` in hrbridge.js, so useHR can hold either one without caring
// which it got.
//
// What you give up by not having the bridge: the bridge is a mains-powered
// machine that kept listening while your phone's screen was off, and its
// history could be re-read after the fact. Here the phone is the receiver, so
// anything it misses is missed for good — see the note on the workout wake
// lock in useHR.

import { MOBILE } from './mobile.js'

// 16-bit SIG UUIDs, expanded to the 128-bit form the plugin wants.
const uuid = n => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`
export const HR_SERVICE = uuid(0x180d)
export const HR_MEASUREMENT = uuid(0x2a37)
export const BODY_SENSOR_LOCATION = uuid(0x2a38)
export const BATTERY_SERVICE = uuid(0x180f)
export const BATTERY_LEVEL = uuid(0x2a19)

const BODY_SENSOR_LOCATIONS = ['Other', 'Chest', 'Wrist', 'Finger', 'Hand', 'Ear Lobe', 'Foot']

/**
 * Parse a Heart Rate Measurement (0x2A37) notification per the Bluetooth SIG
 * spec. Ported from the bridge's Node implementation — same bytes, same
 * layout, a DataView instead of a Buffer — so a strap reads identically
 * whichever source picked it up.
 *
 * Byte 0 is a flags field: bit 0 says whether the rate is 8- or 16-bit, bits
 * 1-2 carry sensor contact, bit 3 says an energy-expended field follows, and
 * bit 4 says the rest of the packet is R-R intervals.
 * @param {DataView} view
 */
export function parseHeartRateMeasurement(view) {
  const flags = view.getUint8(0)
  const is16bit = (flags & 0x01) !== 0
  const contactStatus = (flags >> 1) & 0x03   // 0-1: unsupported, 2: no contact, 3: contact
  const energyPresent = (flags & 0x08) !== 0
  const rrPresent = (flags & 0x10) !== 0

  let offset = 1
  let bpm
  if (is16bit) { bpm = view.getUint16(offset, true); offset += 2 }
  else { bpm = view.getUint8(offset); offset += 1 }

  let energyExpended = null
  if (energyPresent) { energyExpended = view.getUint16(offset, true); offset += 2 }

  // R-R intervals are in units of 1/1024 s; milliseconds is what HRV wants.
  const rrIntervals = []
  if (rrPresent) {
    while (offset + 1 < view.byteLength) {
      rrIntervals.push(Math.round((view.getUint16(offset, true) / 1024) * 1000))
      offset += 2
    }
  }

  // "Unsupported" and "not touching skin" are different answers and only the
  // second one is worth telling someone about, so the first stays null.
  const contact = contactStatus >= 2 ? contactStatus === 3 : null
  return { bpm, contact, energyExpended, rrIntervals, flags }
}

// Loaded on demand: the plugin pulls in the Capacitor bridge, and a browser
// using the hr-bridge source should never pay for it.
let clientPromise = null
function ble() {
  if (!clientPromise) clientPromise = import('@capacitor-community/bluetooth-le').then(m => m.BleClient)
  return clientPromise
}

/**
 * Can this device read a strap itself?
 *
 * True in the Android/iOS app. In a browser it depends on Web Bluetooth, which
 * Chrome and Edge have and Firefox and Safari do not — so the option is
 * offered where it works rather than promised everywhere.
 */
export const nativeHRSupported = () => MOBILE || (typeof navigator !== 'undefined' && !!navigator.bluetooth)

let initialized = false
async function init() {
  const BleClient = await ble()
  if (!initialized) {
    // androidNeverForLocation pairs with the neverForLocation flag in the
    // manifest: it tells Android this app does not infer your whereabouts from
    // what Bluetooth devices are nearby, which is true, and is what keeps the
    // app from having to ask for location permission just to read a pulse.
    await BleClient.initialize({ androidNeverForLocation: true })
    initialized = true
  }
  return BleClient
}

/** Is the radio switched on? Returns null where the platform won't say. */
export async function bluetoothEnabled() {
  try { return await (await init()).isEnabled() } catch { return null }
}
export async function requestBluetooth() {
  try { await (await init()).requestEnable() } catch { /* user declined, or unsupported */ }
}

/**
 * Show the system device picker, filtered to things broadcasting heart rate.
 * Must be called from a user gesture — Web Bluetooth requires one, and it is
 * good manners on a phone too.
 * @returns {Promise<{id: string, name: string|null}>}
 */
export async function pickDevice() {
  const BleClient = await init()
  const device = await BleClient.requestDevice({
    services: [HR_SERVICE],
    // Listed so the connection is allowed to read them afterwards; on web,
    // anything not declared up front is off limits for the whole session.
    optionalServices: [BATTERY_SERVICE]
  })
  return { id: device.deviceId, name: device.name || null }
}

/**
 * Hold a live connection to a strap, reconnecting on its own.
 *
 * Same handler shape and same return value as hrbridge.js's connect(), so the
 * two are interchangeable from the store's point of view.
 *
 * @param {{id: string, name?: string}} device  remembered from pickDevice()
 * @param {{ onReading?:fn, onStatus?:fn, onDevice?:fn, onBattery?:fn }} h
 * @returns {{ close: () => void }}
 */
export function connectDevice(device, h = {}) {
  let closed = false
  let attempt = 0
  let retry = null
  let connected = false

  const say = (state, detail) => h.onStatus?.(state, detail)
  const id = device?.id

  const onNotification = view => {
    try {
      const parsed = parseHeartRateMeasurement(view)
      if (!(parsed.bpm > 0)) return
      const now = Date.now()
      h.onReading?.({ ...parsed, deviceId: id, ms: now, at: new Date(now).toISOString() })
    } catch { /* a malformed packet is not worth tearing the connection down for */ }
  }

  const open = async () => {
    if (closed) return
    if (!id) { say('error', 'no-device'); return }
    say(attempt === 0 ? 'connecting' : 'reconnecting')
    try {
      const BleClient = await init()

      if ((await BleClient.isEnabled().catch(() => true)) === false) {
        // Nothing to retry against until the radio comes back, and hammering a
        // disabled adapter just drains the battery faster.
        say('error', 'bluetooth-off')
        return
      }

      await BleClient.connect(id, () => {
        // The strap walked away, went to sleep, or stopped sharing.
        connected = false
        if (!closed) schedule()
      })
      if (closed) { try { await BleClient.disconnect(id) } catch { /* */ } return }
      connected = true
      h.onDevice?.({ id, name: device.name || null, address: id })

      // Both optional, both nice to have, neither worth failing a connection
      // over: plenty of straps expose no battery service at all.
      try {
        const loc = await BleClient.read(id, HR_SERVICE, BODY_SENSOR_LOCATION)
        const n = loc.getUint8(0)
        h.onDevice?.({ id, name: device.name || null, address: id, sensorLocation: BODY_SENSOR_LOCATIONS[n] || `Unknown (${n})` })
      } catch { /* not exposed */ }
      try {
        const batt = await BleClient.read(id, BATTERY_SERVICE, BATTERY_LEVEL)
        h.onBattery?.(batt.getUint8(0))
      } catch { /* not exposed */ }

      await BleClient.startNotifications(id, HR_SERVICE, HR_MEASUREMENT, onNotification)
      if (closed) { try { await BleClient.disconnect(id) } catch { /* */ } return }
      attempt = 0
      say('live')
    } catch (err) {
      connected = false
      // Google's HR sharing can require bonding before it will stream, which
      // surfaces here as a security/GATT error rather than a refused
      // connection — worth naming, because the fix is a pairing prompt and not
      // anything the app can do.
      const msg = String(err?.message || err)
      say('offline', /encrypt|bond|pair|auth|insufficient/i.test(msg) ? 'pairing-required' : null)
      schedule()
    }
  }

  const schedule = () => {
    if (closed) return
    say('offline')
    // Climbs to 15 s, matching the bridge client: a strap that is simply not
    // being worn should not be chased for an hour.
    const delay = Math.min(15000, 1000 * 2 ** attempt++)
    clearTimeout(retry)
    retry = setTimeout(open, delay)
  }

  open()

  return {
    close() {
      closed = true
      clearTimeout(retry)
      if (!connected || !id) return
      // Stop notifications before disconnecting: leaving a subscription open on
      // the peripheral is how a strap ends up refusing the next connection.
      ble().then(async BleClient => {
        try { await BleClient.stopNotifications(id, HR_SERVICE, HR_MEASUREMENT) } catch { /* */ }
        try { await BleClient.disconnect(id) } catch { /* */ }
      }).catch(() => { /* plugin never loaded */ })
    }
  }
}
