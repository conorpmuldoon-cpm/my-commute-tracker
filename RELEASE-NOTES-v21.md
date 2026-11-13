# v21 — Native Map collision fix

## Diagnosis from v20

The v20 test completed the route, sample, and derived-segment saves, proving that GPS-direct segment construction and the hosted segment layer work. Its final summary showed `undefined context-matched, NaN GPS-direct fallback`, which identified a JavaScript naming collision.

`app.js` imported the ArcGIS map class as `Map`, then used `new Map()` for the in-memory lookup of context-matched intervals. That constructed an ArcGIS `Map` instead of JavaScript's native `Map` collection. The object does not provide native `size`, `get`, or `set` semantics, which explains the invalid counts and could surface opaque minified ArcGIS SDK errors during road matching.

## Fix

- Rename the ArcGIS map import to `EsriMap`.
- Construct the matched-interval lookup with `new globalThis.Map()`.
- Retain v20's nonblocking persistence stages, direct-only diagnostic option, and network-first PWA updates.
- Show `v21` in the header for deployment confirmation.

## Test

Run a short normal test with **Diagnostic: save GPS-direct segments only** unchecked. If ArcGIS routing still fails, the app saves gray dotted GPS-direct fallback segments and reports the routing diagnostic, but the segment count summary should now be numeric.
