import Map from "https://js.arcgis.com/4.30/@arcgis/core/Map.js";
import MapView from "https://js.arcgis.com/4.30/@arcgis/core/views/MapView.js";
import FeatureLayer from "https://js.arcgis.com/4.30/@arcgis/core/layers/FeatureLayer.js";
import GraphicsLayer from "https://js.arcgis.com/4.30/@arcgis/core/layers/GraphicsLayer.js";
import Graphic from "https://js.arcgis.com/4.30/@arcgis/core/Graphic.js";
import Polyline from "https://js.arcgis.com/4.30/@arcgis/core/geometry/Polyline.js";
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
    const a = Math.sin((lat2 - lat1) * radians / 2) ** 2 + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
    meters += 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return meters / 1609.344;
}
function refreshMetrics() {
  if (!trip) return;
  $("elapsed").textContent = `${Math.max(0, Math.round((Date.now() - trip.startedAt) / 60000))} min`;
  $("distance").textContent = `${miles(trip.points).toFixed(1)} mi`;
  $("samples").textContent = trip.points.length;
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
  const point = [position.coords.longitude, position.coords.latitude];
  const last = trip.points[trip.points.length - 1];
  if (last && Date.now() - trip.lastSampleAt < 9000) return;
  trip.points.push(point);
  trip.lastSampleAt = Date.now();
  redrawRoute(); refreshMetrics();
  if (trip.points.length === 1) view.goTo({ center: point, zoom: 15 });
}
function locationError(error) { setStatus(`Location update failed: ${error.message}. Keep the app open and location access enabled.`); }

async function signIn() {
  try {
    setStatus("Opening ArcGIS sign-in…");
    await esriId.getCredential(`${appConfig.portalUrl}/sharing`, { oAuthPopupConfirmation: false });
    await commuteLayer.load();
    signedIn = true;
    $("account-status").textContent = "Signed in to ArcGIS";
    startButton.disabled = false;
    setStatus("Ready to start a commute.");
  } catch (error) { setStatus(`Sign-in failed: ${error.message}`); }
}
function startCommute() {
  if (!signedIn || !navigator.geolocation) { setStatus("Location tracking is unavailable in this browser."); return; }
  const direction = $("direction").value;
  const estimate = Number($("estimate").value);
  trip = { id: crypto.randomUUID(), direction, estimate: Number.isFinite(estimate) && estimate > 0 ? estimate : null, startedAt: Date.now(), points: [], lastSampleAt: 0 };
  watchId = navigator.geolocation.watchPosition(recordPosition, locationError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  timerId = window.setInterval(refreshMetrics, 10000);
  startButton.disabled = true; endButton.disabled = false;
  $("direction").disabled = true; $("estimate").disabled = true;
  setStatus("Tracking active. Keep this PWA open during the drive.");
}
async function endCommute() {
  if (!trip) return;
  navigator.geolocation.clearWatch(watchId); window.clearInterval(timerId);
  endButton.disabled = true;
  if (trip.points.length < 2) { setStatus("Not enough GPS samples were captured; trip was not saved."); reset(); return; }
  const endedAt = Date.now(), duration = (endedAt - trip.startedAt) / 60000;
  const localDate = new Date(trip.startedAt); localDate.setHours(0, 0, 0, 0);
  const attributes = {
    trip_id: trip.id, commute_type: trip.direction,
    origin_label: trip.direction === "Morning" ? "Home" : "Work",
    destination_label: trip.direction === "Morning" ? "Work" : "Home",
    trip_date: localDate.getTime(), start_time: trip.startedAt, end_time: endedAt,
    duration_min: duration, distance_mi: miles(trip.points),
    google_estimate_min: trip.estimate,
    delay_vs_estimate_min: trip.estimate == null ? null : duration - trip.estimate,
    created_at: Date.now()
  };
  try {
    setStatus("Saving private commute to ArcGIS…");
    const result = await commuteLayer.applyEdits({ addFeatures: [new Graphic({ geometry: new Polyline({ paths: [trip.points], spatialReference: { wkid: 4326 } }), attributes })] });
    if (result.addFeatureResults?.[0]?.error) throw result.addFeatureResults[0].error;
    setStatus("Commute saved privately to your ArcGIS layer.");
    reset();
  } catch (error) {
    setStatus(`Save failed: ${error.message}. Check your connection and tap End Commute again to retry.`);
    endButton.disabled = false;
  }
}
function reset() { trip = null; routeLayer.removeAll(); startButton.disabled = !signedIn; endButton.disabled = true; $("direction").disabled = false; $("estimate").disabled = false; $("elapsed").textContent = "0 min"; $("distance").textContent = "0.0 mi"; $("samples").textContent = "0"; }
async function restoreSignedInSession() {
  try {
    const credential = await esriId.checkSignInStatus(
      `${appConfig.portalUrl}/sharing`
    );

    if (!credential) return;

    await commuteLayer.load();
    signedIn = true;
    $("account-status").textContent = "Signed in to ArcGIS";
    startButton.disabled = false;
    setStatus("Ready to start a commute.");
  } catch {
    // No saved ArcGIS session yet; the user can select Sign in to ArcGIS.
  }
}

restoreSignedInSession();
$("sign-in").addEventListener("click", signIn);
startButton.addEventListener("click", startCommute);
endButton.addEventListener("click", endCommute);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
