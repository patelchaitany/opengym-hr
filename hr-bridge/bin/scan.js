#!/usr/bin/env node
// Discover nearby BLE devices, or dump the full GATT table of one device.
//
//   npm run scan                 list advertising devices for ~8s
//   npm run scan -- --all        include non heart-rate devices
//   npm run scan -- --gatt       connect to first HR device, dump services
//   npm run scan -- --gatt fitbit connect to device whose name/id matches "fitbit"

import { discoverDevices, dumpGatt } from '../src/ble/scan.js';

const args = process.argv.slice(2);
const wantGatt = args.includes('--gatt');
const wantAll = args.includes('--all');
const match = args.find((a) => !a.startsWith('--')) || '';

async function run() {
  if (wantGatt) {
    console.log(`Connecting to device${match ? ` matching "${match}"` : ' (first Heart Rate device)'} ...\n`);
    const { device, table } = await dumpGatt({ match });
    console.log(`Device: ${device.name || '(unnamed)'}  [${device.address || device.id}]  rssi=${device.rssi}\n`);
    for (const svc of table) {
      console.log(`● Service ${svc.service}`);
      for (const c of svc.characteristics) {
        console.log(`    └ ${c.name.padEnd(34)} [${c.properties.join(', ')}]`);
      }
      console.log('');
    }
    process.exit(0);
  }

  const serviceUuids = wantAll ? [] : ['180d'];
  console.log(
    `Scanning for ${wantAll ? 'all BLE devices' : 'Heart Rate devices (0x180D)'} for 8s...\n` +
      `(Tip: enable heart-rate sharing on your Fitbit Air so it advertises.)\n`,
  );
  const devices = await discoverDevices({ serviceUuids });
  if (!devices.length) {
    console.log('No devices found. Make sure the device is nearby and advertising.');
    process.exit(0);
  }
  for (const d of devices) {
    console.log(
      `${(d.name || '(unnamed)').padEnd(24)} ${(d.address || d.id).padEnd(38)} rssi=${d.rssi}` +
        (d.serviceUuids?.length ? `  services=[${d.serviceUuids.join(', ')}]` : ''),
    );
  }
  process.exit(0);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
