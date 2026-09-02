# How this works: talking to a Fitbit Air

This document is the honest, technical account of *what is and isn't possible*
when connecting a **Google Fitbit Air** (the 2026 screenless tracker) to your
own devices — and why this project is built the way it is.

## TL;DR

| Data | How | Real-time? | Needs cloud/account? |
|------|-----|------------|----------------------|
| **Live heart rate (bpm)** | Standard BLE **Heart Rate Service `0x180D`** while the device is *sharing* HR | ✅ ~1 Hz | ❌ works fully offline |
| RR intervals / HRV-ish | Same HR notifications (if the device includes RR) | ✅ | ❌ |
| Battery level | BLE **Battery Service `0x180F`** | on read | ❌ |
| **Steps / daily totals** | **Google Health API** (OAuth 2.0) | ❌ (synced) | ✅ |
| Heart-rate history, sleep, SpO2, HRV, skin temp | **Google Health API** | ❌ (synced) | ✅ |

The two halves are independent. You can use the Bluetooth live-HR half with
**no account, no internet, no reverse engineering of anything proprietary.**

## The key insight: Fitbit's HR sharing is a *standard* profile

Modern Fitbit/Pixel devices — including the **Fitbit Air**, Charge 6, and Pixel
Watch 2/3/4 — can **broadcast real-time heart rate to fitness equipment and
apps** using the **Bluetooth SIG Heart Rate Profile** (Heart Rate Service
`0x180D`, Heart Rate Measurement characteristic `0x2A37`). This is the exact
same profile a Polar chest strap, Peloton, Zwift, or a gym treadmill speaks.

That means you do **not** need to decrypt Fitbit's private sync protocol to get
live bpm. You enable sharing on the device, it advertises the HR service, your
computer connects as a BLE "central," subscribes to `0x2A37` notifications, and
gets a beat-by-beat stream. That's what `src/ble/heartRate.js` does.

### Enabling sharing on the device
Heart-rate sharing must be turned on so the Air starts advertising `0x180D`:
- **Fitbit Air**: enable "share real-time heart rate" (the same *HR on
  equipment* feature as Charge 6) from the device/app quick settings, or during
  the first ~2 minutes of a workout.
- Sharing **impacts battery**, so the device only advertises HR while it's on.

### The bonding caveat (important)
Google's implementation may require **bonding (pairing)** before it streams
sensor data. Bonding is part of the Heart Rate Profile spec but is *uncommon*,
which is why some third-party gym apps historically failed to read Fitbit HR.

In practice on a computer:
- **macOS**: the first connection triggers a system **pairing prompt** — accept
  it. After that, CoreBluetooth remembers the bond. If a subscribe fails with a
  security/encryption error, pair the device once in *System Settings →
  Bluetooth*, then re-run.
- **Linux (BlueZ)**: you may need to `bluetoothctl pair <MAC>` once.
- **Windows**: pair via *Settings → Bluetooth & devices* once.

The code surfaces a clear message if a subscribe fails for this reason.

## What you *cannot* get over Bluetooth (and why)

The Fitbit Air also exposes **vendor-specific, encrypted BLE services** used by
the Google Health app to sync steps, sleep, SpO2, etc. Those are:
- **Encrypted and authenticated** with keys tied to your Google/Fitbit account
  provisioned during setup.
- **Not documented** and not intended for third-party access.

Reverse-engineering that channel would be brittle, would break on every
firmware update, and — depending on where you live and how you do it — can run
into terms-of-service and anti-circumvention issues. **This project does not do
that.** For everything that isn't live HR, we use the official, supported
**Google Health API**, which is the sanctioned replacement for the old Fitbit
Web API (which is being turned down in September 2026).

Use `npm run scan -- --gatt` to see the device's GATT table yourself: you'll
find `0x180D` (Heart Rate), `0x180F` (Battery), `0x180A` (Device Information),
and one or more 128-bit vendor service UUIDs whose characteristics are locked.

## "Pushing things to the Fitbit"

You asked about pushing data *to* the device. Realistically:
- The Air is **screenless** and exposes no public write channel for
  notifications or custom data — there's no standard GATT service for that, and
  the vendor channel is encrypted. So arbitrary push-to-device is **not
  feasible** without breaking encryption.
- The **standard control point** in the HR profile (`0x2A39`) only resets
  "energy expended" — not general messaging.
- If you want a wearable you can freely push to, that's a different device
  class (e.g. a Bangle.js / open smartwatch). For the Air, treat it as a
  **read** source: live HR over BLE + rich history over the Health API.

## Legal / ethical note
Reading the **standard** Heart Rate Service that the device *chooses to
broadcast* is ordinary Bluetooth interoperability — the same thing gym gear
does. Using the **Google Health API** is explicitly supported. This project
deliberately stays on those two supported paths and does not attempt to defeat
any encryption or access controls. It is not affiliated with Google or Fitbit.

## References
- Google Health Help — *Share your real-time heart rate with fitness equipment
  & apps*
- Google Health API — <https://developers.google.com/health>
- Bluetooth SIG — Heart Rate Service (0x180D) / Heart Rate Measurement (0x2A37)
