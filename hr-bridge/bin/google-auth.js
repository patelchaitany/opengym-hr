#!/usr/bin/env node
// One-time Google Health API authorization via a local loopback redirect.
//
//   npm run auth
//
// Spins up a tiny server on the redirect URI, opens the consent screen in your
// browser, captures the code, and saves refreshable tokens to
// .google-tokens.json. Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in
// .env — see docs/GOOGLE_HEALTH_SETUP.md.

import http from 'node:http';
import { URL } from 'node:url';
import open from 'open';
import { config, googleConfigured } from '../src/config.js';
import { GoogleHealthClient } from '../src/google-health/client.js';

if (!googleConfigured()) {
  console.error(
    'Google is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.\n' +
      'See docs/GOOGLE_HEALTH_SETUP.md for the walkthrough.',
  );
  process.exit(1);
}

const client = new GoogleHealthClient();
const redirect = new URL(config.google.redirectUri);
const port = Number(redirect.port) || config.server.port;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end();
    return;
  }
  const query = Object.fromEntries(url.searchParams.entries());
  try {
    await client.handleCallback(query);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Authorized! You can close this tab and return to the terminal.');
    console.log('\n✅ Google Health authorization complete. Tokens saved to .google-tokens.json');
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`Error: ${err.message}`);
    console.error('\n❌ Authorization failed:', err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(port, redirect.hostname, async () => {
  const authUrl = client.createAuthUrl();
  console.log('Opening the Google consent screen in your browser...');
  console.log('If it does not open, visit this URL manually:\n');
  console.log(authUrl + '\n');
  try {
    await open(authUrl);
  } catch {
    /* user can open manually */
  }
});
