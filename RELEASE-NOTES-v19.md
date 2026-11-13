# v19 — Network-first PWA update reliability

## Diagnosis

The hosted v18 files were correct when fetched from GitHub Pages with a cache-busting URL, but normal PWA requests still returned an older cached `app.js`. The previous service worker used cache-first loading and could cache a mixture of old and new deployment files if it installed while GitHub Pages was publishing.

## Fix

- Use network-first loading for all same-origin app files.
- Update the cache from successful network responses.
- Use cached files only when offline.
- Continue to leave ArcGIS SDK modules and map tiles to the browser/network; they are not indiscriminately cached by the PWA.
- Display `v19` in the header, including after sign-in, so the running build can be verified from a screenshot.
- Retain the repaired sign-in handler and nonblocking road-matching fallback behavior.

## Deployment order

1. Upload the v19 ZIP contents to the GitHub repository root and wait for Pages to publish.
2. Then clear the old iPhone website data/PWA installation, close Safari, open the GitHub Pages URL in Safari while online, and confirm the header shows `v19`.
3. Add the site back to the Home Screen and test a short commute.
