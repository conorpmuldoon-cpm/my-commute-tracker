# v15 — Route serialization fix

## Diagnosis

The reported `r.split is not a function` error is characteristic of the ArcGIS Maps SDK for JavaScript request serialization receiving a plain object where an SDK object/value is expected. v14 passed `{ wkid: 4326 }` directly as `RouteParameters.outSpatialReference` and used the same plain-object form when constructing geometries. It also supplied optional route flags that are unnecessary for the ordered context-matching workflow.

## Fix

- Import and use one `SpatialReference({ wkid: 4326 })` instance for every point/polyline geometry and for `RouteParameters.outSpatialReference`.
- Use explicit WGS84 `x`/`y` stop points in the route FeatureSet.
- Restrict `RouteParameters` to `stops`, `returnRoutes`, `returnDirections`, and `outSpatialReference`; ordered stop handling remains the service default.
- Report the exact persistence stage on failure: route save, samples save, road matching, or derived-segment save.
- Preserve the in-memory completed trip and per-stage completion flags after an error, so retrying **End commute** resumes unfinished work.

No token, API key, client secret, or raw REST request is included.

## Immediate recovery for a currently open v14 failed-trip page

Keep that page open, connected, and in the foreground. Do not refresh, close it, navigate away, or start another commute because the completed trip only exists in the current page memory. Press **End commute** once more; a transient request failure may succeed. If the same serialization error returns, leave the page open until you can capture its displayed sample count/distance and deploy/use v15—the old already-loaded v14 module cannot be upgraded in place, and refreshing it would discard its unsaved in-memory trip.
