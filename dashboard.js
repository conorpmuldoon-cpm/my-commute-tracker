import Map from "https://js.arcgis.com/4.30/@arcgis/core/Map.js";
import MapView from "https://js.arcgis.com/4.30/@arcgis/core/views/MapView.js";
import FeatureLayer from "https://js.arcgis.com/4.30/@arcgis/core/layers/FeatureLayer.js";
import OAuthInfo from "https://js.arcgis.com/4.30/@arcgis/core/identity/OAuthInfo.js";
import esriId from "https://js.arcgis.com/4.30/@arcgis/core/identity/IdentityManager.js";
import { appConfig } from "./app-config.js";

const $ = (id) => document.getElementById(id);
const commuteLayer = new FeatureLayer({ url: appConfig.featureLayerUrl, outFields: ["*"] });
const segmentsLayer = new FeatureLayer({ url: appConfig.speedSegmentsLayerUrl, outFields: ["*"] });
const map = new Map({ basemap: "streets-vector", layers: [commuteLayer, segmentsLayer] });
const view = new MapView({ container: "viewDiv", map, center: [-75.43, 40.06], zoom: 11 });
let signedIn = false;

commuteLayer.renderer = { type: "simple", symbol: { type: "simple-line", color: "#64748b", width: 1.25 } };
segmentsLayer.renderer = {
  type: "class-breaks", field: "speed_mph", classBreakInfos: [
    { minValue: 0, maxValue: 5, label: "0–5 mph", symbol: { type: "simple-line", color: "#d73027", width: 3 } },
    { minValue: 5, maxValue: 15, label: "5–15 mph", symbol: { type: "simple-line", color: "#fc8d59", width: 3 } },
    { minValue: 15, maxValue: 30, label: "15–30 mph", symbol: { type: "simple-line", color: "#fee08b", width: 3 } },
    { minValue: 30, maxValue: 50, label: "30–50 mph", symbol: { type: "simple-line", color: "#91cf60", width: 3 } },
    { minValue: 50, maxValue: 999, label: "50+ mph", symbol: { type: "simple-line", color: "#1a9850", width: 3 } }
  ]
};
segmentsLayer.popupTemplate = { title: "{commute_type} segment {segment_seq} — {speed_mph} mph", content: [{ type: "fields", fieldInfos: [
  { fieldName: "start_time", label: "Start" }, { fieldName: "end_time", label: "End" }, { fieldName: "distance_mi", label: "Distance (mi)" }, { fieldName: "match_method", label: "Match method" }
] }] };

const oauth = new OAuthInfo({ appId: appConfig.clientId, portalUrl: appConfig.portalUrl, popup: false, popupCallbackUrl: appConfig.redirectUrl });
esriId.registerOAuthInfos([oauth]);

function setStatus(message) { $("status").textContent = message; }
function setKpi(id, value) { $(id).textContent = value; }
function fmt(value, digits = 1) { return Number.isFinite(value) ? value.toFixed(digits) : "—"; }
function quote(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function dateLabel(value) { return value ? new Date(value).toLocaleDateString() : "—"; }

async function signIn() {
  try {
    sessionStorage.setItem("commuteOAuthReturnPath", "./dashboard.html");
    setStatus("Opening ArcGIS sign-in…");
    await esriId.getCredential(`${appConfig.portalUrl}/sharing`, { oAuthPopupConfirmation: false });
    await loadLayers();
  } catch (error) { setStatus(`Sign-in failed: ${error.message}`); }
}

async function loadLayers() {
  await Promise.all([commuteLayer.load(), segmentsLayer.load()]);
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
  commuteLayer.definitionExpression = where;
  segmentsLayer.definitionExpression = where;
  const totalMiles = trips.reduce((sum, feature) => sum + (Number(feature.attributes.distance_mi) || 0), 0);
  const totalMinutes = trips.reduce((sum, feature) => sum + (Number(feature.attributes.duration_min) || 0), 0);
  const delays = trips.map((feature) => Number(feature.attributes.delay_vs_estimate_min)).filter(Number.isFinite);
  setKpi("trip-count", String(trips.length));
  setKpi("avg-duration", trips.length ? `${fmt(totalMinutes / trips.length)} min` : "—");
  setKpi("avg-speed", totalMinutes ? `${fmt(totalMiles / totalMinutes * 60)} mph` : "—");
  setKpi("avg-delay", delays.length ? `${fmt(delays.reduce((a, b) => a + b, 0) / delays.length)} min` : "—");
  const segmentResult = ids.length ? await segmentsLayer.queryFeatures({ where, outFields: ["match_method"], returnGeometry: false }) : { features: [] };
  const snapped = segmentResult.features.filter((f) => f.attributes.match_method === "Road snapped").length;
  const direct = segmentResult.features.filter((f) => f.attributes.match_method === "GPS direct").length;
  $("segment-quality").textContent = `${snapped} road-snapped segment${snapped === 1 ? "" : "s"}; ${direct} GPS-direct fallback segment${direct === 1 ? "" : "s"}.`;
  $("trip-table").innerHTML = trips.slice(0, 12).map((feature) => { const a = feature.attributes; return `<tr><td>${dateLabel(a.trip_date)}</td><td>${a.commute_type || "—"}</td><td>${fmt(Number(a.duration_min))} min</td><td>${fmt(Number(a.google_estimate_min))} min</td><td>${fmt(Number(a.delay_vs_estimate_min))} min</td><td>${fmt(Number(a.distance_mi))} mi</td></tr>`; }).join("") || '<tr><td colspan="6">No trips match the selected filters.</td></tr>';
  if (trips.length) await view.goTo(trips, { padding: 50, duration: 400 });
  setStatus(`${trips.length} trip${trips.length === 1 ? "" : "s"} selected.`);
}

function resetFilters() {
  $("direction").value = ""; $("day").value = ""; $("min-duration").value = ""; $("max-duration").value = ""; $("date-range").value = "0";
  commuteLayer.definitionExpression = "1=1"; segmentsLayer.definitionExpression = "1=1";
  ["trip-count","avg-duration","avg-speed","avg-delay"].forEach((id) => setKpi(id, "—"));
  $("segment-quality").textContent = "Apply filters to see road-match quality.";
  $("trip-table").innerHTML = '<tr><td colspan="6">No data loaded.</td></tr>';
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
$("reset").addEventListener("click", resetFilters);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
restoreSession();
