import EsriMap from "https://js.arcgis.com/4.30/@arcgis/core/Map.js";
import MapView from "https://js.arcgis.com/4.30/@arcgis/core/views/MapView.js";
import FeatureLayer from "https://js.arcgis.com/4.30/@arcgis/core/layers/FeatureLayer.js";
import GraphicsLayer from "https://js.arcgis.com/4.30/@arcgis/core/layers/GraphicsLayer.js";
import Graphic from "https://js.arcgis.com/4.30/@arcgis/core/Graphic.js";
import Point from "https://js.arcgis.com/4.30/@arcgis/core/geometry/Point.js";
import Polyline from "https://js.arcgis.com/4.30/@arcgis/core/geometry/Polyline.js";
import SpatialReference from "https://js.arcgis.com/4.30/@arcgis/core/geometry/SpatialReference.js";
import Portal from "https://js.arcgis.com/4.30/@arcgis/core/portal/Portal.js";
import * as route from "https://js.arcgis.com/4.30/@arcgis/core/rest/route.js";
import RouteParameters from "https://js.arcgis.com/4.30/@arcgis/core/rest/support/RouteParameters.js";
import FeatureSet from "https://js.arcgis.com/4.30/@arcgis/core/rest/support/FeatureSet.js";
import OAuthInfo from "https://js.arcgis.com/4.30/@arcgis/core/identity/OAuthInfo.js";
import esriId from "https://js.arcgis.com/4.30/@arcgis/core/identity/IdentityManager.js";
import { appConfig } from "./app-config.js";

const BUILD_VERSION = "v21";
const $ = (id) => document.getElementById(id);
const startButton = $("start"), endButton = $("end"), status = $("status");
let watchId = null, timerId = null, trip = null, signedIn = false, wakeLock = null;
// Use an SDK SpatialReference instance throughout. Plain `{ wkid: 4326 }` values
// can reach the route/applyEdits serializers uncast in some 4.30 browser builds.
const wgs84 = new SpatialReference({ wkid: 4326 });

const routeLayer = new GraphicsLayer({ title: "Active commute" });
const map = new EsriMap({ basemap: "streets-vector", layers: [routeLayer] });
const view = new MapView({ container: "viewDiv", map, center: [-75.28, 40.0], zoom: 10 });
const commuteLayer = new FeatureLayer({ url: appConfig.featureLayerUrl, outFields: ["*"] });
const sampleLayer = new FeatureLayer({ url: appConfig.sampleLayerUrl, outFields: ["*"] });
const speedSegmentsLayer = new FeatureLayer({ url: appConfig.speedSegmentsLayerUrl, outFields: ["*"] });
let routeServiceUrlPromise = null;

const oauth = new OAuthInfo({
  appId: appConfig.clientId,
  portalUrl: appConfig.portalUrl,
  popup: false,
  popupCallbackUrl: appConfig.redirectUrl
});
esriId.registerOAuthInfos([oauth]);

function setStatus(message) { status.textContent = message; }

function calculatedDirection(startedAt = Date.now()) {
  return new Date(startedAt).getHours() < 12 ? "Morning" : "Evening";
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock || !trip) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    // The commute can still be recorded if iOS or the browser declines the wake lock.
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  const activeLock = wakeLock;
  wakeLock = null;
  activeLock.release().catch(() => {});
}

