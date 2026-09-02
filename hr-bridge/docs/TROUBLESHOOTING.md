# Troubleshooting

## macOS: the process aborts (exit 134 / `abort`) right after "powering on Bluetooth adapter"

**Symptom**
```
[ble] waiting — powering on Bluetooth adapter
[1]  51100 abort  npm start
```
The process dies with SIGABRT (exit code **134**). The macOS crash report
(`~/Library/Logs/DiagnosticReports/node-*.ips`) shows:
```
namespace: TCC
This app has crashed because it attempted to access privacy-sensitive data
without a usage description. The app's Info.plist must contain an
NSBluetoothAlwaysUsageDescription key...
frame: __TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__
```

**Why**
This is **not** a bug in this project. macOS requires that any process touching
CoreBluetooth belong to an app that (1) declares a Bluetooth usage description
and (2) has been granted Bluetooth permission. The `node` binary has neither, so
macOS *hard-aborts* the process instead of showing a prompt. Because the abort
happens inside the native Bluetooth binding, it cannot be caught in JavaScript —
so the app prints a warning beforehand instead.

Deep process nesting makes this worse: if your terminal launches other tools
that launch node (e.g. `terminal → … → node`), macOS may blame bare `node`
rather than your terminal app, and crash rather than prompt.

**Fix (do this once)**
1. Open **System Settings → Privacy & Security → Bluetooth**. Shortcut:
   ```
   open "x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth"
   ```
2. **Enable Bluetooth** for your terminal app (Warp, iTerm, Terminal, VS Code…).
   If it isn't listed, click **+** and add it, or trigger the prompt via step 3.
3. Run the tool in a **plain terminal tab**, directly:
   ```
   cd fitbit-air
   npm start          # or: npm run hr
   ```
   Keep the process tree short (terminal → node). Don't run it nested inside
   another CLI/agent — that nesting is what turns the permission prompt into a
   crash.
4. If your terminal still aborts, run it in **Apple's Terminal.app**, which
   reliably shows the Bluetooth permission prompt. Click **Allow**, then you can
   go back to your preferred terminal.

After permission is granted once, it persists — you won't be asked again.

## Linux: `Failed to open HCI device` / permission denied

Give the Node binary raw Bluetooth access:
```
sudo apt install bluetooth libbluetooth-dev
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```
If a device needs bonding, pair it once: `bluetoothctl pair <MAC>`.

## The device connects but subscribing to heart rate fails

Google's HR sharing can require **bonding (pairing)** before it streams data.
- **macOS**: accept the system pairing prompt on first connect; or pair once in
  *System Settings → Bluetooth*.
- **Windows**: pair once in *Settings → Bluetooth & devices*.
- **Linux**: `bluetoothctl pair <MAC>`.
Then re-run. See [`RESEARCH.md`](RESEARCH.md#the-bonding-caveat-important).

## No devices found when scanning

- Make sure **heart-rate sharing is enabled** on the Fitbit Air so it actually
  advertises the Heart Rate Service. It only broadcasts while sharing is on
  (this preserves battery), so it won't appear 24/7.
- Bring the device close (good RSSI) and keep it awake.
- Try `npm run scan -- --all` to confirm your adapter sees *any* BLE traffic.

## Steps / history endpoints return 501 or 502

- `501` = Google Health isn't configured. Set `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` in `.env` and run `npm run auth`.
- `502` = the Google Health API rejected the request. Check that the API is
  enabled in your Cloud project, your account is a **test user**, and the
  scope/endpoint strings in `src/google-health/` match the current API. See
  [`GOOGLE_HEALTH_SETUP.md`](GOOGLE_HEALTH_SETUP.md).
