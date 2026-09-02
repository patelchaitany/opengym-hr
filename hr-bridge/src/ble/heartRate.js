// Live heart-rate reader over Bluetooth Low Energy.
//
// The Google Fitbit Air (like the Charge 6 and Pixel Watch) implements the
// *standard* BLE Heart Rate Service (0x180D). When you enable heart-rate
// sharing on the device, it advertises and lets a central connect and
// subscribe to the Heart Rate Measurement characteristic (0x2A37), which
// pushes a notification roughly once per second. This is the same profile
// Peloton, Zwift and gym equipment use — no proprietary/encrypted protocol.
//
// This module is device-agnostic: it works with the Fitbit Air, a chest
// strap, a Polar/Garmin sensor, or anything else exposing 0x180D.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { logger } from '../util/logger.js';
import { bluetoothPreflight } from './preflight.js';

// @abandonware/noble ships as CommonJS; load it via createRequire so this ESM
// module can consume it. We load lazily inside start() so that importing this
// file (e.g. for tests) never powers up the Bluetooth radio.
const require = createRequire(import.meta.url);

// Standard 16-bit GATT UUIDs, lowercased and dash-free as noble expects.
export const UUID = {
  heartRateService: '180d',
  heartRateMeasurement: '2a37',
  bodySensorLocation: '2a38',
  batteryService: '180f',
  batteryLevel: '2a19',
};

const BODY_SENSOR_LOCATIONS = [
  'Other',
  'Chest',
  'Wrist',
  'Finger',
  'Hand',
  'Ear Lobe',
  'Foot',
];

/**
 * Parse a Heart Rate Measurement (0x2A37) notification buffer per the
 * Bluetooth SIG spec.
 * @param {Buffer} data
 */
export function parseHeartRateMeasurement(data) {
  const flags = data.readUInt8(0);
  const is16bit = (flags & 0x01) !== 0;
  const sensorContactStatus = (flags >> 1) & 0x03; // 0-1: unsupported, 2: no contact, 3: contact
  const energyExpendedPresent = (flags & 0x08) !== 0;
  const rrPresent = (flags & 0x10) !== 0;

  let offset = 1;
  let bpm;
  if (is16bit) {
    bpm = data.readUInt16LE(offset);
    offset += 2;
  } else {
    bpm = data.readUInt8(offset);
    offset += 1;
  }

  let energyExpended = null;
  if (energyExpendedPresent) {
    energyExpended = data.readUInt16LE(offset);
    offset += 2;
  }

  // RR intervals are in units of 1/1024 second; convert to milliseconds.
  const rrIntervals = [];
  if (rrPresent) {
    while (offset + 1 < data.length) {
      const raw = data.readUInt16LE(offset);
      rrIntervals.push(Math.round((raw / 1024) * 1000));
      offset += 2;
    }
  }

  let contact = null;
  if (sensorContactStatus >= 2) contact = sensorContactStatus === 3;

  return { bpm, contact, energyExpended, rrIntervals, flags };
}

export class HeartRateMonitor extends EventEmitter {
  /**
   * @param {{ nameFilter?: string, addressFilter?: string, autoReconnect?: boolean }} [opts]
   */
  constructor(opts = {}) {
    super();
    this.nameFilter = (opts.nameFilter || '').toLowerCase();
    this.addressFilter = (opts.addressFilter || '').toLowerCase();
    this.autoReconnect = opts.autoReconnect !== false;

    this.noble = null;
    this.peripheral = null;
    this.connected = false;
    this.stopped = false;
    this.lastReading = null;
    this.device = null; // { id, name, address }
  }

  _setStatus(status, detail) {
    this.status = status;
    logger.info(`[ble] ${status}${detail ? ` — ${detail}` : ''}`);
    this.emit('status', { status, detail: detail || null });
  }

  _matches(peripheral) {
    const adv = peripheral.advertisement || {};
    const name = (adv.localName || '').toLowerCase();
    const address = (peripheral.address || '').toLowerCase();
    const id = (peripheral.id || '').toLowerCase();

    if (this.addressFilter) return address === this.addressFilter || id === this.addressFilter;
    if (this.nameFilter) return name.includes(this.nameFilter);
    return true; // No filter: accept the first HR-service device we find.
  }

  async start() {
    if (this.noble) return; // already started
    this.stopped = false;

    // Print macOS permission guidance BEFORE noble touches CoreBluetooth — a
    // permission failure aborts the process natively and can't be caught.
    bluetoothPreflight();

    try {
      // Prefer the modern default export shape; fall back for older builds.
      const mod = require('@abandonware/noble');
      this.noble = mod?.default ?? mod;
    } catch (err) {
      const msg =
        'Failed to load @abandonware/noble. Run `npm install`. On macOS grant ' +
        'Bluetooth permission to your terminal; on Linux you may need ' +
        '`sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))`.';
      this._setStatus('error', msg);
      this.emit('error', new Error(`${msg}\nOriginal: ${err.message}`));
      return;
    }

    this.noble.on('stateChange', (state) => {
      logger.debug(`[ble] adapter state: ${state}`);
      if (state === 'poweredOn') {
        this._startScanning();
      } else {
        this.noble.stopScanning();
        this._setStatus('waiting', `Bluetooth adapter state: ${state}`);
      }
    });

    this.noble.on('discover', (peripheral) => this._onDiscover(peripheral));

    // If the adapter is already powered on, kick off scanning immediately.
    if (this.noble.state === 'poweredOn') this._startScanning();
    else this._setStatus('waiting', 'powering on Bluetooth adapter');
  }

