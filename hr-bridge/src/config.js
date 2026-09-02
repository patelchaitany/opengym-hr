// Central configuration, loaded from environment variables with sane defaults.
// We intentionally avoid a dotenv dependency: if a `.env` file exists we parse
// it ourselves (tiny, dependency-free) so `npm install` stays lean.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function loadDotEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

export const config = {
  rootDir,
  server: {
    // 3001, not 3000: in the combined repo the openGym API owns 3000.
    port: Number(process.env.PORT) || 3001,
    // 0.0.0.0 by default so a phone on the same Wi-Fi can reach the bridge —
    // this only ever serves heart-rate numbers, and openGym on a phone is the
    // whole point. Set HOST=127.0.0.1 to keep it on the laptop.
    host: process.env.HOST || '0.0.0.0',
    // Browsers block a cross-origin fetch from openGym (:8080) to the bridge
    // (:3001) without this. '*' is the default because the payload is a bpm
    // number and there is no auth to steal; set HR_CORS_ORIGIN to lock it down.
    corsOrigin: process.env.HR_CORS_ORIGIN || '*',
  },
  ble: {
    // Case-insensitive substring match against the advertised local name.
    nameFilter: (process.env.BLE_NAME_FILTER || '').trim(),
    // Exact match against peripheral.address or peripheral.id.
    addressFilter: (process.env.BLE_ADDRESS_FILTER || '').trim().toLowerCase(),
  },
  // Fake heart rate instead of a radio. Lets you develop the gym app, run the
  // demo and test the whole pipeline on a machine with no Bluetooth and no
  // strap. `npm run start:sim`.
  simulate: truthy(process.env.HR_SIMULATE),
  // How much history the bridge keeps so the gym app can ask for the samples
  // that fell inside a set it just finished. 4 h at ~1 Hz covers any session,
  // and a reading is ~60 bytes, so this is a few MB at worst.
  retentionSec: Number(process.env.HR_RETENTION_SEC) || 4 * 3600,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI || 'http://127.0.0.1:3001/oauth/callback',
    tokenFile: path.join(rootDir, '.google-tokens.json'),
  },
};

export function googleConfigured() {
  return Boolean(config.google.clientId && config.google.clientSecret);
}
