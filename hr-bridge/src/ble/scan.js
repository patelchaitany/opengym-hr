// BLE exploration helpers: enumerate advertising devices, and dump the full
// GATT table (services + characteristics + properties) of one device.
//
// This is the tool you use to *see what a device actually exposes* — the
// honest first step of any "reverse engineering". For the Fitbit Air you'll
// see the standard Heart Rate (0x180D), Battery (0x180F) and Device
// Information (0x180A) services when sharing is enabled, plus any vendor
// services (which are encrypted and reserved for the Google Health app).

import { createRequire } from 'node:module';
import { logger } from '../util/logger.js';
import { bluetoothPreflight } from './preflight.js';

const require = createRequire(import.meta.url);

function loadNoble() {
  bluetoothPreflight();
  const mod = require('@abandonware/noble');
  return mod?.default ?? mod;
}

// Human-friendly names for common 16-bit UUIDs.
const KNOWN = {
  '1800': 'Generic Access',
  '1801': 'Generic Attribute',
  '180a': 'Device Information',
  '180d': 'Heart Rate',
  '180f': 'Battery',
  '2a00': 'Device Name',
  '2a19': 'Battery Level',
  '2a24': 'Model Number',
  '2a25': 'Serial Number',
  '2a26': 'Firmware Revision',
  '2a29': 'Manufacturer Name',
  '2a37': 'Heart Rate Measurement',
  '2a38': 'Body Sensor Location',
  '2a39': 'Heart Rate Control Point',
};

const label = (uuid) => (KNOWN[uuid] ? `${uuid} (${KNOWN[uuid]})` : uuid);

/**
 * Scan for advertising BLE devices for `durationMs` and return a de-duplicated
 * list. Pass `serviceUuids` to filter (e.g. ['180d']) or [] for everything.
 */
export function discoverDevices({ durationMs = 8000, serviceUuids = [] } = {}) {
  return new Promise((resolve, reject) => {
    const noble = loadNoble();
    const found = new Map();

    const onDiscover = (p) => {
      const adv = p.advertisement || {};
      found.set(p.id, {
        id: p.id,
        name: adv.localName || null,
        address: p.address || null,
        rssi: p.rssi,
        serviceUuids: adv.serviceUuids || [],
      });
    };

    const finish = () => {
      noble.removeListener('discover', onDiscover);
      noble.stopScanning();
      resolve([...found.values()].sort((a, b) => (b.rssi || -999) - (a.rssi || -999)));
    };

    noble.on('discover', onDiscover);

    const begin = () => {
      noble.startScanning(serviceUuids, true, (err) => err && reject(err));
      setTimeout(finish, durationMs);
    };

    if (noble.state === 'poweredOn') begin();
    else
      noble.once('stateChange', (state) => {
        if (state === 'poweredOn') begin();
        else reject(new Error(`Bluetooth adapter not available (state: ${state})`));
      });
  });
}

/**
 * Connect to a single device (by id/address substring or the first match) and
 * return its full GATT table.
 */
export function dumpGatt({ match = '', durationMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const noble = loadNoble();
    const needle = match.toLowerCase();
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      noble.stopScanning();
      reject(new Error('Timed out finding a matching device. Is sharing enabled and the device nearby?'));
    }, durationMs);

    const onDiscover = async (p) => {
      if (done) return;
      const adv = p.advertisement || {};
      const name = (adv.localName || '').toLowerCase();
      const addr = (p.address || '').toLowerCase();
      const id = (p.id || '').toLowerCase();
      const isMatch = !needle || name.includes(needle) || addr === needle || id === needle;
      if (!isMatch) return;

      done = true;
      clearTimeout(timer);
      noble.stopScanning();
      noble.removeListener('discover', onDiscover);

      try {
        logger.info(`[scan] connecting to ${adv.localName || p.address || p.id} ...`);
        await p.connectAsync();
        const services = await p.discoverServicesAsync([]);
        const table = [];
        for (const svc of services) {
          const chars = await svc.discoverCharacteristicsAsync([]);
          table.push({
            service: label(svc.uuid),
            uuid: svc.uuid,
            characteristics: chars.map((c) => ({
              uuid: c.uuid,
              name: label(c.uuid),
              properties: c.properties,
            })),
          });
        }
        const device = {
          id: p.id,
          name: adv.localName || null,
          address: p.address || null,
          rssi: p.rssi,
        };
        await p.disconnectAsync();
        resolve({ device, table });
      } catch (err) {
        reject(err);
      }
    };

    noble.on('discover', onDiscover);

    const begin = () => noble.startScanning([], true, (err) => err && reject(err));
    if (noble.state === 'poweredOn') begin();
    else
      noble.once('stateChange', (state) => {
        if (state === 'poweredOn') begin();
        else reject(new Error(`Bluetooth adapter not available (state: ${state})`));
      });
  });
}
