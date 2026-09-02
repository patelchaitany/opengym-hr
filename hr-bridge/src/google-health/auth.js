// Google OAuth 2.0 (Authorization Code + PKCE) for the Google Health API.
//
// The legacy Fitbit Web API is being turned down (Sept 2026); Fitbit Air data
// now flows through the Google Health API (https://health.googleapis.com/v4)
// behind Google OAuth 2.0. This implements a local, loopback-redirect flow
// suitable for a "Desktop app" OAuth client — no client secret is strictly
// required for PKCE, but we support one since desktop clients are issued a
// (non-confidential) secret.
//
// Tokens are cached to disk (.google-tokens.json, git-ignored) and refreshed
// automatically.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Health API scopes are "Restricted" and require a Google privacy/security
// review for production. For personal use with your own data you can add
// yourself as a test user on the OAuth consent screen. Adjust as needed; see
// docs/GOOGLE_HEALTH_SETUP.md.
export const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/health.steps.read',
  'https://www.googleapis.com/auth/health.heart_rate.read',
];

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class GoogleAuth {
  constructor({ scopes = DEFAULT_SCOPES } = {}) {
    this.scopes = scopes;
    this.tokens = this._loadTokens();
    this.pending = null; // { verifier, state }
  }

  _loadTokens() {
    try {
      return JSON.parse(fs.readFileSync(config.google.tokenFile, 'utf8'));
    } catch {
      return null;
    }
  }

  _saveTokens(tokens) {
    // Merge so a refresh (which omits refresh_token) doesn't drop it.
    this.tokens = { ...this.tokens, ...tokens };
    if (tokens.expires_in) {
      this.tokens.expires_at = Date.now() + tokens.expires_in * 1000;
    }
    fs.writeFileSync(config.google.tokenFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
  }

  isAuthorized() {
    return Boolean(this.tokens?.refresh_token || this.tokens?.access_token);
  }

  /** Build the consent URL and stash the PKCE verifier + state. */
  createAuthUrl() {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));
    this.pending = { verifier, state };

    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: config.google.redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /** Exchange the authorization code (from the loopback callback) for tokens. */
  async exchangeCode(query) {
    if (!this.pending) throw new Error('No pending authorization. Call createAuthUrl() first.');
    if (query.state !== this.pending.state) throw new Error('OAuth state mismatch (possible CSRF).');
    if (query.error) throw new Error(`OAuth denied: ${query.error}`);
    if (!query.code) throw new Error('No authorization code in callback.');

    const body = new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      code: query.code,
      code_verifier: this.pending.verifier,
      grant_type: 'authorization_code',
      redirect_uri: config.google.redirectUri,
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
    const tokens = await res.json();
    this.pending = null;
    this._saveTokens(tokens);
    logger.info('[google] authorization complete; tokens saved');
    return tokens;
  }

  async _refresh() {
    if (!this.tokens?.refresh_token) throw new Error('Not authorized. Run `npm run auth` first.');
    const body = new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: this.tokens.refresh_token,
      grant_type: 'refresh_token',
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
    this._saveTokens(await res.json());
  }

  /** Return a valid access token, refreshing if necessary. */
  async getAccessToken() {
    if (!this.tokens) throw new Error('Not authorized. Run `npm run auth` first.');
    const expired = !this.tokens.expires_at || Date.now() > this.tokens.expires_at - 60_000;
    if (expired && this.tokens.refresh_token) await this._refresh();
    if (!this.tokens.access_token) throw new Error('No access token available.');
    return this.tokens.access_token;
  }
}
