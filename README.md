<div align="center">

# openGym HR

**Your Fitbit Air's heart rate, inside your own gym log — set by set.**

[openGym](https://github.com/DuarteSantos8/openGym) is a self-hosted workout tracker.
[fitbit-air](https://github.com/AyushSagar16/fitbit-air) reads live heart rate off a Fitbit Air
over Bluetooth. This is the two of them wired together: live bpm on the workout screen, and
every set you log carries what your heart was doing while you did it.

The Android app reads your strap over its **own** Bluetooth radio — no laptop at the gym.

![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-a3e635?style=flat-square)
![Self-hosted](https://img.shields.io/badge/self--hosted-%F0%9F%8F%A0-60a5fa?style=flat-square)
![Bluetooth](https://img.shields.io/badge/BLE-0x180D-ff453a?style=flat-square)
![PWA](https://img.shields.io/badge/PWA-installable-a78bfa?style=flat-square)

### [⬇ Download the Android app](https://github.com/patelchaitany/opengym-hr/releases/latest)

<sub>Debug build, sideload only. It needs the bridge's LAN address filled in — see
[The Android app](#the-android-app).</sub>

</div>

## What it adds

Stock openGym records what you lifted. This records what it cost you.

- **Live bpm on the workout screen** — a strip under the progress bar showing your rate, the
  zone it puts you in, a rolling two-minute trace, and what the set currently under way is
  doing. The heart glyph beats at your actual rate.
- **Two sources**, chosen per profile: this device's own Bluetooth, or a bridge on your
  network. See [Two ways to get a pulse in](#two-ways-to-get-a-pulse-in).
- **Every set carries its own heart rate** — average, peak and minimum over the window between
  the end of your last rest and the moment you tick the box.
- **Every exercise gets a rollup** — average and peak across its sets, shown right under the
  set rows so today's squats can be compared with last week's at a glance, plus:
  - time in each of the five heart-rate zones
  - calories, from Keytel et al. (2005)
  - **training strain** (Banister TRIMP), which weights intensity exponentially
  - **HRV** (RMSSD) from R-R intervals, where the device reports them
  - **heart-rate recovery** — how far your pulse fell in the minute after the last set, the
    marker that actually moves as you get fitter
- **A session curve** stored on the workout, drawn back in History months later.
- **It survives your phone locking.** The bridge keeps hours of history, so when a workout is
  finished the app re-reads every set's window from the bridge rather than trusting whatever
  its own socket happened to catch. See [How the numbers get made](#how-the-numbers-get-made).

<div align="center">
<em>♥ live bpm · per-set capture · zones · strain · HRV · recovery</em>
</div>

## Two ways to get a pulse in

Both speak the same thing — the Bluetooth SIG **Heart Rate Profile** (`0x180D` / `0x2A37`),
the standard one that Peloton, Zwift and gym treadmills use. Pick per profile in
Settings → Heart rate → **Read from**.

**This device** — the phone's own radio talks to the strap. Nothing else to run, nothing else
to carry. The default in the Android app, and available in Chrome and Edge via Web Bluetooth.

```
  Fitbit Air / any BLE strap ──0x180D──▶ openGym  (src/lib/hrble.js)
```

**Bridge** — a computer does the Bluetooth and serves the numbers over your network. Worth it
for one reason: a mains-powered machine keeps listening while your phone's screen is off, and
its history can be re-read after the fact, so a set you didn't watch still gets right numbers.

```
  Fitbit Air ──0x180D──▶ hr-bridge (Node) ──┬─ ws://…/ws  every beat, live
                                            └─ /api/heart-rate/range  every beat, after the fact
                                                       │
                                                       ▼
                                              openGym  (src/lib/hrbridge.js)
```

Either way the rest is identical:

```
  openGym frontend  →  live strip · per-set windows · zone maths
        ▼
  openGym api  →  ./data/state-<you>.json
```

For the bridge path, nginx serves the app and proxies `/api` to the openGym backend and `/hr`
to the bridge — one origin, so a phone needs no address, no CORS exception and no
mixed-content workaround.

## Quick start

### The whole thing, simulated (no strap, no radio, any machine)

```bash
HR_BRIDGE_HOST=hr:3001 docker compose --profile sim up --build
```

Open <http://localhost:8080>, Settings → Heart rate → **Capture heart rate**, then start a
workout. The bridge streams a plausible lifting session — a resting baseline, a climb under
load, the overshoot that lands after the set, an exponential recovery — so every screen and
every number below is real code doing real work on a fake pulse.

### With your actual Fitbit Air

The bridge has to run on the host: Bluetooth needs the radio, which Docker Desktop does not
pass into a container at all.

```bash
# 1. the bridge, next to your strap
cd hr-bridge && npm install && npm start

# 2. the app
docker compose up --build      # http://localhost:8080
```

On the Fitbit Air, turn on **share real-time heart rate** ("HR on equipment") so it starts
advertising. Then Settings → Heart rate → on. Leave the bridge address empty — nginx already
proxies `/hr` to the host.

> **macOS:** grant your terminal Bluetooth access (System Settings → Privacy & Security →
> Bluetooth) or the process aborts the moment it powers on the adapter. Details in
> [`hr-bridge/docs/TROUBLESHOOTING.md`](hr-bridge/docs/TROUBLESHOOTING.md).

### Development

```bash
cd hr-bridge && npm install && npm run start:sim   # bridge on :3001, simulated
cd api        && npm install && node server.js     # openGym backend on :3000
cd frontend   && npm install && npm run dev        # app on :5173
```

The Vite dev server proxies `/api`, `/hr`, `/img` and `/gif`, so development behaves exactly
like the built app. Exercise images and GIFs are served straight from `./media` — no separate
static server to remember to start.

```bash
cd frontend && npm test          # 255 tests, 59 of them heart-rate maths and packet parsing
```

## How the numbers get made

The honest answer to "what was my heart rate during that set" is not available all at once,
so it is assembled in three passes.

**During the set.** The window a set claims runs from the moment work resumed — the last rest
ending, or the previous set being logged — to the instant you tick the box. Only the window
is recorded, plus a snapshot for the screen. Nothing is decided yet.

**The moment you finish.** The app asks the bridge for every sample in the session and
recomputes all of it. This matters more than it sounds: a phone with its screen off receives
nothing over the socket, and the set you care about is exactly the one you were not looking at
the phone during. The bridge was listening the whole time.

**Seventy seconds later.** One more pass, because the last exercise's recovery is measured a
minute after its final set — and when that set was ticked, that minute hadn't happened yet.

All three are fire-and-forget. The workout is saved before any of them run; a bridge that has
been unplugged can never fail a finish.

Everything is time-weighted rather than sample-counted, and one sample is capped at how long
it may stand for, so a strap that drops out for forty seconds leaves a gap in the numbers
instead of smearing one stale reading across it.

### Where the formulae come from

| Number | Source | Notes |
|---|---|---|
| Max HR | Nes et al. (2013), `211 − 0.64 × age` | Only when you haven't measured your own. Tracks real maxima better than `220 − age`. |
| Zones | 50/60/70/80/90% of max | The split every gym display and wearable uses, so the colours mean the same thing here. |
| % reserve | Karvonen | Measured from resting, not from zero — 140 bpm is not the same effort from a resting 45 as from a resting 75. |
| Strain | Banister TRIMP | Exponential in intensity. Comparable to your own past sessions, not to anyone else's. |
| Calories | Keytel et al. (2005) | Needs age and body weight. Without them the app shows nothing rather than a confident wrong number. |
| HRV | RMSSD, artefact-rejected | Needs a device that reports R-R intervals — chest straps do, most optical wrist sensors don't. |
| Recovery | HRR60 | Peak minus the reading a minute later. A drop of 12+ bpm is the usual healthy threshold, and it improves visibly with training. |

The maths lives in [`frontend/src/lib/hrmetrics.js`](frontend/src/lib/hrmetrics.js) as pure
functions over a sample series, with [tests](frontend/src/lib/hrmetrics.test.js) that check the
hand-computed values.

## Settings

Settings → **Heart rate**:

| | |
|---|---|
| **Capture heart rate** | Master switch. Off, and none of this exists. |
| **Bridge address** | Empty for same-origin (`/hr`). `http://192.168.1.20:3001` from a phone against a laptop bridge. **Test connection** actually calls it and says what it found. |
| **Keep the session curve** | Stores ~3 KB per workout so History can draw your heart rate back. |
| **Max / resting heart rate, age** | Everything above is derived from these. The closer they are, the more the numbers mean. |

Sex isn't asked for — the sex-specific formulae read the body-diagram setting openGym already
collects.

## The Android app

`openGym HR` installs alongside a stock openGym — different application id, launcher name and
deep-link scheme.

**It reads your strap directly.** Turn on heart-rate sharing on the Fitbit Air, then
Settings → Heart rate → on → **Pair**, and pick it from the system dialog. It is remembered and
reconnects at the start of every workout. No laptop, no Wi-Fi, no address to type.

Android asks only for **Nearby devices**, never location: `BLUETOOTH_SCAN` is declared
`neverForLocation`, and the location permissions the BLE plugin's own manifest would otherwise
merge in uncapped are overridden back to `maxSdkVersion="30"`.

The bridge source still works from the app if you want it — it needs the bridge's LAN address
in Settings, and the build permits cleartext HTTP for that, see
[`network_security_config.xml`](frontend/android/app/src/main/res/xml/network_security_config.xml).

**One caveat with on-device Bluetooth.** The phone is the receiver, so anything it misses is
missed — there is no history to re-read afterwards. openGym holds a wake lock during a
workout, so a screen you glance at is fine, but a phone locked in a bag for ten minutes will
leave a gap. The bridge does not have this problem, which is why both sources exist.

Prebuilt APKs are on the [releases page](https://github.com/patelchaitany/opengym-hr/releases).
To build your own:

```bash
cd frontend
npm run build:android                     # not build:mobile — that also syncs iOS,
                                          # which needs CocoaPods installed
cd android && ./gradlew assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
```

Needs JDK 17 or 21 (not 25 — Gradle 8.11 / AGP 8.7 won't take it) and Android SDK 35.
The result is a debug build signed with the standard Android debug key: sideloadable,
not shippable.

## Layout

```
hr-bridge/          fitbit-air: BLE → REST + WebSocket, plus a simulator
  src/ble/          heartRate.js (real radio) · simulator.js (no radio)
  src/server/       server.js · sessions.js (the time-range history)
frontend/           openGym's React PWA
  src/lib/hrmetrics.js    all the maths, pure and tested
  src/lib/hrble.js        this device's own radio — 0x2A37 parser + GATT
  src/lib/hrbridge.js     WebSocket + range client, auto-reconnecting
  src/store/useHR.js      live session state (kept out of the synced store)
  src/components/HeartRate.jsx   the strip, the zone bar, the summary
api/                openGym's passkey auth + per-user storage
```

## What changed in each half

**hr-bridge** (from fitbit-air): CORS so a browser on another origin can reach it; a
time-indexed history buffer with `/api/heart-rate/range` and `/api/heart-rate/stats`;
`/api/info` for the connection test; a simulator; port 3001 (openGym's API owns 3000); and
`@abandonware/noble` moved to an optional dependency, so the bridge installs and runs on a
machine with no Bluetooth stack at all.

**frontend** (from openGym): the heart-rate library, both clients, the store and the components
above; the workout screen's live strip and per-set capture; the finish-time analysis; heart
rate in the finish summary and in workout detail; the Settings card; Bluetooth permissions and
an on-device BLE source for the Android build; and a dev server that serves exercise media
from `./media` instead of expecting a static server nobody starts.

## Credits & licence

- [openGym](https://github.com/DuarteSantos8/openGym) by Duarte Santos — AGPL-3.0
- [fitbit-air](https://github.com/AyushSagar16/fitbit-air) by Ayush Sagar — MIT
- Exercise media: [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset) (CC)

This combined work is AGPL-3.0, as the stronger of the two. `hr-bridge/` keeps its own MIT
licence file, so that half stays reusable on its original terms.

**Not affiliated with Google or Fitbit.** The bridge uses only the standard Bluetooth SIG Heart
Rate Profile the device chooses to broadcast, and the official Google Health API. It breaks no
encryption. The full, honest breakdown is in
[`hr-bridge/docs/RESEARCH.md`](hr-bridge/docs/RESEARCH.md).

This is a fitness log, not a medical device. None of these numbers are a diagnosis, and
heart-rate-derived calorie and strain figures carry real error bars — treat them as a way to
compare your own sessions, not as measurements.
