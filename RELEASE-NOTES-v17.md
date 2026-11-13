# v17 — Nonblocking road matching

## Result of v16 test

The same road-matching error after a confirmed v16 deployment shows that removing `outSpatialReference` alone did not eliminate the mobile failure. The published v16 source did contain the revised route parameters.

## v17 behavior

- Keep the v16 route-parameter workaround.
- Treat context road matching as an optional enhancement, never as a condition for saving a completed trip.
- Catch any unexpected error that escapes the individual context-window handler.
- Retain context-matched intervals already accepted before an error.
- Save every remaining interval as a speed-preserving `GPS direct segment` fallback.
- Use a new service-worker cache name so the PWA installs v17 assets.

A v17 trip should complete its route, GPS sample, and derived-segment saves even if ArcGIS routing remains unavailable or the underlying SDK error persists. The dashboard will distinguish accepted context-matched segments from gray dotted GPS-direct fallback segments.

## Deploy

Upload the contents of the v17 ZIP to the GitHub repository root, let GitHub Pages publish, then fully close and reopen the iPhone PWA while online before beginning a new short test commute.
