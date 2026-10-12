import Map from "https://js.arcgis.com/4.30/@arcgis/core/Map.js";
import MapView from "https://js.arcgis.com/4.30/@arcgis/core/views/MapView.js";
import FeatureLayer from "https://js.arcgis.com/4.30/@arcgis/core/layers/FeatureLayer.js";
import GraphicsLayer from "https://js.arcgis.com/4.30/@arcgis/core/layers/GraphicsLayer.js";
import Graphic from "https://js.arcgis.com/4.30/@arcgis/core/Graphic.js";
import Point from "https://js.arcgis.com/4.30/@arcgis/core/geometry/Point.js";
import Polyline from "https://js.arcgis.com/4.30/@arcgis/core/geometry/Polyline.js";
import Portal from "https://js.arcgis.com/4.30/@arcgis/core/portal/Portal.js";
import RouteTask from "https://js.arcgis.com/4.30/@arcgis/core/rest/route/RouteTask.js";
import RouteParameters from "https://js.arcgis.com/4.30/@arcgis/core/rest/route/RouteParameters.js";
import FeatureSet from "https://js.arcgis.com/4.30/@arcgis/core/rest/support/FeatureSet.js";
import OAuthInfo from "https://js.arcgis.com/4.30/@arcgis/core/identity/OAuthInfo.js";
import esriId from "https://js.arcgis.com/4.30/@arcgis/core/identity/IdentityManager.js";
import { appConfig } from "./app-config.js";

const $ = (id) => document.getElementById(id);
const startButton = $("start"), endButton = $("end"), status = $("status");
let watchId = null, timerId = null, trip = null, signedIn = false;

const routeLayer = new GraphicsLayer({ title: "Active commute" });
const map = new Map({ basemap: "streets-vector", layers: [routeLayer] });
const view = new MapView({ container: "viewDiv", map, center: [-75.28, 40.0], zoom: 10 });
const commuteLayer = new FeatureLayer({ url: appConfig.featureLayerUrl, outFields: ["*"] });
const sampleLayer = new FeatureLayer({ url: appConfig.sampleLayerUrl, outFields: ["*"] });
const speedSegmentsLayer = new FeatureLayer({ url: appConfig.speedSegmentsLayerUrl, outFields: ["*"] });
let routeTaskPromise = null;

const oauth = new OAuthInfo({
  appId: appConfig.clientId,
  portalUrl: appConfig.portalUrl,
  popup: false,
  popupCallbackUrl: appConfig.redirectUrl
});
esriId.registerOAuthInfos([oauth]);

function setStatus(message) { status.textContent = message; }

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

async function getRouteTask() {
  if (!routeTaskPromise) {
    routeTaskPromise = (async () => {
      const portal = new Portal({ url: appConfig.portalUrl });
      await portal.load();
      const routeUrl = portal.helperServices?.route?.url;
      if (!routeUrl) throw new Error("No ArcGIS routing service is configured for this portal.");
      await esriId.getCredential(routeUrl);
      return new RouteTask({ url: routeUrl });
    })();
  }
  return routeTaskPromise;
}

function lineDistanceMiles(geometry) {
  return (geometry.paths || []).reduce((total, path) => total + miles(path), 0);
}

async function buildRoadSegments(localDate) {
  if (trip.segmentFeatures) return trip.segmentFeatures;
  let task = null;
  try {
    task = await getRouteTask();
  } catch {
    // The segments will still be preserved as direct GPS lines if routing is unavailable.
  }
  const features = [];

  for (let i = 1; i < trip.samples.length; i++) {
    const from = trip.samples[i - 1];
    const to = trip.samples[i];
    let geometry = new Polyline({ paths: [[from.point, to.point]], spatialReference: { wkid: 4326 } });
    let matchMethod = "GPS direct";
    let distanceMi = miles([from.point, to.point]);

    try {
      setStatus(`Road-matching segment ${i} of ${trip.samples.length - 1}… Keep this page open.`);
      const parameters = new RouteParameters({
        stops: new FeatureSet({ features: [
          new Graphic({ geometry: new Point({ longitude: from.point[0], latitude: from.point[1] }) }),
          new Graphic({ geometry: new Point({ longitude: to.point[0], latitude: to.point[1] }) })
        ] }),
        returnRoutes: true,
        returnDirections: false,
        returnStops: false,
        outSpatialReference: { wkid: 4326 }
      });
      const solved = await task.solve(parameters);
      const route = solved.routeResults?.[0]?.route;
      if (!route?.geometry) throw new Error("No matched route was returned.");
      geometry = route.geometry;
      matchMethod = "Road snapped";
      distanceMi = Number(route.attributes?.Total_Miles);
      if (!Number.isFinite(distanceMi)) distanceMi = lineDistanceMiles(geometry);
    } catch {
      // Preserve the trip with a direct GPS line if a network match is unavailable.
    }

    features.push(new Graphic({
      geometry,
      attributes: {
        trip_id: trip.id,
        segment_seq: i,
        from_sample_seq: from.sequence,
        to_sample_seq: to.sequence,
        speed_mph: to.speedMph,
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

function startCommute() {
  if (!signedIn || !navigator.geolocation) {
    setStatus("Location tracking is unavailable in this browser.");
    return;
  }

  const direction = $("direction").value;
  const estimate = Number($("estimate").value);
  trip = {
    id: crypto.randomUUID(),
    direction,
    estimate: Number.isFinite(estimate) && estimate > 0 ? estimate : null,
    startedAt: Date.now(),
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
  $("direction").disabled = true;
  $("estimate").disabled = true;
  setStatus("Tracking active. Keep this PWA open during the drive.");
}

function assertAddResults(result, label) {
  const errors = (result.addFeatureResults || []).filter((entry) => entry.error);
  if (errors.length) throw errors[0].error || new Error(`${label} could not be saved.`);
}

async function endCommute() {
  if (!trip) return;
  navigator.geolocation.clearWatch(watchId);
  window.clearInterval(timerId);
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

    setStatus("Commute route, GPS samples, and road-matched speed segments saved privately to ArcGIS.");
    reset();
  } catch (error) {
    setStatus(`Save failed: ${error.message}. Keep this page open and tap End Commute again to retry.`);
    endButton.disabled = false;
  }
}

function reset() {
  trip = null;
  routeLayer.removeAll();
  startButton.disabled = !signedIn;
  endButton.disabled = true;
  $("direction").disabled = false;
  $("estimate").disabled = false;
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

restoreSignedInSession();
$("sign-in").addEventListener("click", signIn);
startButton.addEventListener("click", startCommute);
endButton.addEventListener("click", endCommute);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
