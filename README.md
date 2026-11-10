# My Commute Tracker PWA

Static GitHub Pages PWA for manually tracking personal commutes while the browser/PWA remains active.

## Deployment

1. Upload all files in this folder to the root of the `my-commute-tracker` repository.
2. In GitHub: **Settings → Pages → Build and deployment**. Select **Deploy from a branch**, branch `main`, folder `/ (root)`, then save.
3. Wait for GitHub Pages to publish `https://conorpmuldoon-cpm.github.io/my-commute-tracker/`.
4. On an iPhone, open the URL in Safari and use **Share → Add to Home Screen**.

## Safety and privacy

The service URL and OAuth client ID are public-client configuration, not secrets. Never commit a token or OAuth client secret. The hosted feature layer must remain private.

## Context-aware road matching (v14)

The production recorder keeps **one derived polyline per original GPS interval** (normally about 9 seconds; it can retain a safe extra sample around a meaningful browser-reported/inferred turn). Each interval retains its original local `speed_mph`; speeds are never averaged across a matching window and no new storage fields are required.

At trip end, the active app processes short ordered, overlapping GPS context windows (10 core intervals with two guard samples on each side). It extracts one road-correlated portion for each core interval only when endpoint proximity, route/GPS heading, projection order/continuity, and detour/backtracking checks are plausible. Any uncertain interval is deliberately saved as an individual gray dotted **GPS direct** fallback; accepted intervals are solid, speed-colored **Context matched** lines in the dashboard. Matching and saving require the PWA to remain open with network access until the final status reports the context-matched and fallback counts.

## iPhone limitation

Safari/PWA location collection may pause when the app is backgrounded or the device locks. This implementation supports active, foreground commute tracking; it is not a substitute for a native background-location app.
