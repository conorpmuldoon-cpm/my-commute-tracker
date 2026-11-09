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
const commuteLayer = new FeatureLayer({ url: appConfig.featureLayerUrl, outFields: ["*"] });
const segmentsLayer = new FeatureLayer({ url: appConfig.speedSegmentsLayerUrl, outFields: ["*"] });
const sampleLayer = new FeatureLayer({ url: appConfig.sampleLayerUrl, outFields: ["*"] });
const previewLayer = new GraphicsLayer({ title: "Temporary road-match preview" });
const map = new Map({ basemap: "streets-vector", layers: [commuteLayer, segmentsLayer, previewLayer] });
const view = new MapView({ container: "viewDiv", map, center: [-75.43, 40.06], zoom: 11 });
let signedIn = false;
let currentWhere = "1=0";
let currentTrips = [];
let selectedTripId = null;
let previewRouteServiceUrlPromise = null;

commuteLayer.renderer = { type: "simple", symbol: { type: "simple-line", color: "#64748b", width: 1.25 } };
segmentsLayer.renderer = {
  type: "unique-value",
  valueExpression: `
    var method = DefaultValue($feature.match_method, '');
    if (Left(method, 10) == 'GPS direct') return 'fallback';
    var speed = $feature.speed_mph;
    if (IsEmpty(speed)) return 'unknown';
    if (speed <= 5) return '0–5 mph';
    if (speed <= 15) return '5–15 mph';
    if (speed <= 30) return '15–30 mph';
    if (speed <= 50) return '30–50 mph';
    return '50+ mph';`,
  uniqueValueInfos: [
    { value: "0–5 mph", label: "Road-derived: 0–5 mph", symbol: { type: "simple-line", color: "#d73027", width: 3 } },
    { value: "5–15 mph", label: "Road-derived: 5–15 mph", symbol: { type: "simple-line", color: "#fc8d59", width: 3 } },
    { value: "15–30 mph", label: "Road-derived: 15–30 mph", symbol: { type: "simple-line", color: "#fee08b", width: 3 } },
    { value: "30–50 mph", label: "Road-derived: 30–50 mph", symbol: { type: "simple-line", color: "#91cf60", width: 3 } },
    { value: "50+ mph", label: "Road-derived: 50+ mph", symbol: { type: "simple-line", color: "#1a9850", width: 3 } },
    { value: "fallback", label: "GPS-direct fallback", symbol: { type: "simple-line", color: "#64748b", width: 1.5, style: "short-dot" } },
    { value: "unknown", label: "No speed", symbol: { type: "simple-line", color: "#9ca3af", width: 1.5, style: "short-dot" } }
  ]
};
segmentsLayer.popupTemplate = {
  title: "{commute_type} segment {segment_seq}",
  expressionInfos: [
    { name: "speed_one_decimal", expression: "Round($feature.speed_mph, 1)" },
    { name: "distance_feet", expression: "Round($feature.distance_mi * 5280, 0)" }
  ],
  content: [
    { type: "text", text: "<b>Speed:</b> {expression/speed_one_decimal} mph<br><b>Distance:</b> {expression/distance_feet} ft" },
    { type: "fields", fieldInfos: [
      { fieldName: "start_time", label: "Start" }, { fieldName: "end_time", label: "End" }, { fieldName: "match_method", label: "Match method" }
    ] }
  ]
};

const oauth = new OAuthInfo({ appId: appConfig.clientId, portalUrl: appConfig.portalUrl, popup: false, popupCallbackUrl: appConfig.redirectUrl });
esriId.registerOAuthInfos([oauth]);

function setStatus(message) { $("status").textContent = message; }
function setKpi(id, value) { $(id).textContent = value; }
function fmt(value, digits = 1) { return Number.isFinite(value) ? value.toFixed(digits) : "—"; }
function quote(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function dateLabel(value) { return value ? new Date(value).toLocaleDateString() : "—"; }
function weekdayLabel(value) { return value ? new Date(value).toLocaleDateString(undefined, { weekday: "long" }) : "—"; }
function previewColor(speed) {
  if (!Number.isFinite(speed)) return "#9ca3af";
  if (speed <= 5) return "#d73027";
  if (speed <= 15) return "#fc8d59";
  if (speed <= 30) return "#fee08b";
  if (speed <= 50) return "#91cf60";
  return "#1a9850";
}
function previewStatus(message) { $("preview-status").textContent = message; }

async function getPreviewRouteServiceUrl() {
  if (!previewRouteServiceUrlPromise) {
    previewRouteServiceUrlPromise = (async () => {
      const portal = new Portal({ url: appConfig.portalUrl });
      await portal.load();
      const routeUrl = portal.helperServices?.route?.url;
      if (!routeUrl) throw new Error("No ArcGIS routing service is configured for this portal.");
      await esriId.getCredential(routeUrl);
      return routeUrl;
    })();
  }
  return previewRouteServiceUrlPromise;
}

function pointMiles(a, b) {
  const radians = Math.PI / 180, r = 6371000;
  const h = Math.sin((b[1] - a[1]) * radians / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin((b[0] - a[0]) * radians / 2) ** 2;
  return (2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))) / 1609.344;
}