  _startScanning() {
    this._setStatus('scanning', 'looking for a Heart Rate Service (0x180D)');
    // allowDuplicates=false; scan only for the HR service to keep it targeted.
    this.noble.startScanning([UUID.heartRateService], false, (err) => {
      if (err) this.emit('error', err);
    });
  }

  async _onDiscover(peripheral) {
    if (this.stopped || this.connected) return;
    const adv = peripheral.advertisement || {};

    this.emit('discover', {
      id: peripheral.id,
      name: adv.localName || null,
      address: peripheral.address || null,
      rssi: peripheral.rssi,
    });

    if (!this._matches(peripheral)) {
      logger.debug(`[ble] ignoring ${adv.localName || peripheral.id} (filter mismatch)`);
      return;
    }

    this.noble.stopScanning();
    this.peripheral = peripheral;
    await this._connect(peripheral);
  }

  async _connect(peripheral) {
    const adv = peripheral.advertisement || {};
    const label = adv.localName || peripheral.address || peripheral.id;
    this._setStatus('connecting', label);

    peripheral.once('disconnect', () => this._onDisconnect());

    try {
      await peripheral.connectAsync();
    } catch (err) {
      this._setStatus('error', `connect failed: ${err.message}`);
      this.emit('error', err);
      if (this.autoReconnect && !this.stopped) this._startScanning();
      return;
    }

    this.connected = true;
    this.device = {
      id: peripheral.id,
      name: adv.localName || null,
      address: peripheral.address || null,
    };
    this._setStatus('connected', label);
    this.emit('connected', this.device);

    try {
      await this._subscribe(peripheral);
    } catch (err) {
      // A common cause here is a bonding/pairing requirement. macOS will show a
      // system pairing prompt on first connect; accept it, then re-run.
      this._setStatus(
        'error',
        `subscribe failed: ${err.message}. If the device requires pairing, ` +
          `accept the OS pairing prompt (or pair once in system Bluetooth settings) and retry.`,
      );
      this.emit('error', err);
    }
  }

  async _subscribe(peripheral) {
    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [UUID.heartRateService, UUID.batteryService],
      [UUID.heartRateMeasurement, UUID.bodySensorLocation, UUID.batteryLevel],
    );

    const byUuid = Object.fromEntries(characteristics.map((c) => [c.uuid, c]));

    // Optional: body sensor location (read once).
    const locChar = byUuid[UUID.bodySensorLocation];
    if (locChar) {
      try {
        const buf = await locChar.readAsync();
        const loc = BODY_SENSOR_LOCATIONS[buf.readUInt8(0)] || `Unknown (${buf.readUInt8(0)})`;
        this.device.sensorLocation = loc;
        this.emit('sensorLocation', loc);
      } catch {
        /* non-fatal */
      }
    }

    // Optional: battery level (read + subscribe if it supports notify).
    const batteryChar = byUuid[UUID.batteryLevel];
    if (batteryChar) {
      try {
        const buf = await batteryChar.readAsync();
        const pct = buf.readUInt8(0);
        this.device.battery = pct;
        this.emit('battery', pct);
      } catch {
        /* non-fatal */
      }
    }

    const hrChar = byUuid[UUID.heartRateMeasurement];
    if (!hrChar) {
      throw new Error('Heart Rate Measurement characteristic (0x2A37) not found on device');
    }

    hrChar.on('data', (data) => {
      try {
        const parsed = parseHeartRateMeasurement(data);
        // `ms` is what every time-range query in the bridge and the gym app
        // works from; `at` stays for humans reading the JSON.
        const now = Date.now();
        const reading = { ...parsed, deviceId: this.device.id, ms: now, at: new Date(now).toISOString() };
        this.lastReading = reading;
        this.emit('heartRate', reading);
      } catch (err) {
        logger.warn('[ble] failed to parse HR notification', err.message);
      }
    });

    await hrChar.subscribeAsync();
    this._setStatus('streaming', 'subscribed to live heart rate');
    this.emit('streaming', this.device);
  }

  _onDisconnect() {
    this.connected = false;
    this.emit('disconnected', this.device);
    this._setStatus('disconnected', this.device?.name || '');
    if (this.autoReconnect && !this.stopped && this.noble?.state === 'poweredOn') {
      this._startScanning();
    }
  }

  async stop() {
    this.stopped = true;
    try {
      this.noble?.stopScanning();
      if (this.peripheral && this.connected) await this.peripheral.disconnectAsync();
    } catch {
      /* ignore */
    }
  }
}
