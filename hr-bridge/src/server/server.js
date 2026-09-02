// HTTP (REST) + WebSocket server.
//
// - Serves the standalone bridge dashboard from /public.
// - REST API under /api for one-shot reads, time-range history and Google
//   Health data.
// - WebSocket at /ws pushes every heart-rate reading and status change in
//   real time to all connected clients.
//
// openGym is a client of this server like any other: it opens /ws for the live
// bpm on screen, and calls /api/heart-rate/range when a set is checked off to
// get the exact samples that fell inside it.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config, googleConfigured } from '../config.js';
import { logger } from '../util/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../public');

/**
 * @param {object} deps
 * @param {import('./sessions.js').SessionStore} deps.store
 * @param {import('../ble/heartRate.js').HeartRateMonitor} deps.monitor
 * @param {import('../google-health/client.js').GoogleHealthClient} [deps.google]
 */
export function createServer({ store, monitor, google }) {
  const app = express();
  app.use(express.json());

  // ---- CORS ------------------------------------------------------------
  // The gym app is served from another origin (:8080 in Docker, :5173 in dev,
  // or a phone hitting this laptop by IP). Without these headers the browser
  // refuses the fetch and the app sees a bridge that is plainly running as
  // "offline". Nothing here is authenticated or personal beyond a bpm, so the
  // default is open; HR_CORS_ORIGIN pins it to one origin if you'd rather.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', config.server.corsOrigin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.static(publicDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // ---- WebSocket broadcast plumbing ------------------------------------
  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload, at: new Date().toISOString(), ms: Date.now() });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  wss.on('connection', (ws) => {
    logger.info(`[ws] client connected (${wss.clients.size} total)`);
    // Send the current snapshot so a late joiner can render immediately.
    ws.send(JSON.stringify({ type: 'snapshot', payload: store.snapshot(), at: new Date().toISOString(), ms: Date.now() }));
    ws.on('close', () => logger.info(`[ws] client disconnected (${wss.clients.size} total)`));
  });

  // ---- Wire the monitor's events into the store + WebSocket -------------
  monitor.on('status', ({ status }) => {
    store.setStatus(status);
    if (status === 'streaming') store.startSession(store.device);
    if (status === 'disconnected') store.endSession();
    broadcast('status', { status, device: store.device });
  });
  monitor.on('connected', (device) => {
    store.setDevice(device);
    broadcast('device', device);
  });
  monitor.on('battery', (pct) => broadcast('battery', pct));
  monitor.on('sensorLocation', (loc) => broadcast('sensorLocation', loc));
  monitor.on('heartRate', (reading) => {
    store.addReading(reading);
    broadcast('heartRate', reading);
  });
  monitor.on('error', (err) => broadcast('error', { message: err.message }));

  // ---- REST API --------------------------------------------------------
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, googleConfigured: googleConfigured() });
  });

  // What the gym app calls to decide whether a bridge is really there (and to
  // name it in Settings). Deliberately cheap and unauthenticated.
  app.get('/api/info', (_req, res) => {
    res.json({
      service: 'hr-bridge',
      status: store.status,
      device: store.device,
      simulated: config.simulate,
      retentionSec: config.retentionSec,
      googleConfigured: googleConfigured(),
      now: Date.now(),
    });
  });

  app.get('/api/status', (_req, res) => res.json(store.snapshot()));
  app.get('/api/heart-rate/live', (_req, res) => res.json(store.lastReading || { bpm: null }));
  app.get('/api/sessions', (_req, res) => res.json(store.listSessions()));

  // The endpoint the per-set capture is built on: every sample between two
  // instants. A phone that slept through a set never saw those readings over
  // the socket, but the bridge did, so this is what makes the numbers right.
  app.get('/api/heart-rate/range', (req, res) => {
    const from = Number(req.query.from);
    if (!Number.isFinite(from)) return res.status(400).json({ error: 'from (epoch ms) is required' });
    const to = req.query.to === undefined ? Date.now() : Number(req.query.to);
    if (!Number.isFinite(to)) return res.status(400).json({ error: 'to must be epoch ms' });
    const samples = store.range(from, to).map((r) => ({
      ms: r.ms,
      bpm: r.bpm,
      // Only the fields the gym app actually reads — a set can span hundreds of
      // samples and the flags/deviceId on each one are dead weight over the wire.
      ...(r.rrIntervals?.length ? { rr: r.rrIntervals } : {}),
    }));
    res.json({ from, to, count: samples.length, samples });
  });

  // Same window, already reduced. Handy for a client that only wants the
  // numbers (a watch face, a script) and doesn't want to do the maths.
  app.get('/api/heart-rate/stats', (req, res) => {
    const from = Number(req.query.from);
    if (!Number.isFinite(from)) return res.status(400).json({ error: 'from (epoch ms) is required' });
    const to = req.query.to === undefined ? Date.now() : Number(req.query.to);
    res.json(store.statsFor(from, to));
  });

  // Google Health endpoints (steps, heart-rate history). These require the
  // OAuth flow in docs/GOOGLE_HEALTH_SETUP.md to have been completed.
  app.get('/api/steps', async (req, res) => {
    if (!google) return res.status(501).json({ error: 'Google Health not configured' });
    try {
      const date = req.query.date || undefined;
      res.json(await google.getSteps(date));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/heart-rate/history', async (req, res) => {
    if (!google) return res.status(501).json({ error: 'Google Health not configured' });
    try {
      res.json(await google.getHeartRate(req.query.date || undefined));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // OAuth callback used by the loopback flow.
  app.get('/oauth/callback', async (req, res) => {
    if (!google) return res.status(501).send('Google Health not configured.');
    try {
      await google.handleCallback(req.query);
      res.send('Google Health authorized. You can close this tab and return to the terminal.');
    } catch (err) {
      res.status(400).send(`OAuth error: ${err.message}`);
    }
  });

  function listen() {
    return new Promise((resolve) => {
      server.listen(config.server.port, config.server.host, () => {
        const shown = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
        const url = `http://${shown}:${config.server.port}`;
        logger.info(`[server] bridge dashboard:  ${url}`);
        logger.info(`[server] websocket:         ${url.replace('http', 'ws')}/ws`);
        if (config.server.host === '0.0.0.0') {
          logger.info('[server] listening on all interfaces — point openGym on your phone at');
          logger.info(`[server] http://<this-machine-ip>:${config.server.port} in Settings → Heart rate.`);
        }
        resolve(server);
      });
    });
  }

  return { app, server, wss, listen, broadcast };
}