function pathMiles(points) {
  return points.slice(1).reduce((sum, point, index) => sum + pointMiles(points[index], point), 0);
}

function contextSegment(geometry, fromPoint, toPoint) {
  // The overlapping solve supplies road context. Extract only the portion nearest
  // this original GPS interval, rather than drawing the entire context window.
  const points = (geometry.paths || []).flat();
  if (points.length < 2) return null;
  const nearestIndex = (target) => points.reduce((best, point, index) => {
    const distance = pointMiles(target, point);
    return distance < best.distance ? { index, distance } : best;
  }, { index: -1, distance: Infinity });
  const from = nearestIndex(fromPoint), to = nearestIndex(toPoint);
  if (from.index < 0 || to.index <= from.index) return null;
  const extracted = points.slice(from.index, to.index + 1);
  const directMiles = pointMiles(fromPoint, toPoint);
  const extractedMiles = pathMiles(extracted);
  const endpointToleranceMi = Math.max(0.08, directMiles * 0.9);
  const maxRouteMiles = Math.max(0.15, directMiles * 3.5 + 0.05);
  if (from.distance > endpointToleranceMi || to.distance > endpointToleranceMi || extractedMiles > maxRouteMiles) return null;
  return new Polyline({ paths: [extracted], spatialReference: { wkid: 4326 } });
}

async function previewWindowedMatch() {
  if (!selectedTripId) {
    previewStatus("Select one trip before building a preview.");
    return;
  }
  const contextRadius = 2; // Two samples before and after makes a short, overlapping context window.
  previewLayer.removeAll();
  $("preview").disabled = true;
  previewStatus("Loading raw GPS samples for the selected trip…");
  try {
    const result = await sampleLayer.queryFeatures({
      where: `trip_id = ${quote(selectedTripId)}`,
      outFields: ["sample_seq", "recorded_at", "speed_mph"],
      returnGeometry: true,
      orderByFields: ["sample_seq ASC"]
    });
    const samples = result.features.map((feature) => ({
      point: [feature.geometry.longitude, feature.geometry.latitude],
      recordedAt: Number(feature.attributes.recorded_at),
      sequence: Number(feature.attributes.sample_seq),
      speedMph: Number(feature.attributes.speed_mph)
    })).filter((sample) => sample.point.every(Number.isFinite));
    if (samples.length < 2) throw new Error("This trip does not have enough GPS samples for a preview.");
    const routeUrl = await getPreviewRouteServiceUrl();
    const graphics = [];
    let fallbackCount = 0;
    const segmentCount = samples.length - 1;
    for (let index = 0; index < segmentCount; index++) {
      const from = samples[index], to = samples[index + 1];
      const directPoints = [from.point, to.point];
      const elapsedHours = (to.recordedAt - from.recordedAt) / 3600000;
      const speedMph = Number.isFinite(to.speedMph) ? to.speedMph : (elapsedHours > 0 ? pointMiles(...directPoints) / elapsedHours : null);
      const contextSamples = samples.slice(Math.max(0, index - contextRadius), Math.min(samples.length, index + contextRadius + 2));
      let geometry = new Polyline({ paths: [directPoints], spatialReference: { wkid: 4326 } });
      let fallback = true;
      previewStatus(`Context-matching interval ${index + 1} of ${segmentCount}…`);
      try {
        const parameters = new RouteParameters({
          stops: new FeatureSet({ features: contextSamples.map((sample) => new Graphic({ geometry: new Point({ longitude: sample.point[0], latitude: sample.point[1] }) })) }),
          returnRoutes: true,
          returnDirections: false,
          returnStops: false,
          outSpatialReference: { wkid: 4326 }
        });
        const matchedRoute = (await route.solve(routeUrl, parameters)).routeResults?.[0]?.route;
        const extracted = matchedRoute?.geometry && contextSegment(matchedRoute.geometry, from.point, to.point);
        if (extracted) {
          geometry = extracted;
          fallback = false;
        }
      } catch { /* A direct raw segment is intentionally retained below. */ }
      if (fallback) fallbackCount++;
      graphics.push(new Graphic({
        geometry,
        symbol: fallback
          ? { type: "simple-line", color: "#64748b", width: 2, style: "short-dot" }
          : { type: "simple-line", color: previewColor(speedMph), width: 4 },
        attributes: { preview: true, speed_mph: speedMph, from_sample_seq: from.sequence, to_sample_seq: to.sequence, match_method: fallback ? "GPS direct preview fallback" : "Context-matched preview" },
        popupTemplate: { title: "Preview interval {from_sample_seq}–{to_sample_seq}", content: "<b>Original local speed:</b> {speed_mph} mph<br><b>Method:</b> {match_method}" }
      }));
    }
    previewLayer.addMany(graphics);
    $("clear-preview").disabled = false;
    previewStatus(`Temporary preview complete: ${graphics.length - fallbackCount} context-matched interval${graphics.length - fallbackCount === 1 ? "" : "s"}; ${fallbackCount} gray dotted raw-direct fallback${fallbackCount === 1 ? "" : "s"}. Nothing was saved or changed.`);
  } catch (error) {
    previewStatus(`Preview failed: ${error.message}`);
  } finally {
    $("preview").disabled = !selectedTripId;
  }
}

