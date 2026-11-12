# v16 — Route serializer workaround

## What the error proves

The message shown by the app — `Save failed during road matching` — is the v15 staged-persistence message. That means the deployed page reached v15 code; this is not merely an old PWA cache or a failed GitHub Pages publish.

## Fix

- Remove the optional `RouteParameters.outSpatialReference` property from route solves.
- Retain real WGS84 `SpatialReference` instances on input stop points and locally saved geometries.
- Continue to request route geometry and no directions.
- Change the service-worker cache name so the revised application assets are installed after deployment.

In ArcGIS Maps SDK for JavaScript 4.30, the route serializer can take a string-only path for `outSpatialReference` and throw `r.split is not a function` even when the supplied value is an SDK `SpatialReference` instance. The route service uses the stop geometry's WGS84 reference for its output, which keeps the client-side context matcher in longitude/latitude without sending the problematic optional parameter.

## Deploy

Deploy the root-level files to the GitHub repository root. On iPhone, fully close the installed PWA after GitHub Pages has finished publishing, then reopen it while online once so the new service worker activates. Do not reuse a failed trip after the app is closed; start a new test commute.
