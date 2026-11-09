import Map from "https://js.arcgis.com/4.30/@arcgis/core/Map.js";
import MapView from "https://js.arcgis.com/4.30/@arcgis/core/views/MapView.js";
import FeatureLayer from "https://js.arcgis.com/4.30/@arcgis/core/layers/FeatureLayer.js";
import GraphicsLayer from "https://js.arcgis.com/4.30/@arcgis/core/layers/GraphicsLayer.js";
import Graphic from "https://js.arcgis.com/4.30/@arcgis/core/Graphic.js";
import Point from "https://js.arcgis.com/4.30/@arcgis/core/geometry/Point.js";
import Polyline from "https://js.arcgis.com/4.30/@arcgis/core/geometry/Polyline.js";
import Portal from "https://js.arcgis.com/4.30/@arcgis/core/portal/Portal.js";
import * as route from "https://js.arcgis.com/4.30/@arcgis/core/rest/route.js";
import RouteParameters from "https://js.arcgis.com/4.30/@arcgis/core/rest/support/RouteParameters.js";
import FeatureSet from "https://js.arcgis.com/4.30/@arcgis/core/rest/support/FeatureSet.js";
import OAuthInfo from "https://js.arcgis.com/4.30/@arcgis/core/identity/OAuthInfo.js";
import esriId from "https://js.arcgis.com/4.30/@arcgis/core/identity/IdentityManager.js";
import { appConfig } from "./app-config.js";

const $ = (id) => document.getElementById(id);
const startButton = $("start"), endButton = $("end"), status = $("status");
let watchId = null, timerId = null, trip = null, signedIn = false, wakeLock = null;

const routeLayer = new GraphicsLayer({ title: "Active commute" });
const map = new Map({ basemap: "streets-vector", layers: [routeLayer] });
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
    geometry: new Polyline({ paths: [trip.points], spatialReference: { wkid: 4326 } }),
    symbol: { type: "simple-line", color: "#e4572e", width: 4 }
  }));
}

function recordPosition(position) {
  if (!trip || position.coords.accuracy > 75) return;

  const capturedAt = Number.isFinite(position.timestamp) ? position.timestamp : Date.now();
  const point = [position.coords.longitude, position.coords.latitude];
  const lastPoint = trip.points[trip.points.length - 1];
  const lastSample = trip.samples[trip.samples.length - 1];

  if (lastSample && capturedAt - lastSample.recordedAt < 9000) return;

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

async function buildRoadSegments(localDate) {
  if (trip.segmentFeatures) return trip.segmentFeatures;
  let routeUrl = null;
  let routingDiagnostic = "";
  try {
    routeUrl = await getRouteServiceUrl();
  } catch (error) {
    routingDiagnostic = `Routing service unavailable: ${conciseError(error)}`;
  }

  // Production storage intentionally remains one feature per captured GPS interval
  // (normally about 10 seconds). Context-window matching is preview-only in the dashboard.
  const features = [];
  const segmentCount = trip.samples.length - 1;
  for (let startIndex = 0; startIndex < segmentCount; startIndex++) {
    const from = trip.samples[startIndex];
    const to = trip.samples[startIndex + 1];
    const directPoints = [from.point, to.point];
    let geometry = new Polyline({ paths: [directPoints], spatialReference: { wkid: 4326 } });
    let matchMethod = "GPS direct segment";
    let distanceMi = miles(directPoints);
    const elapsedHours = (to.recordedAt - from.recordedAt) / 3600000;
    const speedMph = Number.isFinite(to.speedMph) ? to.speedMph : (elapsedHours > 0 ? distanceMi / elapsedHours : null);

    try {
      setStatus(`Road-matching segment ${startIndex + 1} of ${segmentCount}… Keep this page open.`);
      if (!routeUrl) throw new Error("Routing is unavailable.");
      const parameters = new RouteParameters({
        stops: new FeatureSet({ features: [from, to].map((sample) => new Graphic({
          geometry: new Point({ longitude: sample.point[0], latitude: sample.point[1] })
        })) }),
        returnRoutes: true,
        returnDirections: false,
        returnStops: false,
        outSpatialReference: { wkid: 4326 }
      });
      const solved = await route.solve(routeUrl, parameters);
      const matchedRoute = solved.routeResults?.[0]?.route;
      if (!matchedRoute?.geometry) throw new Error("No matched route was returned.");
      geometry = matchedRoute.geometry;
      matchMethod = "Road matched segment";
      distanceMi = Number(matchedRoute.attributes?.Total_Miles);
      if (!Number.isFinite(distanceMi)) distanceMi = lineDistanceMiles(geometry);
    } catch (error) {
      if (!routingDiagnostic) routingDiagnostic = `Road matching failed at segment ${startIndex + 1}: ${conciseError(error)}`;
    }

    features.push(new Graphic({
      geometry,
      attributes: {
        trip_id: trip.id,
        segment_seq: startIndex + 1,
        from_sample_seq: from.sequence,
        to_sample_seq: to.sequence,
        speed_mph: speedMph,
        distance_mi: distanceMi,
        start_time: from.recordedAt,
        end_time: to.recordedAt,
        commute_type: trip.direction,
        trip_date: localDate.getTime(),
        match_method: matchMethod,
        created_at: trip.endedAt
      }
    }));
  }

  trip.roadMatchSummary = {
    snapped: features.filter((feature) => feature.attributes.match_method === "Road matched segment").length,
    direct: features.filter((feature) => feature.attributes.match_method === "GPS direct segment").length,
    diagnostic: routingDiagnostic
  };
  trip.segmentFeatures = features;
  return features;
}

function markSignedIn() {
  signedIn = true;
  $("account-status").textContent = "Signed in to ArcGIS";
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
      longitude: sample.point[0],
      latitude: sample.point[1],
      spatialReference: { wkid: 4326 }
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
      setStatus("Saving private commute route to ArcGIS…");
      const result = await commuteLayer.applyEdits({
        addFeatures: [new Graphic({
          geometry: new Polyline({ paths: [trip.points], spatialReference: { wkid: 4326 } }),
          attributes: routeAttributes
        })]
      });
      assertAddResults(result, "Commute route");
      trip.routeSaved = true;
    }

    if (!trip.samplesSaved) {
      setStatus(`Saving ${sampleFeatures.length} private GPS samples to ArcGIS…`);
      const result = await sampleLayer.applyEdits({ addFeatures: sampleFeatures });
      assertAddResults(result, "GPS samples");
      trip.samplesSaved = true;
    }

    if (!trip.segmentsSaved) {
      const segmentFeatures = await buildRoadSegments(localDate);
      setStatus(`Saving ${segmentFeatures.length} road-matched speed segments to ArcGIS…`);
      const result = await speedSegmentsLayer.applyEdits({ addFeatures: segmentFeatures });
      assertAddResults(result, "Road-matched speed segments");
      trip.segmentsSaved = true;
    }

    const match = trip.roadMatchSummary || { snapped: 0, direct: 0, diagnostic: "" };
    const detail = match.diagnostic ? ` ${match.diagnostic}` : "";
    setStatus(`Commute route and GPS samples saved. Segments: ${match.snapped} road-matched, ${match.direct} GPS-direct fallback.${detail}`);
    reset();
  } catch (error) {
    setStatus(`Save failed: ${error.message}. Keep this page open and tap End Commute again to retry.`);
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
