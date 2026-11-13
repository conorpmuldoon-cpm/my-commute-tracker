# v18 — Sign-in repair

## Diagnosis

The v17 deployed `app.js` had two accidental trailing JavaScript fragments after the normal service-worker registration. That made the ES module fail to parse before it could attach the Sign in to ArcGIS click handler. The visible button therefore appeared to do nothing.

## Fix

- Remove the two invalid trailing JavaScript fragments.
- Retain v17's nonblocking road-matching behavior.
- Version the PWA service-worker cache again so repaired assets replace the broken v17 module.

## Deploy

Upload the contents of the v18 ZIP to the GitHub repository root. After Pages publishes, fully close the installed iPhone PWA and reopen it while online. The Sign in to ArcGIS button should then open the usual ArcGIS Online authentication flow.
