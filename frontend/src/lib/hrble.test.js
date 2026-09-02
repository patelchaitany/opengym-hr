import { describe, it, expect } from 'vitest'
import { parseHeartRateMeasurement, HR_SERVICE, HR_MEASUREMENT, BATTERY_LEVEL } from './hrble.js'

// Build a Heart Rate Measurement (0x2A37) packet the way a strap would.
const packet = bytes => new DataView(Uint8Array.from(bytes).buffer)

describe('UUIDs', () => {
  it('expands the 16-bit SIG numbers to the 128-bit form the plugin wants', () => {
    expect(HR_SERVICE).toBe('0000180d-0000-1000-8000-00805f9b34fb')
    expect(HR_MEASUREMENT).toBe('00002a37-0000-1000-8000-00805f9b34fb')
    expect(BATTERY_LEVEL).toBe('00002a19-0000-1000-8000-00805f9b34fb')
  })
})

describe('parseHeartRateMeasurement', () => {
  it('reads an 8-bit rate, the common case', () => {
    // flags 0x00: 8-bit rate, no contact bits, no energy, no RR
    expect(parseHeartRateMeasurement(packet([0x00, 72]))).toMatchObject({ bpm: 72, rrIntervals: [] })
  })

  it('reads a 16-bit rate, little-endian', () => {
    // flags 0x01 sets the 16-bit bit; 0x2C 0x01 = 300
    expect(parseHeartRateMeasurement(packet([0x01, 0x2c, 0x01])).bpm).toBe(300)
    // and a value that fits in a byte still has to come back right
    expect(parseHeartRateMeasurement(packet([0x01, 0x96, 0x00])).bpm).toBe(150)
  })

  it('distinguishes "not touching skin" from "cannot tell"', () => {
    // bits 1-2 = 0b00 or 0b01 → the strap does not report contact at all
    expect(parseHeartRateMeasurement(packet([0x00, 70])).contact).toBeNull()
    expect(parseHeartRateMeasurement(packet([0x02, 70])).contact).toBeNull()
    // 0b10 (0x04) → supported, not in contact
    expect(parseHeartRateMeasurement(packet([0x04, 70])).contact).toBe(false)
    // 0b11 (0x06) → supported, in contact
    expect(parseHeartRateMeasurement(packet([0x06, 70])).contact).toBe(true)
  })

  it('reads energy expended when the flag says it is there', () => {
    // flags 0x08; 0xE8 0x03 = 1000 kJ
    const r = parseHeartRateMeasurement(packet([0x08, 65, 0xe8, 0x03]))
    expect(r).toMatchObject({ bpm: 65, energyExpended: 1000 })
  })

  it('converts R-R intervals from 1/1024 s to milliseconds', () => {
    // flags 0x10; 1024 units = exactly 1000 ms, 512 = 500 ms
    const r = parseHeartRateMeasurement(packet([0x10, 60, 0x00, 0x04, 0x00, 0x02]))
    expect(r.rrIntervals).toEqual([1000, 500])
  })

  it('reads energy and R-R together, in spec order', () => {
    // flags 0x18 = energy (0x08) + RR (0x10); energy comes first in the packet
    const r = parseHeartRateMeasurement(packet([0x18, 55, 0x64, 0x00, 0x00, 0x04]))
    expect(r).toMatchObject({ bpm: 55, energyExpended: 100, rrIntervals: [1000] })
  })

  it('handles every field at once with a 16-bit rate', () => {
    const r = parseHeartRateMeasurement(packet([0x1f, 0x2c, 0x01, 0x64, 0x00, 0x00, 0x04, 0x00, 0x02]))
    expect(r).toMatchObject({
      bpm: 300, contact: true, energyExpended: 100, rrIntervals: [1000, 500]
    })
  })

  it('ignores a trailing odd byte rather than reading past the buffer', () => {
    // A truncated final R-R value must not throw or produce a garbage interval.
    const r = parseHeartRateMeasurement(packet([0x10, 60, 0x00, 0x04, 0x00]))
    expect(r.rrIntervals).toEqual([1000])
  })

  it('reports no R-R intervals when the flag is clear, even if bytes follow', () => {
    expect(parseHeartRateMeasurement(packet([0x00, 60, 0x00, 0x04])).rrIntervals).toEqual([])
  })

  it('matches what the simulator and the bridge produce', () => {
    // The bridge's simulator emits flags 0x10 with one RR interval; the app has
    // to read its own fixture identically to a real strap's packet.
    const r = parseHeartRateMeasurement(packet([0x10, 148, 0x9f, 0x01]))
    expect(r.bpm).toBe(148)
    expect(r.rrIntervals).toHaveLength(1)
    expect(r.rrIntervals[0]).toBeCloseTo(Math.round((415 / 1024) * 1000), 0)
  })
})
