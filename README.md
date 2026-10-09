# My Commute Tracker PWA

Static GitHub Pages PWA for manually tracking personal commutes while the browser/PWA remains active.

## Deployment

1. Upload all files in this folder to the root of the `my-commute-tracker` repository.
2. In GitHub: **Settings → Pages → Build and deployment**. Select **Deploy from a branch**, branch `main`, folder `/ (root)`, then save.
3. Wait for GitHub Pages to publish `https://conorpmuldoon-cpm.github.io/my-commute-tracker/`.
4. On an iPhone, open the URL in Safari and use **Share → Add to Home Screen**.

## Safety and privacy

The service URL and OAuth client ID are public-client configuration, not secrets. Never commit a token or OAuth client secret. The hosted feature layer must remain private.

## iPhone limitation

Safari/PWA location collection may pause when the app is backgrounded or the device locks. This implementation supports active, foreground commute tracking; it is not a substitute for a native background-location app.
