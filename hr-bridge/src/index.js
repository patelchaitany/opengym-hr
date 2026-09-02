// Main entry point: start the heart-rate source (BLE, or the simulator) + the
// REST/WebSocket server + the bridge's own dashboard. Run with `npm start`,
// or `npm run start:sim` for a session with no hardware involved.

import { config, googleConfigured } from './config.js';
import { logger } from './util/logger.js';
import { HeartRateMonitor } from './ble/heartRate.js';
import { HeartRateSimulator } from './ble/simulator.js';
import { SessionStore } from './server/sessions.js';
import { createServer } from './server/server.js';
import { GoogleHealthClient } from './google-health/client.js';

async function main() {
  const store = new SessionStore({ retentionSec: config.retentionSec });

  // The simulator implements the same events as the real monitor, so nothing
  // downstream of here knows or cares which one it got.
  const monitor = config.simulate
    ? new HeartRateSimulator()
    : new HeartRateMonitor({
      nameFilter: config.ble.nameFilter,
      addressFilter: config.ble.addressFilter,
      autoReconnect: true,
    });

  const google = googleConfigured() ? new GoogleHealthClient() : null;
  if (!google) {
    logger.info('[google] not configured — steps/history endpoints disabled (BLE still works).');
  }

  const { listen } = createServer({ store, monitor, google });
  await listen();

  if (config.simulate) {
    logger.info('[main] HR_SIMULATE=1 — streaming a simulated lifting session, no radio in use.');
  } else {
    logger.info('[main] starting Bluetooth scan. On the Fitbit Air, enable heart-rate sharing');
    logger.info('[main] ("HR on equipment" / share real-time heart rate) so it starts advertising.');
  }
  await monitor.start();

  const shutdown = async () => {
    logger.info('\n[main] shutting down...');
    await monitor.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('[main] fatal:', err);
  process.exit(1);
});
