// Pre-flight guidance for Bluetooth access.
//
// On macOS, any process that touches CoreBluetooth must belong to an app that
// (a) declares an NSBluetoothAlwaysUsageDescription and (b) has been granted
// Bluetooth permission in System Settings. A bare `node` binary has neither, so
// instead of showing a prompt, macOS *hard-aborts the process with SIGABRT*
// (exit 134) the instant the Bluetooth adapter is accessed. That abort happens
// inside the native binding and cannot be caught with try/catch — so the only
// useful thing we can do is warn clearly *before* it happens.
//
// This module prints that guidance and is a no-op on Linux/Windows.

import os from 'node:os';

const isMac = process.platform === 'darwin';

// Best-effort: name the terminal app that macOS will hold responsible, so the
// instructions are concrete ("grant Warp / iTerm / Terminal", not "your app").
function responsibleAppHint() {
  const term = process.env.TERM_PROGRAM || '';
  const map = {
    'WarpTerminal': 'Warp',
    'iTerm.app': 'iTerm',
    'Apple_Terminal': 'Terminal',
    'vscode': 'Visual Studio Code',
    'ghostty': 'Ghostty',
  };
  return map[term] || term || 'your terminal app';
}

/**
 * Print macOS Bluetooth-permission guidance. Call once before noble loads.
 * @param {{ throwIfLikelyBlocked?: boolean }} [opts]
 */
export function bluetoothPreflight() {
  if (!isMac) return;

  const app = responsibleAppHint();
  const line = '─'.repeat(64);
  const msg = [
    '',
    line,
    ' macOS Bluetooth permission required',
    line,
    ` If this process aborts (exit 134 / "abort") right after "powering on`,
    '  Bluetooth adapter", macOS blocked it for lack of Bluetooth permission.',
    '',
    '  Fix it once:',
    `   1. Open  System Settings → Privacy & Security → Bluetooth`,
    `      (run:  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth" )`,
    `   2. Enable Bluetooth access for "${app}" (add it with + if it is not listed).`,
    `   3. Run this in a plain ${app} tab — NOT nested inside another tool —`,
    '      so the process tree is short (terminal → node). Deep nesting makes',
    '      macOS blame bare "node", which can crash instead of prompting.',
    '',
    `  If ${app} still aborts, run it in Apple's Terminal.app, which reliably`,
    '  shows the permission prompt, and click "Allow".',
    line,
    '',
  ].join('\n');

  process.stderr.write(msg);
}

export const platformInfo = {
  isMac,
  platform: process.platform,
  release: os.release(),
  responsibleApp: responsibleAppHint(),
};
