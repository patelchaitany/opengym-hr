#!/usr/bin/env node
// Unified CLI dispatcher so `npx fitbit-air <command>` works after install.
//
//   fitbit-air serve    start the server + dashboard (default)
//   fitbit-air scan     discover BLE devices / dump GATT
//   fitbit-air hr       print live heart rate
//   fitbit-air auth     authorize Google Health API

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const [cmd = 'serve', ...rest] = process.argv.slice(2);
const map = {
  serve: 'src/index.js',
  start: 'src/index.js',
  scan: 'bin/scan.js',
  hr: 'bin/hr.js',
  auth: 'bin/google-auth.js',
};

const target = map[cmd];
if (!target) {
  console.error(`Unknown command: ${cmd}\nUsage: fitbit-air [serve|scan|hr|auth]`);
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(root, target), ...rest], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