function miles(points) {
  let meters = 0;
  for (let i = 1; i < points.length; i++) {
    const [lon1, lat1] = points[i - 1], [lon2, lat2] = points[i];
    const radians = Math.PI / 180, r = 6371000;
    const a = Math.sin((lat2 - lat1) * radians / 2) ** 2 +
      Math.cos(lat1 * radians) * Math.cos(lat2 * radians) *
      Math.sin((lon2 - lon1) * radians / 2) ** 2;
    meters += 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return meters / 1609.344;
}

function refreshMetrics() {
  if (!trip) return;
  $("elapsed").textContent = `${Math.max(0, Math.round((Date.now() - trip.startedAt) / 60000))} min`;
  $("distance").textContent = `${miles(trip.points).toFixed(1)} mi`;
  $("samples").textContent = trip.samples.length;
}

function redrawRoute() {
  routeLayer.removeAll();
  if (trip.points.length < 2) return;
  routeLayer.add(new Graphic({
    geometry: new Polyline({ paths: [trip.points], spatialReference: wgs84 }),
    symbol: { type: "simple-line", color: "#e4572e", width: 4 }
  }));
}

function normalizeHeading(value) {
  return Number.isFinite(value) && value >= 0 && value < 360 ? value : null;
}

function bearingDegrees(from, to) {
  const radians = Math.PI / 180;
  const lon1 = from[0] * radians, lon2 = to[0] * radians;
  const lat1 = from[1] * radians, lat2 = to[1] * radians;
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function headingDifference(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(((a - b + 540) % 360) - 180);
}

function recordPosition(position) {
  if (!trip || position.coords.accuracy > 75) return;

  const capturedAt = Number.isFinite(position.timestamp) ? position.timestamp : Date.now();
  const point = [position.coords.longitude, position.coords.latitude];
  const lastPoint = trip.points[trip.points.length - 1];
  const lastSample = trip.samples[trip.samples.length - 1];
  const browserHeading = normalizeHeading(position.coords.heading);
  const inferredHeading = lastPoint && miles([lastPoint, point]) >= 0.01 ? bearingDegrees(lastPoint, point) : null;
  const candidateHeading = browserHeading ?? inferredHeading;

  // Keep the normal cadence near nine seconds. A trustworthy, meaningful course
  // change can retain an extra point after five seconds, improving turn context
  // without adding fields to the private sample schema.
  if (lastSample) {
    const elapsedMs = capturedAt - lastSample.recordedAt;
    const turnDegrees = headingDifference(candidateHeading, lastSample.heading);
    const meaningfulTurn = elapsedMs >= 5000 && Number.isFinite(turnDegrees) && turnDegrees >= 30;
    if (elapsedMs < 9000 && !meaningfulTurn) return;
  }

  let speedMph = null;
  if (lastPoint && lastSample) {
    const elapsedHours = (capturedAt - lastSample.recordedAt) / 3600000;
    if (elapsedHours > 0) speedMph = miles([lastPoint, point]) / elapsedHours;
  }

  trip.points.push(point);
  trip.samples.push({
    point,
    recordedAt: capturedAt,
    speedMph,
    accuracyM: position.coords.accuracy,
    // Runtime-only context; this is intentionally not persisted in sample attributes.
    heading: candidateHeading,
    sequence: trip.samples.length + 1
  });
  trip.lastSampleAt = capturedAt;

  redrawRoute();
  refreshMetrics();
  if (trip.points.length === 1) view.goTo({ center: point, zoom: 15 });
}

function locationError(error) {
  setStatus(`Location update failed: ${error.message}. Keep the app open and location access enabled.`);
}

async function loadPrivateLayers() {
  await Promise.all([commuteLayer.load(), sampleLayer.load(), speedSegmentsLayer.load()]);
}

async function getRouteServiceUrl() {
  if (!routeServiceUrlPromise) {
    routeServiceUrlPromise = (async () => {
      const portal = new Portal({ url: appConfig.portalUrl });
      await portal.load();
      const routeUrl = portal.helperServices?.route?.url;
      if (!routeUrl) throw new Error("No ArcGIS routing service is configured for this portal.");
      await esriId.getCredential(routeUrl);
      return routeUrl;
    })();
  }
  return routeServiceUrlPromise;
}

function lineDistanceMiles(geometry) {
  return (geometry.paths || []).reduce((total, path) => total + miles(path), 0);
}

function conciseError(error) {
  const message = error?.message || String(error || "Unknown routing error.");
  return message.replace(/\s+/g, " ").slice(0, 220);
}

function flattenRoutePoints(geometry) {
  return (geometry?.paths || []).flat().filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

function projectOnRoute(routePoints, target) {
  // Local equirectangular projection is sufficient for short commute windows and
  // gives a stable distance-along-route measure for ordering checks.
  const metersPerDegree = 111320;
  const cosLat = Math.cos(target[1] * Math.PI / 180);
  let best = null, accumulatedMi = 0;
  for (let index = 0; index < routePoints.length - 1; index++) {
    const a = routePoints[index], b = routePoints[index + 1];
    const ax = (a[0] - target[0]) * metersPerDegree * cosLat, ay = (a[1] - target[1]) * metersPerDegree;
    const bx = (b[0] - target[0]) * metersPerDegree * cosLat, by = (b[1] - target[1]) * metersPerDegree;
    const dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
    const projected = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const distanceMi = miles([target, projected]);
    const segmentMi = miles([a, b]);
    if (!best || distanceMi < best.distanceMi) best = { index, t, point: projected, distanceMi, measureMi: accumulatedMi + segmentMi * t };
    accumulatedMi += segmentMi;
  }
  return best;
}

function extractContextInterval(routeGeometry, from, to, previousEndMeasure) {
  const routePoints = flattenRoutePoints(routeGeometry);
  const directMi = miles([from.point, to.point]);
  if (routePoints.length < 2 || directMi < 0.004) return null;
  const start = projectOnRoute(routePoints, from.point);
  const end = projectOnRoute(routePoints, to.point);
  if (!start || !end || end.measureMi <= start.measureMi + 0.002) return null;

  const accuracyMi = Math.max(Number(from.accuracyM) || 0, Number(to.accuracyM) || 0) / 1609.344;
  const endpointToleranceMi = Math.min(0.16, Math.max(0.045, accuracyMi * 1.75, directMi * 0.8));
  // Reject a route projection that reverses or jumps backward from the prior
  // accepted interval in the same ordered context solve.
  if (start.distanceMi > endpointToleranceMi || end.distanceMi > endpointToleranceMi ||
      (Number.isFinite(previousEndMeasure) && start.measureMi < previousEndMeasure - 0.015)) return null;

  const extracted = [start.point];
  for (let index = start.index + 1; index <= end.index; index++) extracted.push(routePoints[index]);
  extracted.push(end.point);
  const routeMi = lineDistanceMiles({ paths: [extracted] });
  const maxDetourMi = Math.max(0.12, directMi * 3.0 + 0.04);
  if (!Number.isFinite(routeMi) || routeMi < directMi * 0.45 || routeMi > maxDetourMi) return null;

  const gpsBearing = bearingDegrees(from.point, to.point);
  const routeBearing = bearingDegrees(extracted[0], extracted[extracted.length - 1]);
  const intervalHeading = from.heading ?? gpsBearing;
  // A turn can occur inside an interval, so this is intentionally broad; it
  // only rejects a route whose overall travel direction conflicts with GPS.
  if (headingDifference(gpsBearing, routeBearing) > 80 || headingDifference(intervalHeading, routeBearing) > 105) return null;

  return { geometry: new Polyline({ paths: [extracted], spatialReference: wgs84 }), distanceMi: routeMi, endMeasureMi: end.measureMi };
}

async function buildRoadSegments(localDate) {
  if (trip.segmentFeatures) return trip.segmentFeatures;
  const segmentCount = trip.samples.length - 1;
  const features = [];
  // Explicitly use the native lookup Map. The ArcGIS map class is named EsriMap
  // above so it can never shadow this JavaScript collection.
  const matched = new globalThis.Map();
  let routingDiagnostic = "";

  // Checkpoint 1: build and retain independently savable GPS-direct features
  // before any optional routing request is made.
  trip.segmentBuildStage = "preparing GPS-direct fallback segments";
  setStatus(`Diagnostic: preparing ${segmentCount} GPS-direct fallback segments…`);
  try {
    for (let index = 0; index < segmentCount; index++) {
      const from = trip.samples[index], to = trip.samples[index + 1];
      const directPoints = [from.point, to.point];
      const directDistanceMi = miles(directPoints);
      const elapsedHours = (to.recordedAt - from.recordedAt) / 3600000;
      const speedMph = Number.isFinite(to.speedMph) ? to.speedMph : (elapsedHours > 0 ? directDistanceMi / elapsedHours : null);
      features.push(new Graphic({
        geometry: new Polyline({ paths: [directPoints], spatialReference: wgs84 }),
        attributes: {
          trip_id: trip.id,
          segment_seq: index + 1,
          from_sample_seq: from.sequence,
          to_sample_seq: to.sequence,
          speed_mph: speedMph,
          distance_mi: directDistanceMi,
          start_time: from.recordedAt,
          end_time: to.recordedAt,
          commute_type: trip.direction,
          trip_date: localDate.getTime(),
          match_method: "GPS direct segment",
          created_at: trip.endedAt
        }
      }));
    }
  } catch (error) {
    throw new Error(`GPS-direct fallback preparation failed: ${conciseError(error)}`);
  }

  if (trip.directSegmentsOnly) {
    trip.segmentBuildStage = "GPS-direct diagnostic mode complete";
    trip.roadMatchSummary = { snapped: 0, direct: segmentCount, diagnostic: "Diagnostic mode: ArcGIS route matching was skipped." };
    trip.segmentFeatures = features;
    return features;
  }

  // Checkpoint 2: route matching is optional and can never discard the direct features.
  trip.segmentBuildStage = "requesting optional road matching";
  const coreIntervalsPerWindow = 10;
  const guardSamples = 2;
  const windowCount = Math.ceil(segmentCount / coreIntervalsPerWindow);
  let routeUrl = null;
  try {
    routeUrl = await getRouteServiceUrl();
  } catch (error) {
    routingDiagnostic = `Routing service unavailable: ${conciseError(error)}`;
  }

  try {
    for (let windowIndex = 0; routeUrl && windowIndex < windowCount; windowIndex++) {
      const coreStart = windowIndex * coreIntervalsPerWindow;
      const coreEnd = Math.min(segmentCount, coreStart + coreIntervalsPerWindow);
      const contextStart = Math.max(0, coreStart - guardSamples);
      const contextEnd = Math.min(trip.samples.length, coreEnd + 1 + guardSamples);
      setStatus(`Diagnostic: matching window ${windowIndex + 1} of ${windowCount}…`);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      try {
        const contextSamples = trip.samples.slice(contextStart, contextEnd);
        const parameters = new RouteParameters({
          stops: new FeatureSet({
            features: contextSamples.map((sample) => new Graphic({
              geometry: new Point({ x: sample.point[0], y: sample.point[1], spatialReference: wgs84 })
            }))
          }),
          returnRoutes: true,
          returnDirections: false
        });
        const geometry = (await route.solve(routeUrl, parameters)).routeResults?.[0]?.route?.geometry;
        if (!geometry) throw new Error("No route geometry was returned.");
        let previousEndMeasure = null;
        for (let index = coreStart; index < coreEnd; index++) {
          const interval = extractContextInterval(geometry, trip.samples[index], trip.samples[index + 1], previousEndMeasure);
          if (interval) {
            matched.set(index, interval);
            previousEndMeasure = interval.endMeasureMi;
          }
        }
      } catch (error) {
        if (!routingDiagnostic) routingDiagnostic = `Context window ${windowIndex + 1} failed: ${conciseError(error)}`;
      }
    }
  } catch (error) {
    if (!routingDiagnostic) routingDiagnostic = `Road matching was skipped: ${conciseError(error)}`;
  }

  // Checkpoint 3: substitute only confirmed context matches into the already
  // prepared fallback features. Failure here leaves direct features intact.
  trip.segmentBuildStage = "applying confirmed context matches";
  try {
    for (const [index, contextMatch] of matched) {
      features[index].geometry = contextMatch.geometry;
      features[index].attributes.distance_mi = contextMatch.distanceMi;
      features[index].attributes.match_method = "Context matched segment";
    }
  } catch (error) {
    if (!routingDiagnostic) routingDiagnostic = `Context-match application failed: ${conciseError(error)}`;
  }

  trip.roadMatchSummary = { snapped: matched.size, direct: segmentCount - matched.size, diagnostic: routingDiagnostic };
  trip.segmentFeatures = features;
  trip.segmentBuildStage = "segment preparation complete";
  setStatus(`Segment preparation complete: ${matched.size} context-matched, ${segmentCount - matched.size} GPS-direct fallback intervals.`);
  return features;
}

function markSignedIn() {
  signedIn = true;
  $("account-status").textContent = `Signed in to ArcGIS · ${BUILD_VERSION}`;
  startButton.disabled = false;
  setStatus("Ready to start a commute.");
}

async function signIn() {
  try {
    setStatus("Opening ArcGIS sign-in…");
    await esriId.getCredential(`${appConfig.portalUrl}/sharing`, { oAuthPopupConfirmation: false });
    await loadPrivateLayers();
    markSignedIn();
  } catch (error) {
    setStatus(`Sign-in failed: ${error.message}`);
  }
}

async function startCommute() {
  if (!signedIn || !navigator.geolocation) {
    setStatus("Location tracking is unavailable in this browser.");
    return;
  }

  const startedAt = Date.now();
  const direction = calculatedDirection(startedAt);
  const estimate = Number($("estimate").value);
  trip = {
    id: crypto.randomUUID(),
    direction,
    estimate: Number.isFinite(estimate) && estimate > 0 ? estimate : null,
    startedAt,
    points: [],
    samples: [],
    lastSampleAt: 0,
    routeSaved: false,
    samplesSaved: false,
    segmentsSaved: false,
    segmentFeatures: null,
    segmentBuildStage: "",
    directSegmentsOnly: $("direct-segments-only").checked,
    endedAt: null
  };

  watchId = navigator.geolocation.watchPosition(recordPosition, locationError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20000
  });
  timerId = window.setInterval(refreshMetrics, 10000);
  startButton.disabled = true;
  endButton.disabled = false;
  $("estimate").disabled = true;
  $("direct-segments-only").disabled = true;
  $("direction-label").textContent = direction === "Morning" ? "Morning: Home → Work" : "Evening: Work → Home";
  await requestWakeLock();
  setStatus(`Tracking active as ${direction}. Keep this PWA open during the drive.`);
}

function assertAddResults(result, label) {
  const errors = (result.addFeatureResults || []).filter((entry) => entry.error);
  if (errors.length) throw errors[0].error || new Error(`${label} could not be saved.`);
}

async function endCommute() {
  if (!trip) return;
  navigator.geolocation.clearWatch(watchId);
  window.clearInterval(timerId);
  releaseWakeLock();
  endButton.disabled = true;

  if (trip.points.length < 2) {
    setStatus("Not enough GPS samples were captured; trip was not saved.");
    reset();
    return;
  }

  trip.endedAt ||= Date.now();
  const duration = (trip.endedAt - trip.startedAt) / 60000;
  const localDate = new Date(trip.startedAt);
  localDate.setHours(0, 0, 0, 0);
  // Kept until completion so a retry resumes only unfinished stages.
  let saveStage = "preparing the completed trip";

  const routeAttributes = {
    trip_id: trip.id,
    commute_type: trip.direction,
    origin_label: trip.direction === "Morning" ? "Home" : "Work",
    destination_label: trip.direction === "Morning" ? "Work" : "Home",
    trip_date: localDate.getTime(),
    start_time: trip.startedAt,
    end_time: trip.endedAt,
    duration_min: duration,
    distance_mi: miles(trip.points),
    google_estimate_min: trip.estimate,
    delay_vs_estimate_min: trip.estimate == null ? null : duration - trip.estimate,
    created_at: trip.endedAt
  };

  const sampleFeatures = trip.samples.map((sample) => new Graphic({
    geometry: new Point({
      x: sample.point[0],
      y: sample.point[1],
      spatialReference: wgs84
    }),
    attributes: {
      trip_id: trip.id,
      sample_seq: sample.sequence,
      recorded_at: sample.recordedAt,
      speed_mph: sample.speedMph,
      accuracy_m: sample.accuracyM,
      commute_type: trip.direction,
      trip_date: localDate.getTime(),
      created_at: trip.endedAt,
      latitude: sample.point[1],
      longitude: sample.point[0]
    }
  }));

  try {
    if (!trip.routeSaved) {
      saveStage = "route save";
      setStatus("Saving private commute route to ArcGIS…");
      const result = await commuteLayer.applyEdits({
        addFeatures: [new Graphic({
          geometry: new Polyline({ paths: [trip.points], spatialReference: wgs84 }),
          attributes: routeAttributes
        })]
      });
      assertAddResults(result, "Commute route");
      trip.routeSaved = true;
    }

    if (!trip.samplesSaved) {
      saveStage = "samples save";
      setStatus(`Saving ${sampleFeatures.length} private GPS samples to ArcGIS…`);
      const result = await sampleLayer.applyEdits({ addFeatures: sampleFeatures });
      assertAddResults(result, "GPS samples");
      trip.samplesSaved = true;
    }

    if (!trip.segmentsSaved) {
      saveStage = "road matching";
      const segmentFeatures = await buildRoadSegments(localDate);
      saveStage = "derived-segment save";
      setStatus(`Saving ${segmentFeatures.length} road-matched speed segments to ArcGIS…`);
      const result = await speedSegmentsLayer.applyEdits({ addFeatures: segmentFeatures });
      assertAddResults(result, "Road-matched speed segments");
      trip.segmentsSaved = true;
    }

    const match = trip.roadMatchSummary || { snapped: 0, direct: 0, diagnostic: "" };
    const detail = match.diagnostic ? ` ${match.diagnostic}` : "";
    setStatus(`Commute route and GPS samples saved. Segments: ${match.snapped} context-matched, ${match.direct} GPS-direct fallback.${detail}`);
    reset();
  } catch (error) {
    // Do not reset `trip`: completed GPS data and completed stages stay in memory
    // and End Commute resumes at the stage identified below.
    const detailedStage = saveStage === "road matching" && trip?.segmentBuildStage
      ? `${saveStage} — ${trip.segmentBuildStage}`
      : saveStage;
    setStatus(`Save failed during ${detailedStage}: ${conciseError(error)}. Keep this page open and tap End Commute again to retry.`);
    endButton.disabled = false;
  }
}

function reset() {
  releaseWakeLock();
  trip = null;
  routeLayer.removeAll();
  startButton.disabled = !signedIn;
  endButton.disabled = true;
  $("estimate").disabled = false;
  $("direct-segments-only").disabled = false;
  $("direction-label").textContent = "Calculated when you start";
  $("elapsed").textContent = "0 min";
  $("distance").textContent = "0.0 mi";
  $("samples").textContent = "0";
}

async function restoreSignedInSession() {
  try {
    const credential = await esriId.checkSignInStatus(`${appConfig.portalUrl}/sharing`);
    if (!credential) return;
    await loadPrivateLayers();
    markSignedIn();
  } catch {
    // No saved ArcGIS session yet; the user can select Sign in to ArcGIS.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && trip && !wakeLock) requestWakeLock();
});

restoreSignedInSession();
$("sign-in").addEventListener("click", signIn);
startButton.addEventListener("click", startCommute);
endButton.addEventListener("click", endCommute);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
