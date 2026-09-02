# Google Health API setup (steps + history)

This is **optional**. Live heart rate over Bluetooth needs none of this. Do this
only if you also want **steps, heart-rate history, sleep, SpO2**, etc., which
the Fitbit Air syncs to Google Health.

> Background: the legacy **Fitbit Web API** is being turned down (Sept 2026).
> Fitbit Air data now flows through the **Google Health API**
> (`https://health.googleapis.com/v4`) behind Google OAuth 2.0. All Health API
> scopes are **Restricted**, so Google requires a privacy/security review for
> *production* apps. For personal use with **your own** data you can add
> yourself as a **test user** and skip the review.

## 1. Create a Google Cloud project
1. Go to <https://console.cloud.google.com/> and create a project.
2. **Enable the Google Health API**: *APIs & Services → Library →* search
   "Health" → **Enable**.

## 2. Configure the OAuth consent screen
1. *APIs & Services → OAuth consent screen*.
2. User type: **External**. Fill in the app name and your email.
3. Add the Health scopes you want (steps, heart rate). They'll show as
   Restricted — that's expected.
4. Under **Test users**, add your own Google account (the one on your Fitbit
   Air). This lets you authorize without the full verification review.

## 3. Create OAuth credentials
1. *APIs & Services → Credentials → Create credentials → OAuth client ID*.
2. Application type: **Desktop app**.
3. Copy the **Client ID** and **Client secret**.

## 4. Configure this project
Copy `.env.example` to `.env` and fill in:

```
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxx
GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/oauth/callback
```

The redirect URI must exactly match one you add to the OAuth client's
**Authorized redirect URIs** in the Cloud Console (loopback `127.0.0.1` is
allowed for Desktop apps).

## 5. Authorize
```
npm run auth
```
This opens the Google consent screen, captures the code on the loopback
redirect, and saves refreshable tokens to `.google-tokens.json` (git-ignored).

## 6. Use it
- `GET /api/steps?date=YYYY-MM-DD` → daily step total
- `GET /api/heart-rate/history?date=YYYY-MM-DD` → HR samples
- The dashboard shows a **Today (Google Health)** card once authorized.

## Adjusting scopes / endpoints
The Health API is new and still settling. Scope strings live in
`src/google-health/auth.js` (`DEFAULT_SCOPES`) and the request paths in
`src/google-health/client.js`. If Google adjusts a path or scope name, change it
in those two files — the rest of the app is decoupled from them. Confirm current
values against <https://developers.google.com/health>.