function clearPreview() {
  previewLayer.removeAll();
  $("clear-preview").disabled = true;
  previewStatus("Preview cleared.");
}

async function selectTrip(tripId, zoom = true) {
  if (!tripId || !currentTrips.some((feature) => feature.attributes.trip_id === tripId)) return;
  selectedTripId = tripId;
  clearPreview();
  $("preview").disabled = false;
  const where = `trip_id = ${quote(tripId)}`;
  commuteLayer.definitionExpression = where;
  segmentsLayer.definitionExpression = where;
  $("show-all").disabled = false;
  document.querySelectorAll("#trip-table tr[data-trip-id]").forEach((row) => row.classList.toggle("selected", row.dataset.tripId === tripId));
  const feature = currentTrips.find((item) => item.attributes.trip_id === tripId);
  if (zoom && feature?.geometry) await view.goTo(feature, { padding: 50, duration: 400 });
  await updateSummary([feature], where);
  setStatus("One commute selected. Use Show all selected trips to restore the filtered comparison.");
}

async function updateSummary(trips, where) {
  const totalMiles = trips.reduce((sum, feature) => sum + (Number(feature.attributes.distance_mi) || 0), 0);
  const totalMinutes = trips.reduce((sum, feature) => sum + (Number(feature.attributes.duration_min) || 0), 0);
  const delays = trips.map((feature) => Number(feature.attributes.delay_vs_estimate_min)).filter(Number.isFinite);
  setKpi("trip-count", String(trips.length));
  setKpi("avg-duration", trips.length ? `${fmt(totalMinutes / trips.length)} min` : "—");
  setKpi("avg-speed", totalMinutes ? `${fmt(totalMiles / totalMinutes * 60)} mph` : "—");
  setKpi("avg-delay", delays.length ? `${fmt(delays.reduce((a, b) => a + b, 0) / delays.length)} min` : "—");
  const segmentResult = trips.length ? await segmentsLayer.queryFeatures({ where, outFields: ["match_method"], returnGeometry: false }) : { features: [] };
  const fallback = segmentResult.features.filter((feature) => String(feature.attributes.match_method || "").startsWith("GPS direct")).length;
  const roadDerived = segmentResult.features.length - fallback;
  $("segment-quality").textContent = `${roadDerived} road-derived feature${roadDerived === 1 ? "" : "s"}; ${fallback} GPS-direct fallback feature${fallback === 1 ? "" : "s"}.`;
}

async function showAllSelectedTrips() {
  selectedTripId = null;
  clearPreview();
  $("preview").disabled = true;
  commuteLayer.definitionExpression = currentWhere;
  segmentsLayer.definitionExpression = currentWhere;
  $("show-all").disabled = true;
  document.querySelectorAll("#trip-table tr[data-trip-id]").forEach((row) => row.classList.remove("selected"));
  await updateSummary(currentTrips, currentWhere);
  setStatus(`${currentTrips.length} trip${currentTrips.length === 1 ? "" : "s"} selected.`);
}

async function signIn() {
  try {
    sessionStorage.setItem("commuteOAuthReturnPath", "./dashboard.html");
    setStatus("Opening ArcGIS sign-in…");
    await esriId.getCredential(`${appConfig.portalUrl}/sharing`, { oAuthPopupConfirmation: false });
    await loadLayers();
  } catch (error) { setStatus(`Sign-in failed: ${error.message}`); }
}

async function loadLayers() {
  await Promise.all([commuteLayer.load(), segmentsLayer.load(), sampleLayer.load()]);
  signedIn = true;
  $("sign-in").textContent = "Signed in to ArcGIS";
  $("sign-in").disabled = true;
  $("apply").disabled = false;
  $("reset").disabled = false;
  setStatus("Ready. Apply filters to load your private commute data.");
}

