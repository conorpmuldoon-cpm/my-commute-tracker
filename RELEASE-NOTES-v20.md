# v20 — Segment diagnostics

## Purpose

v19 was confirmed running, yet segment persistence still stopped with the SDK's minified `r.split is not a function` error. The previous status grouped too much work under “road matching,” so it could not identify the exact operation that failed.

## Changes

- Create all GPS-direct fallback segment graphics before making any routing request.
- Report the exact segment-build checkpoint in the failure status.
- Keep routing optional; a routing failure cannot discard already prepared direct segments.
- Add **Diagnostic: save GPS-direct segments only**. When checked before starting a commute, it skips ArcGIS routing completely and saves only one GPS-direct segment per recorded interval.
- Retain network-first PWA updates and visible `v20` build identification.

## Test plan

1. Confirm the header displays `v20`.
2. Check **Diagnostic: save GPS-direct segments only** before starting a short test commute.
3. End the test commute.
   - If segments save, the routing/route-geometry path is the source of the defect.
   - If it fails, the on-screen checkpoint identifies whether direct segment construction or segment-layer persistence is at fault.
4. Capture the final status text and the v20 header.

## Deployment

Upload the v20 ZIP contents to the GitHub repository root, wait for Pages to publish, then fully close and reopen the PWA while online.
