#!/usr/bin/env node
// Print live heart rate to the terminal. No server, no dashboard — just the
// Bluetooth stream. Great for a quick "does my device work?" check.
//
//   npm run hr
//   npm run hr -- --name fitbit     only connect to a device matching "fitbit"

import { config } from '../src/config.js';
import { HeartRateMonitor } from '../src/ble/heartRate.js';

const args = process.argv.slice(2);
const nameIdx = args.indexOf('--name');
const nameFilter = nameIdx !== -1 ? args[nameIdx + 1] : config.ble.nameFilter;

const monitor = new HeartRateMonitor({ nameFilter, addressFilter: config.ble.addressFilter });

monitor.on('status', ({ status, detail }) => {
  console.log(`• ${status}${detail ? `: ${detail}` : ''}`);
});
monitor.on('discover', (d) => {
  if (d.name) console.log(`  found: ${d.name} [${d.address || d.id}] rssi=${d.rssi}`);
});
monitor.on('battery', (pct) => console.log(`  battery: ${pct}%`));
monitor.on('sensorLocation', (loc) => console.log(`  sensor location: ${loc}`));
monitor.on('heartRate', (r) => {
  const rr = r.rrIntervals?.length ? `  rr=[${r.rrIntervals.join(', ')}]ms` : '';
  const contact = r.contact === false ? '  (no skin contact)' : '';
  console.log(`♥ ${String(r.bpm).padStart(3)} bpm${rr}${contact}`);
});
monitor.on('error', (err) => console.error('  error:', err.message));

console.log('Starting live heart-rate reader. Enable HR sharing on your device. Ctrl+C to stop.\n');
await monitor.start();

const stop = async () => {
  await monitor.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
