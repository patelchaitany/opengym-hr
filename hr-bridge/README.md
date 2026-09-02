# fitbit-air

**Read your Google Fitbit Air (or any Bluetooth heart-rate device) from your own
code.** Live heart rate streams over Bluetooth in real time; steps and history
come from the official Google Health API. Ships a REST + WebSocket server and a
live web dashboard. MIT-licensed, no cloud middleman for the live data.

> **Not affiliated with Google or Fitbit.** This project uses only supported,
> standard interfaces — the Bluetooth SIG Heart Rate Profile the device chooses
> to broadcast, and the official Google Health API. It does **not** break any
> encryption. See [`docs/RESEARCH.md`](docs/RESEARCH.md) for the full, honest
> breakdown of what is and isn't possible.

<p align="center"><em>♥ live bpm · 📈 real-time chart · 🔌 WebSocket + REST · 👣 steps via Google Health</em></p>

## What you get

- **Live heart rate over Bluetooth** — beat-by-beat bpm, RR intervals, sensor
  contact, battery. Works **fully offline**, no account needed. This is the
  standard `0x180D` Heart Rate Service (same one Peloton/Zwift/gym gear use).
- **WebSocket stream** at `/ws` — every reading and status change pushed live.
- **REST API** — `/api/status`, `/api/heart-rate/live`, `/api/sessions`, plus
  Google Health `/api/steps` and `/api/heart-rate/history`.
- **Live web dashboard** — big bpm readout, rolling chart, session min/avg/max,
  device info. Pure HTML/canvas, no build step.
- **Session tracking** — each streaming stretch is a session with stats.
- **CLI tools** — `scan` (discover devices / dump GATT), `hr` (print live bpm),
  `auth` (Google Health OAuth).

## How it works (30-second version)

The Fitbit Air can **broadcast real-time heart rate** to fitness equipment using
the *standard* Bluetooth Heart Rate Profile. Enable that sharing on the device
and any BLE central — including your laptop — can subscribe to live bpm. No
proprietary protocol, no decryption.

Everything the device does **not** broadcast (steps, sleep, SpO2, HR history)
comes from the **Google Health API**, the official successor to the Fitbit Web
API. Full detail: [`docs/RESEARCH.md`](docs/RESEARCH.md).

```
 Fitbit Air ──BLE 0x180D──▶ fitbit-air ──┬─▶ WebSocket /ws ─▶ dashboard / your app
 (HR sharing on)                          └─▶ REST /api/*
 Google Health ──OAuth 2.0──▶ /api/steps, /api/heart-rate/history
```

## Quick start

```bash
git clone <your-fork-url> fitbit-air
cd fitbit-air
npm install

# 1. On the Fitbit Air, turn ON "share real-time heart rate" so it advertises.
# 2. Start the server + dashboard:
npm start
# open http://127.0.0.1:3000
```

> **macOS first-run note (important).** macOS requires Bluetooth permission for
> the app touching the radio. If `npm start` **aborts (exit 134)** right after
> "powering on Bluetooth adapter", grant your terminal Bluetooth access:
> **System Settings → Privacy & Security → Bluetooth**, enable your terminal
> (Warp/iTerm/Terminal), and run it in a plain terminal tab. Full details:
> [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md#macos-the-process-aborts-exit-134--abort-right-after-powering-on-bluetooth-adapter).
> If the device asks to **pair**, accept the system prompt (see
> [bonding note](docs/RESEARCH.md#the-bonding-caveat-important)).

### Just want live bpm in the terminal?

```bash
npm run hr
```

### See what your device actually exposes over Bluetooth

```bash
npm run scan            # list nearby heart-rate devices
npm run scan -- --all   # list ALL BLE devices
npm run scan -- --gatt  # connect + dump every GATT service/characteristic
```

## Requirements

- **Node.js 18+** (uses built-in `fetch`).
- A Bluetooth LE adapter (built-in on any modern laptop).
- Platform notes for [`@abandonware/noble`](https://github.com/abandonware/noble):
  - **macOS**: grant Bluetooth permission to your terminal/IDE.
  - **Linux**: `sudo apt install bluetooth libbluetooth-dev` and grant the Node
    binary raw access: `sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))`.
  - **Windows**: works with the default BLE stack (WinRT).

## Configuration

Copy `.env.example` → `.env`. All fields are optional:

| Var | Purpose |
|-----|---------|
| `PORT`, `HOST` | server bind (default `127.0.0.1:3000`) |
| `BLE_NAME_FILTER` | only connect to a device whose name contains this (e.g. `fitbit`) |
| `BLE_ADDRESS_FILTER` | only connect to this exact BLE address/UUID |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google Health API (see below) |

## Steps & history (Google Health API)

Optional. Follow [`docs/GOOGLE_HEALTH_SETUP.md`](docs/GOOGLE_HEALTH_SETUP.md) to
create a Google Cloud OAuth client, then:

```bash
npm run auth          # one-time browser authorization
```

After that, `/api/steps` and `/api/heart-rate/history` work and the dashboard
shows a **Today** card.

## API reference

### WebSocket `ws://<host>/ws`
Messages are `{ type, payload, at }`. Types: `snapshot` (sent on connect),
`heartRate`, `status`, `device`, `battery`, `sensorLocation`, `error`.

```js
const ws = new WebSocket('ws://127.0.0.1:3000/ws');
ws.onmessage = (e) => {
  const { type, payload } = JSON.parse(e.data);
  if (type === 'heartRate') console.log(payload.bpm, 'bpm');
};
```

### REST
| Method / Path | Returns |
|---------------|---------|
| `GET /api/health` | `{ ok, googleConfigured }` |
| `GET /api/status` | full snapshot (device, session, recent readings) |
| `GET /api/heart-rate/live` | latest reading |
| `GET /api/sessions` | all sessions with min/avg/max |
| `GET /api/steps?date=YYYY-MM-DD` | daily steps (Google Health) |
| `GET /api/heart-rate/history?date=YYYY-MM-DD` | HR samples (Google Health) |

A heart-rate reading looks like:
```json
{ "bpm": 72, "contact": true, "rrIntervals": [833, 812], "at": "2026-08-10T18:20:01.123Z" }
```

## Project layout

```
src/
  ble/heartRate.js     BLE Heart Rate Service reader (the core)
  ble/scan.js          device discovery + GATT enumeration
  server/server.js     Express REST + WebSocket
  server/sessions.js   in-memory session/reading store
  google-health/       OAuth 2.0 (PKCE) + Health API client
  index.js             wires it all together
bin/                   cli.js, scan.js, hr.js, google-auth.js
public/index.html      live dashboard (no build step)
docs/                  RESEARCH.md, GOOGLE_HEALTH_SETUP.md
```

## Limitations (read this)

- **Live HR only streams while the device is sharing** it — this drains battery,
  so the Air won't advertise `0x180D` 24/7. Steps/history are the Health API's job.
- **You can't push arbitrary data *to* the Air** — it's screenless and exposes
  no public write channel. This is a read-focused tool. Details in `RESEARCH.md`.
- **The Google Health API is new (2026)** and its scopes are Restricted; exact
  scope/endpoint strings are centralized in `src/google-health/` so you can
  adjust them if Google changes them.

## Contributing

PRs welcome — this is meant to be a community starting point. Good first issues:
persistent history storage, more Health API data types (sleep, SpO2, HRV),
a native mobile client over the WebSocket, and per-platform pairing guides.

## License

MIT — see [`LICENSE`](LICENSE).