async function applyFilters() {
  if (!signedIn) return;
  const direction = $("direction").value;
  const day = $("day").value;
  const min = Number($("min-duration").value);
  const max = Number($("max-duration").value);
  const range = Number($("date-range").value);
  const clauses = ["1=1"];
  if (direction) clauses.push(`commute_type = ${quote(direction)}`);
  if (Number.isFinite(min) && min > 0) clauses.push(`duration_min >= ${min}`);
  if (Number.isFinite(max) && max > 0) clauses.push(`duration_min <= ${max}`);
  commuteLayer.definitionExpression = "1=1";
  segmentsLayer.definitionExpression = "1=1";
  setStatus("Loading selected commute data…");
  const result = await commuteLayer.queryFeatures({ where: clauses.join(" AND "), outFields: ["trip_id","trip_date","duration_min","distance_mi","delay_vs_estimate_min","commute_type","google_estimate_min"], returnGeometry: true, orderByFields: ["trip_date DESC"] });
  const cutoff = range ? Date.now() - range * 86400000 : null;
  const trips = result.features.filter((feature) => {
    const a = feature.attributes;
    if (day !== "" && new Date(a.trip_date).getDay() !== Number(day)) return false;
    return !cutoff || Number(a.trip_date) >= cutoff;
  });
  const ids = trips.map((feature) => feature.attributes.trip_id).filter(Boolean);
  const where = ids.length ? `trip_id IN (${ids.map(quote).join(",")})` : "1=0";
  currentTrips = trips;
  currentWhere = where;
  selectedTripId = null;
  clearPreview();
  $("preview").disabled = true;
  commuteLayer.definitionExpression = where;
  segmentsLayer.definitionExpression = where;
  $("show-all").disabled = true;
  await updateSummary(trips, where);
  $("trip-table").innerHTML = trips.slice(0, 12).map((feature) => {
    const a = feature.attributes;
    return `<tr data-trip-id="${a.trip_id}"><td>${dateLabel(a.trip_date)}</td><td>${weekdayLabel(a.trip_date)}</td><td>${a.commute_type || "—"}</td><td>${fmt(Number(a.duration_min))} min</td><td>${fmt(Number(a.google_estimate_min))} min</td><td>${fmt(Number(a.delay_vs_estimate_min))} min</td><td>${fmt(Number(a.distance_mi))} mi</td></tr>`;
  }).join("") || '<tr><td colspan="7">No trips match the selected filters.</td></tr>';
  if (trips.length) await view.goTo(trips, { padding: 50, duration: 400 });
  setStatus(`${trips.length} trip${trips.length === 1 ? "" : "s"} selected.`);
}

function resetFilters() {
  $("direction").value = ""; $("day").value = ""; $("min-duration").value = ""; $("max-duration").value = ""; $("date-range").value = "0";
  commuteLayer.definitionExpression = "1=1"; segmentsLayer.definitionExpression = "1=1";
  currentTrips = []; currentWhere = "1=0"; selectedTripId = null;
  clearPreview();
  $("preview").disabled = true;
  $("show-all").disabled = true;
  ["trip-count","avg-duration","avg-speed","avg-delay"].forEach((id) => setKpi(id, "—"));
  $("segment-quality").textContent = "Apply filters to see road-match quality.";
  $("trip-table").innerHTML = '<tr><td colspan="7">No data loaded.</td></tr>';
  setStatus("Filters cleared.");
}

async function restoreSession() {
  try {
    const credential = await esriId.checkSignInStatus(`${appConfig.portalUrl}/sharing`);
    if (credential) await loadLayers();
  } catch { /* Sign-in remains available. */ }
}

$("sign-in").addEventListener("click", signIn);
$("apply").addEventListener("click", () => applyFilters().catch((error) => setStatus(`Filter failed: ${error.message}`)));
$("show-all").addEventListener("click", () => showAllSelectedTrips().catch((error) => setStatus(`Summary refresh failed: ${error.message}`)));
$("preview").addEventListener("click", () => previewWindowedMatch());
$("clear-preview").addEventListener("click", clearPreview);
$("reset").addEventListener("click", resetFilters);
$("show-routes").addEventListener("change", (event) => { commuteLayer.visible = event.target.checked; });
$("show-segments").addEventListener("change", (event) => { segmentsLayer.visible = event.target.checked; });
$("trip-table").addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-trip-id]");
  if (row) selectTrip(row.dataset.tripId).catch((error) => setStatus(`Trip selection failed: ${error.message}`));
});
view.on("click", async (event) => {
  const hit = await view.hitTest(event, { include: [commuteLayer, segmentsLayer] });
  const graphic = hit.results.find((result) => result.graphic?.attributes?.trip_id)?.graphic;
  if (graphic?.attributes?.trip_id) selectTrip(graphic.attributes.trip_id).catch((error) => setStatus(`Trip selection failed: ${error.message}`));
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
restoreSession();
