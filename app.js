"use strict";

/* ==========================================================================
   Mon Maps · Navigation Cockpit 3D, Multi-Itinéraires Interactifs & Guidage HD
   ========================================================================== */

var safeStorage = window.safeStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const MODES = {
  car:  { label: "Voiture", color: "#2563eb", glow: "rgba(37, 99, 235, 0.38)" },
  bike: { label: "Vélo",    color: "#059669", glow: "rgba(5, 150, 105, 0.38)" },
  foot: { label: "À pied",  color: "#ea580c", glow: "rgba(234, 88, 12, 0.38)" },
};

const $ = (id) => document.getElementById(id);

const state = {
  from: null,
  waypoints: [],
  to: null,
  mode: "car",
  criterion: safeStorage.getItem("mon_maps_criterion") || "fastest",
  routeCandidates: {},
  routeModes: {},
  activeRoute: null,
  userLocation: null,
  followOrientation: false,
  is3D: false,
  activeLayer: "openfreemap",
  currentSpeedKmh: 0,
  speedLimitKmh: 80,
  visualizeAlgo: safeStorage.getItem("mon_maps_vis_algo") === "true",
  useContraction: safeStorage.getItem("mon_maps_use_ch") !== "false",
  announceRoundabouts: safeStorage.getItem("mon_maps_roundabouts") !== "false",
  announceCarrefours: safeStorage.getItem("mon_maps_carrefours") !== "false",
};

const markers = {
  from: null,
  waypoints: {},
  to: null,
};

let waypointSeq = 0;
let runId = 0;
let orientationHandler = null;
let userLocationMarker = null;
let userHeading = null;
let userGeoWatchId = null;

/* ---------- Utilitaires de Formatage & Géométrie ---------- */
function fmtDuration(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function hav(a, b) {
  if (window.ClientRouter?.haversineMeters) {
    return window.ClientRouter.haversineMeters(a, b);
  }
  const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

function calcBearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
  const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) -
            Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

const say = (text) => {
  const el = $("status");
  if (el) el.textContent = text;
};

/* ---------- Historique & Favoris Locaux (Maison / Travail) ---------- */
function getSearchHistory() {
  try {
    return JSON.parse(safeStorage.getItem("mon_maps_history") || "[]");
  } catch {
    return [];
  }
}

function addSearchHistory(pt) {
  if (!pt || !pt.label || pt.label === "Ma position actuelle" || pt.label === "Position GPS") return;
  const list = getSearchHistory().filter((item) => item.label !== pt.label);
  list.unshift({ lng: pt.lng, lat: pt.lat, label: pt.label, ts: Date.now() });
  safeStorage.setItem("mon_maps_history", JSON.stringify(list.slice(0, 8)));
}

function getFavorite(key) {
  try {
    const raw = safeStorage.getItem(`mon_maps_fav_${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveFavorite(key, pt) {
  safeStorage.setItem(`mon_maps_fav_${key}`, JSON.stringify(pt));
}

/* ---------- Helper d'application de style fiable & persistance du tracé ---------- */
function checkAndRestoreRouteLayers() {
  if (!map || !map.isStyleLoaded()) return;
  if (!map.getSource("route")) {
    setupRouteLayers();
  }
  if (state.is3D || MAP_STYLES[state.activeLayer]?.is3D) {
    ensure3DBuildings();
  }
}

function applyMapStyle(newStyle) {
  if (!map) return;
  map.setStyle(newStyle);

  if (map.isStyleLoaded()) {
    checkAndRestoreRouteLayers();
  }
  setTimeout(checkAndRestoreRouteLayers, 50);
  setTimeout(checkAndRestoreRouteLayers, 200);
  setTimeout(checkAndRestoreRouteLayers, 500);
}

/* ---------- Thème (Clair / Sombre) ---------- */
function toggleTheme() {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const nextTheme = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  safeStorage.setItem("maps-theme", nextTheme);

  const conf = MAP_STYLES[state.activeLayer] || MAP_STYLES["openfreemap"];
  if (conf.type === "vector") {
    const isDark = nextTheme === "dark";
    const nextUrl = isDark ? (conf.darkUrl || conf.url) : (conf.lightUrl || conf.url);
    if (nextUrl) {
      applyMapStyle(nextUrl);
    }
  } else if (conf.type === "raster-composite") {
    if (state.activeLayer !== "sat-hybrid") {
      $("map")?.classList.toggle("map-dark-theme", nextTheme === "dark");
    }
  }
}

function initTheme() {
  const getPreferredTheme = () => {
    const saved = safeStorage.getItem("maps-theme");
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    safeStorage.setItem("maps-theme", theme);
  };

  applyTheme(getPreferredTheme());
  $("theme-toggle")?.addEventListener("click", toggleTheme);
  $("theme-toggle-quick-btn")?.addEventListener("click", toggleTheme);
}
initTheme();

/* ---------- Styles Cartographiques ---------- */
const MAP_STYLES = {
  "openfreemap": {
    label: "OpenFreeMap",
    type: "vector",
    lightUrl: "https://tiles.openfreemap.org/styles/bright",
    darkUrl: "https://tiles.openfreemap.org/styles/dark",
    is3D: false,
  },
  "openfreemap-3d": {
    label: "OpenFreeMap 3D",
    type: "vector",
    lightUrl: "https://tiles.openfreemap.org/styles/liberty",
    darkUrl: "https://tiles.openfreemap.org/styles/dark",
    is3D: true,
  },
  "sat-hybrid": {
    type: "raster-composite",
    layers: ["sat", "sat-roads", "sat-places"],
    is3D: false,
  },
  cyclosm: {
    type: "raster-composite",
    layers: ["cyclosm"],
    is3D: false,
  },
  topo: {
    type: "raster-composite",
    layers: ["topo"],
    is3D: false,
  },
  osm: {
    type: "raster-composite",
    layers: ["osm"],
    is3D: false,
  },
};

const initialLayer = (() => {
  let saved = safeStorage.getItem("maps-layer");
  if (saved === "ofm-bright" || saved === "ofm-dark") saved = "openfreemap";
  if (saved === "ofm-3d") saved = "openfreemap-3d";
  if (saved && MAP_STYLES[saved]) return saved;
  return "openfreemap";
})();

const initialIsDark = (() => {
  const saved = safeStorage.getItem("maps-theme");
  if (saved) return saved === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
})();

const map = new maplibregl.Map({
  container: "map",
  style: initialIsDark
    ? (MAP_STYLES[initialLayer].darkUrl || "https://tiles.openfreemap.org/styles/dark")
    : (MAP_STYLES[initialLayer].lightUrl || "https://tiles.openfreemap.org/styles/bright"),
  center: [4.35, 50.84], // Centré sur Bruxelles / Europe de l'Ouest par défaut
  zoom: 7,
  maxPitch: 75,
});
window.map = map;
window.state = state;

function ensureRouteArrowImage() {
  if (!map || map.hasImage("route-arrow")) return;
  try {
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(6, 17);
      ctx.lineTo(12, 6);
      ctx.lineTo(18, 17);
      ctx.lineTo(12, 14);
      ctx.closePath();
      ctx.fill();
      map.addImage("route-arrow", ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
    }
  } catch (err) {
    console.warn("Could not register route-arrow sprite:", err);
  }
}

// Génération dynamique des sprites manquants + flèche directionnelle de route
map.on("styleimagemissing", (e) => {
  const id = e.id;
  if (map.hasImage(id)) return;

  if (id === "route-arrow") {
    ensureRouteArrowImage();
    return;
  }

  const size = id.startsWith("circle-") ? parseInt(id.split("-")[1], 10) || 12 : 16;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    if (id.startsWith("circle")) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, Math.max(1, size / 2 - 1.5), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(100, 116, 139, 0.75)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }
  map.addImage(id, ctx.getImageData(0, 0, size, size), { pixelRatio: 1 });
});

/* ---------- Couches de Rendu Multi-Itinéraires, Halo & Progression ---------- */
function setupRouteLayers() {
  const emptyFC = { type: "FeatureCollection", features: [] };
  const layout = { "line-cap": "round", "line-join": "round" };

  // 1. Itinéraires alternatifs cliquables (affichés sous la route principale)
  if (!map.getSource("route-alt")) {
    map.addSource("route-alt", { type: "geojson", data: emptyFC });
  }
  if (!map.getLayer("route-alt-casing")) {
    map.addLayer({
      id: "route-alt-casing",
      type: "line",
      source: "route-alt",
      layout,
      paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.65 },
    });
  }
  if (!map.getLayer("route-alt-line")) {
    map.addLayer({
      id: "route-alt-line",
      type: "line",
      source: "route-alt",
      layout,
      paint: {
        "line-color": "#64748b",
        "line-width": 5,
        "line-opacity": 0.72,
        "line-dasharray": [1.5, 1.2],
      },
    });
  }

  // 2. Portion déjà parcourue (gris discret derrière le véhicule en conduite)
  if (!map.getSource("route-passed")) {
    map.addSource("route-passed", { type: "geojson", data: emptyFC });
  }
  if (!map.getLayer("route-passed-line")) {
    map.addLayer({
      id: "route-passed-line",
      type: "line",
      source: "route-passed",
      layout,
      paint: { "line-color": "#94a3b8", "line-width": 6, "line-opacity": 0.55 },
    });
  }

  // 3. Route active principale (Halo + Casing + Tracé + Flèches de flux)
  if (!map.getSource("route")) {
    map.addSource("route", { type: "geojson", data: emptyFC });
  }
  if (!map.getLayer("route-glow")) {
    map.addLayer({
      id: "route-glow",
      type: "line",
      source: "route",
      layout,
      paint: { "line-color": ["coalesce", ["get", "color"], "#2563eb"], "line-width": 16, "line-opacity": 0.24, "line-blur": 6 },
    });
  }
  if (!map.getLayer("route-casing")) {
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: "route",
      layout,
      paint: { "line-color": "#ffffff", "line-width": 9.5, "line-opacity": 0.95 },
    });
  }
  if (!map.getLayer("route-line")) {
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout,
      paint: { "line-color": ["coalesce", ["get", "color"], "#2563eb"], "line-width": 6.5 },
    });
  }
  ensureRouteArrowImage();
  if (!map.getLayer("route-arrows")) {
    try {
      map.addLayer({
        id: "route-arrows",
        type: "symbol",
        source: "route",
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 95,
          "icon-image": "route-arrow",
          "icon-size": 0.85,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    } catch (err) {
      console.warn("Could not add route-arrows layer:", err);
    }
  }

  // 4. Visualisation en direct de l'algorithme A*
  if (!map.getSource("algo-explored")) {
    map.addSource("algo-explored", { type: "geojson", data: emptyFC });
  }
  if (!map.getLayer("algo-explored-lines")) {
    map.addLayer({
      id: "algo-explored-lines",
      type: "line",
      source: "algo-explored",
      layout,
      paint: { "line-color": "#f59e0b", "line-width": 3.5, "line-opacity": 0.82 },
    });
  }

  if (!map.getSource("algo-frontier")) {
    map.addSource("algo-frontier", { type: "geojson", data: emptyFC });
  }
  if (!map.getLayer("algo-frontier-pts")) {
    map.addLayer({
      id: "algo-frontier-pts",
      type: "circle",
      source: "algo-frontier",
      paint: {
        "circle-radius": 4.5,
        "circle-color": "#06b6d4",
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffffff",
      },
    });
  }

  const r = state.activeRoute || state.routeCandidates?.[state.criterion] || state.routeCandidates?.fastest;
  if (r) {
    if (nav.on && nav.lastPos && nav.geom) {
      const snapped = snap(nav.lastPos);
      if (snapped) updateLiveRouteSplit(snapped);
      else showCurrentRoute(false);
    } else {
      showCurrentRoute(false);
    }
  }
}

// Sélection d'un itinéraire alternatif en cliquant directement sur son tracé sur la carte
map.on("click", "route-alt-line", (e) => {
  const crit = e.features?.[0]?.properties?.criterion;
  if (crit && state.routeCandidates[crit]) {
    e.preventDefault();
    state.criterion = crit;
    state.activeRoute = state.routeCandidates[crit];
    updateCriteriaUI();
    showCurrentRoute(false);
    renderComparisonTable(state.routeCandidates, state.routeModes);
  }
});
map.on("mouseenter", "route-alt-line", () => { map.getCanvas().style.cursor = "pointer"; });
map.on("mouseleave", "route-alt-line", () => { map.getCanvas().style.cursor = ""; });

function ensure3DBuildings() {
  if (!map.getSource("openmaptiles")) return;
  if (map.getLayer("building-3d") || map.getLayer("3d-buildings-extrusion")) return;

  const isDark = document.documentElement.dataset.theme === "dark";
  const layers = map.getStyle()?.layers || [];
  let firstSymbolId;
  for (const l of layers) {
    if (l.type === "symbol" && l.layout && l.layout["text-field"]) {
      firstSymbolId = l.id;
      break;
    }
  }

  try {
    map.addLayer(
      {
        id: "3d-buildings-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        type: "fill-extrusion",
        minzoom: 14,
        paint: {
          "fill-extrusion-color": isDark ? "#1e293b" : "#e2e8f0",
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 14],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.84,
        },
      },
      firstSymbolId
    );
  } catch {}
}

map.on("load", () => {
  setupRouteLayers();
  if (initialLayer !== "openfreemap") {
    switchBaseLayer(initialLayer);
  } else {
    state.activeLayer = initialLayer;
    highlightActiveLayer(initialLayer);
  }
  if (MAP_STYLES[initialLayer]?.is3D) {
    enable3DView(true);
  }
});

map.on("style.load", checkAndRestoreRouteLayers);
map.on("styledata", checkAndRestoreRouteLayers);
map.on("idle", checkAndRestoreRouteLayers);

/* ---------- Changement de Style Cartographique ---------- */
function switchBaseLayer(layerId) {
  if (layerId === "ofm-bright" || layerId === "ofm-dark") layerId = "openfreemap";
  if (layerId === "ofm-3d") layerId = "openfreemap-3d";

  const conf = MAP_STYLES[layerId] || MAP_STYLES["openfreemap"];
  state.activeLayer = layerId;
  const isDark = document.documentElement.dataset.theme === "dark";

  if (conf.type === "vector") {
    const url = isDark ? (conf.darkUrl || conf.url) : (conf.lightUrl || conf.url);
    applyMapStyle(url);
    if (conf.is3D || state.is3D) {
      setTimeout(() => enable3DView(true), 400);
    } else if (!nav.on) {
      map.easeTo({ pitch: 0, duration: 600 });
    }
    $("map")?.classList.remove("map-dark-theme");
  } else if (conf.type === "raster-composite") {
    const baseRasterUrl = conf.layers.includes("osm")
      ? "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      : conf.layers.includes("cyclosm")
      ? "https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png"
      : conf.layers.includes("topo")
      ? "https://a.tile.opentopomap.org/{z}/{x}/{y}.png"
      : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

    const rasterStyle = {
      version: 8,
      sources: {
        rasterBase: { type: "raster", tiles: [baseRasterUrl], tileSize: 256, maxzoom: 19 },
      },
      layers: [{ id: "rasterBase", type: "raster", source: "rasterBase" }],
    };

    if (layerId === "sat-hybrid") {
      rasterStyle.sources.satRoads = {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
      };
      rasterStyle.sources.satPlaces = {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
      };
      rasterStyle.layers.push({ id: "satRoads", type: "raster", source: "satRoads" });
      rasterStyle.layers.push({ id: "satPlaces", type: "raster", source: "satPlaces" });
      $("map")?.classList.remove("map-dark-theme");
    } else {
      $("map")?.classList.toggle("map-dark-theme", isDark);
    }

    applyMapStyle(rasterStyle);
    if (state.is3D) {
      setTimeout(() => enable3DView(true), 400);
    }
  }

  highlightActiveLayer(layerId);
  safeStorage.setItem("maps-layer", layerId);
}

function highlightActiveLayer(layerId) {
  document.querySelectorAll(".layer-card").forEach((card) => {
    card.classList.toggle("is-active", card.dataset.layerId === layerId);
  });
  $("layers")?.setAttribute("aria-pressed", String(layerId !== "openfreemap"));
}

function enable3DView(enable) {
  state.is3D = enable;
  const btn = $("toggle-3d-btn");
  if (btn) btn.classList.toggle("is-active", enable);

  if (enable) {
    ensure3DBuildings();
    const currentZoom = map.getZoom();
    const hasRoute = Boolean(state.activeRoute || state.routeCandidates?.[state.criterion] || state.routeCandidates?.fastest);
    const targetZoom = (hasRoute || nav.on) ? currentZoom : Math.max(currentZoom, 15);
    map.easeTo({
      pitch: 58,
      zoom: targetZoom,
      bearing: map.getBearing() || -12,
      duration: 800,
    });
  } else {
    map.easeTo({ pitch: 0, duration: 600 });
  }
}

$("toggle-3d-btn")?.addEventListener("click", () => {
  enable3DView(!state.is3D);
});

const layersModal = $("layers-modal");
$("layers")?.addEventListener("click", () => {
  if (layersModal.hasAttribute("open")) layersModal.removeAttribute("open");
  else layersModal.setAttribute("open", "");
});
$("close-layers")?.addEventListener("click", () => layersModal.removeAttribute("open"));

document.querySelectorAll(".layer-card").forEach((card) => {
  card.addEventListener("click", () => {
    switchBaseLayer(card.dataset.layerId);
    layersModal.removeAttribute("open");
  });
});

$("zoom-in-btn")?.addEventListener("click", () => map.zoomIn({ duration: 280 }));
$("zoom-out-btn")?.addEventListener("click", () => map.zoomOut({ duration: 280 }));

/* ---------- Boussole ---------- */
const compassNeedle = $("compass-needle");
function updateCompassUI() {
  const bearing = map.getBearing();
  if (compassNeedle) compassNeedle.style.transform = `rotate(${-bearing}deg)`;
}
map.on("rotate", updateCompassUI);
map.on("move", updateCompassUI);

$("compass-btn")?.addEventListener("click", () => {
  const currentBearing = Math.round(map.getBearing());
  if (Math.abs(currentBearing) > 2) {
    map.easeTo({ bearing: 0, pitch: state.is3D ? 58 : 0, duration: 550 });
  } else {
    enable3DView(!state.is3D);
  }
});

/* ---------- Icônes SVG de Manœuvre & Assistant de Voies ---------- */
function getManeuverSvg(step) {
  const m = step?.maneuver || {};
  const t = m.type || "";
  const mod = m.modifier || "";

  if (t === "depart") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;
  }
  if (t === "arrive") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;
  }
  if (t === "roundabout" || t === "rotary") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="17 4 21 4 21 8"/></svg>`;
  }
  if (mod === "slight left") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 19v-7l-8-8"/><polyline points="15 4 9 4 9 10"/></svg>`;
  }
  if (mod === "slight right") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 19v-7l8-8"/><polyline points="9 4 15 4 15 10"/></svg>`;
  }
  if (mod.includes("left")) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 19V9a4 4 0 0 0-4-4H6"/><polyline points="10 9 6 5 10 1"/></svg>`;
  }
  if (mod.includes("right")) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 19V9a4 4 0 0 1 4-4h8"/><polyline points="14 9 18 5 14 1"/></svg>`;
  }
  if (mod === "uturn") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a6 6 0 0 1-6 6H4"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
}

/** Génère l'indicateur visuel de voies (Lane Guidance) selon la manœuvre à venir */
function updateLaneGuidanceUI(nextStep, distToTurn) {
  const bar = $("banner-lanes");
  if (!bar) return;

  if (!state.announceCarrefours || !nextStep || distToTurn > 650 || state.mode !== "car") {
    bar.hidden = true;
    return;
  }

  const m = nextStep.maneuver || {};
  const mod = m.modifier || "";
  const type = m.type || "";

  if (type === "arrive" || type === "depart") {
    bar.hidden = true;
    return;
  }

  const arrowStraight = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="7 10 12 5 17 10"/></svg>`;
  const arrowLeft = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 19V9H7"/><polyline points="11 5 7 9 11 13"/></svg>`;
  const arrowRight = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M8 19V9h9"/><polyline points="13 5 17 9 13 13"/></svg>`;

  let lanes = [];
  if (mod.includes("left")) {
    lanes = [
      { svg: arrowLeft, active: true },
      { svg: arrowStraight, active: false },
      { svg: arrowStraight, active: false },
    ];
  } else if (mod.includes("right") || type === "off ramp" || type === "on ramp") {
    lanes = [
      { svg: arrowStraight, active: false },
      { svg: arrowStraight, active: false },
      { svg: arrowRight, active: true },
    ];
  } else if (type === "roundabout") {
    const isLeftExit = m.modifier && (m.modifier.includes("3") || m.modifier.includes("4"));
    lanes = [
      { svg: isLeftExit ? arrowLeft : arrowStraight, active: isLeftExit },
      { svg: arrowRight, active: !isLeftExit },
    ];
  } else {
    bar.hidden = true;
    return;
  }

  bar.innerHTML = lanes
    .map((l) => `<div class="lane-box ${l.active ? "is-recommended" : ""}">${l.svg}</div>`)
    .join("");
  bar.hidden = false;
}

/** Extrait un cartouche de route officiel (E411, A1, R0, N4...) s'il est présent */
function extractRoadShield(step) {
  const raw = `${step?.ref || ""} ${step?.name || ""}`.trim();
  const match = raw.match(/\b([EARN]\s?\d{1,3})\b/i);
  if (!match) return null;
  const code = match[1].toUpperCase().replace(/\s+/g, "");
  let cls = "shield-a";
  if (code.startsWith("E")) cls = "shield-e";
  else if (code.startsWith("N")) cls = "shield-n";
  return { code, cls };
}

/* ---------- Géocodage Ultra-Rapide + Historique ---------- */
const geocodeCache = new Map();
const MAX_GEOCODE_CACHE = 150;

function parsePhotonProps(p) {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const main = p.name || street || p.city || "Adresse";
  const sub = [...new Set([street !== main ? street : null, p.postcode, p.city, p.state, p.country].filter(Boolean))].join(", ");
  const full = [...new Set([main, sub].filter(Boolean))].join(", ");
  return { main, sub, full };
}

function getProximityRefPoint() {
  if (state.userLocation) return state.userLocation;
  if (state.from) return state.from;
  const c = map.getCenter();
  return { lng: c.lng, lat: c.lat };
}

async function queryGeocode(query, ref, signal) {
  const qClean = query.trim();
  if (qClean.length < 2) return [];

  const cacheKey = `${qClean.toLowerCase()}|${ref.lng.toFixed(2)}|${ref.lat.toFixed(2)}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

  const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(qClean)}&limit=9&lang=fr&lat=${ref.lat}&lon=${ref.lng}`;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), 2000);

  let items = null;
  try {
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutCtrl.signal]) : timeoutCtrl.signal;
    const res = await fetch(photonUrl, { signal: combinedSignal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      items = (data.features || []).map((f) => {
        const { main, sub, full } = parsePhotonProps(f.properties || {});
        const coords = f.geometry.coordinates;
        return { coords, main, sub, full, dist: hav([ref.lng, ref.lat], coords) };
      }).sort((a, b) => a.dist - b.dist);
    }
  } catch (err) {
    clearTimeout(timer);
    if (signal?.aborted) throw err;
  }

  if (!items || !items.length) {
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(qClean)}&format=geojson&addressdetails=1&limit=7&accept-language=fr`;
      const res = await fetch(nomUrl, { signal });
      if (res.ok) {
        const data = await res.json();
        items = (data.features || []).map((f) => {
          const p = f.properties || {};
          const addr = p.address || {};
          const street = [addr.house_number, addr.road || addr.pedestrian || addr.street].filter(Boolean).join(" ");
          const main = p.name || street || addr.city || addr.town || addr.village || "Lieu";
          const sub = [...new Set([street !== main ? street : null, addr.postcode, addr.city || addr.town || addr.village, addr.country].filter(Boolean))].join(", ");
          const full = p.display_name || [...new Set([main, sub].filter(Boolean))].join(", ");
          const coords = f.geometry.coordinates;
          return { coords, main, sub, full, dist: hav([ref.lng, ref.lat], coords) };
        }).sort((a, b) => a.dist - b.dist);
      }
    } catch (nomErr) {
      if (signal?.aborted) throw nomErr;
    }
  }

  const results = items || [];
  if (results.length) {
    if (geocodeCache.size >= MAX_GEOCODE_CACHE) {
      geocodeCache.delete(geocodeCache.keys().next().value);
    }
    geocodeCache.set(cacheKey, results);
  }
  return results;
}

async function reverse(type, pt, waypointId) {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lon=${pt.lng}&lat=${pt.lat}&lang=fr`);
    const f = (await r.json()).features?.[0];
    if (!f) return;
    const parsed = parsePhotonProps(f.properties);
    pt.label = parsed.full || pt.label;

    if (type === "from" && state.from === pt) {
      $("from").value = pt.label;
      updateClearButton("from");
    } else if (type === "to" && state.to === pt) {
      $("to").value = pt.label;
      updateClearButton("to");
    } else if (type === "waypoint") {
      const input = document.querySelector(`.waypoint-field[data-waypoint-id="${waypointId}"] input`);
      if (input) input.value = pt.label;
    }
  } catch {}
}

function renderSuggestItems(items, list, onSelect, isHistory = false) {
  list.replaceChildren();
  for (const item of items) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="suggest-item-icon ${isHistory ? "history-icon" : ""}" aria-hidden="true">
        ${isHistory
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>`
        }
      </div>
      <div class="suggest-item-text">
        <span class="suggest-item-main">${item.main}</span>
        ${item.sub ? `<span class="suggest-item-sub">${item.sub}</span>` : ""}
      </div>
      ${item.dist != null ? `<span class="suggest-dist">${fmtDistance(item.dist)}</span>` : ""}
    `;
    const selectItem = (e) => {
      e.preventDefault();
      e.stopPropagation();
      list.hidden = true;
      const chosen = { lng: item.coords[0], lat: item.coords[1], label: item.full };
      addSearchHistory(chosen);
      onSelect(chosen);
    };
    li.addEventListener("pointerdown", selectItem);
    li.addEventListener("click", selectItem);
    list.append(li);
  }
  list.hidden = !items.length;
}

function attachSuggest(input, list, onSelect) {
  if (!input || !list) return;
  let timer, seq = 0;
  let activeAbortCtrl = null;

  const showRecentIfEmpty = () => {
    if (input.value.trim().length >= 2) return;
    const hist = getSearchHistory();
    if (!hist.length) return;
    const ref = getProximityRefPoint();
    const mapped = hist.map((h) => ({
      coords: [h.lng, h.lat],
      main: h.label.split(",")[0],
      sub: h.label.split(",").slice(1).join(",").trim(),
      full: h.label,
      dist: hav([ref.lng, ref.lat], [h.lng, h.lat]),
    }));
    renderSuggestItems(mapped, list, onSelect, true);
  };

  input.addEventListener("focus", showRecentIfEmpty);

  input.addEventListener("input", () => {
    clearTimeout(timer);
    if (activeAbortCtrl) {
      activeAbortCtrl.abort();
      activeAbortCtrl = null;
    }

    const q = input.value.trim();
    if (q.length < 2) {
      showRecentIfEmpty();
      return;
    }

    const ref = getProximityRefPoint();
    const cacheKey = `${q.toLowerCase()}|${ref.lng.toFixed(2)}|${ref.lat.toFixed(2)}`;
    if (geocodeCache.has(cacheKey)) {
      renderSuggestItems(geocodeCache.get(cacheKey), list, onSelect);
      return;
    }

    timer = setTimeout(async () => {
      const id = ++seq;
      activeAbortCtrl = new AbortController();
      try {
        const items = await queryGeocode(q, ref, activeAbortCtrl.signal);
        if (id !== seq) return;
        renderSuggestItems(items, list, onSelect);
      } catch (err) {
        if (err.name !== "AbortError") list.hidden = true;
      } finally {
        activeAbortCtrl = null;
      }
    }, 160);
  });

  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 190));
}

/* ---------- Barre de Recherche Rapide & Favoris (Maison / Travail) ---------- */
const quickInput = $("quick-search-input");
const quickList = $("quick-search-list");
const quickClear = $("quick-clear-btn");

quickInput?.addEventListener("input", () => {
  if (quickClear) quickClear.hidden = !quickInput.value.trim();
});

quickClear?.addEventListener("click", () => {
  quickInput.value = "";
  quickClear.hidden = true;
  quickList.hidden = true;
});

attachSuggest(quickInput, quickList, (pt) => {
  quickInput.value = pt.label;
  if (quickClear) quickClear.hidden = false;
  map.flyTo({ center: [pt.lng, pt.lat], zoom: 15, duration: 750 });
  if (!state.from && state.userLocation) {
    setPoint("from", { lng: state.userLocation.lng, lat: state.userLocation.lat, label: "Ma position actuelle" });
  }
  setPoint("to", pt);
  openRoutePanel();
});

function handleFavoriteChip(key, labelName) {
  const fav = getFavorite(key);
  if (fav) {
    if (!state.from && state.userLocation) {
      setPoint("from", { lng: state.userLocation.lng, lat: state.userLocation.lat, label: "Ma position actuelle" });
    }
    setPoint("to", fav);
    openRoutePanel();
  } else if (state.to) {
    saveFavorite(key, state.to);
    say(`${labelName} enregistré sur « ${state.to.label.split(",")[0]} ».`);
  } else {
    openRoutePanel();
    $("to")?.focus();
    say(`Choisissez une destination pour l'enregistrer comme ${labelName}.`);
  }
}

$("fav-home-chip")?.addEventListener("click", () => handleFavoriteChip("home", "Maison"));
$("fav-home-chip")?.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  safeStorage.removeItem("mon_maps_fav_home");
  say("Favori Maison réinitialisé.");
});

$("fav-work-chip")?.addEventListener("click", () => handleFavoriteChip("work", "Travail"));
$("fav-work-chip")?.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  safeStorage.removeItem("mon_maps_fav_work");
  say("Favori Travail réinitialisé.");
});

document.querySelectorAll(".category-chip[data-query]").forEach((chip) => {
  chip.addEventListener("click", async () => {
    const q = chip.dataset.query;
    quickInput.value = chip.textContent.trim();
    if (quickClear) quickClear.hidden = false;
    const ref = getProximityRefPoint();
    try {
      const items = await queryGeocode(q, ref);
      renderSuggestItems(items, quickList, (pt) => {
        quickInput.value = pt.label;
        map.flyTo({ center: [pt.lng, pt.lat], zoom: 15.5, duration: 750 });
        setPoint("to", pt);
        openRoutePanel();
      });
    } catch {}
  });
});

attachSuggest($("from"), $("from-list"), (pt) => setPoint("from", pt));
attachSuggest($("to"), $("to-list"), (pt) => setPoint("to", pt));

/* ---------- Effacement & Marqueurs ---------- */
function updateClearButton(key) {
  const btn = $(`clear-${key}`);
  if (btn) btn.hidden = !$(key).value.trim();
}

$("from")?.addEventListener("input", () => updateClearButton("from"));
$("to")?.addEventListener("input", () => updateClearButton("to"));

function clearPoint(key) {
  state[key] = null;
  $(key).value = "";
  updateClearButton(key);
  markers[key]?.remove();
  markers[key] = null;
  $(`${key}-list`).hidden = true;
  const empty = { type: "FeatureCollection", features: [] };
  map.getSource("route")?.setData(empty);
  map.getSource("route-alt")?.setData(empty);
  map.getSource("route-passed")?.setData(empty);
  $("route-box").hidden = true;
  $("criteria-selector").hidden = true;
  $("minimized-route-bar").hidden = true;
  for (const b of document.querySelectorAll("#modes button small")) b.textContent = "–";
  say("Point effacé.");
}

$("clear-from")?.addEventListener("click", () => clearPoint("from"));
$("clear-to")?.addEventListener("click", () => clearPoint("to"));

function createCustomMarker(type, num) {
  const el = document.createElement("div");
  el.className = `custom-marker marker-${type}`;
  const color = type === "from" ? "#10b981" : type === "to" ? "#f43f5e" : "#8b5cf6";
  const innerContent = num != null
    ? `<circle cx="15" cy="15" r="8.5" fill="#ffffff"/><text x="15" y="19" text-anchor="middle" fill="${color}" font-size="12" font-weight="900" font-family="Figtree, system-ui, sans-serif">${num}</text>`
    : `<circle cx="15" cy="15" r="5.5" fill="#ffffff"/>`;

  el.innerHTML = `
    <svg width="30" height="40" viewBox="0 0 30 40" fill="none" style="display:block; overflow:visible;">
      <path d="M15 0 C6.716 0 0 6.716 0 15 C0 26.5 15 40 15 40 C15 40 30 26.5 30 15 C30 6.716 23.284 0 15 0 Z" fill="${color}" stroke="#ffffff" stroke-width="2"/>
      ${innerContent}
    </svg>
  `;
  return el;
}

function setPoint(key, pt) {
  state[key] = pt;
  $(key).value = pt.label;
  updateClearButton(key);

  markers[key]?.remove();
  const markerEl = createCustomMarker(key);
  markers[key] = new maplibregl.Marker({ element: markerEl, anchor: "bottom" })
    .setLngLat([pt.lng, pt.lat])
    .addTo(map);

  checkAndCompute();
}

/* ---------- Multi-Étapes ---------- */
function addWaypoint(coords = null) {
  const wpId = `wp-${++waypointSeq}`;
  const wpObj = { id: wpId, pt: coords };
  state.waypoints.push(wpObj);

  const container = $("waypoints-container");
  const field = document.createElement("div");
  field.className = "field waypoint-field";
  field.dataset.waypointId = wpId;

  const idx = state.waypoints.length;
  field.innerHTML = `
    <div class="input-wrapper">
      <input placeholder="Étape ${idx}…" autocomplete="off" aria-label="Étape ${idx}">
      <button class="clear-btn" type="button" aria-label="Effacer" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <button class="field-action-btn remove-waypoint-btn" type="button" title="Supprimer cette étape" aria-label="Supprimer cette étape">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
    <ul class="suggest" hidden></ul>
  `;

  container.append(field);

  const input = field.querySelector("input");
  const clearBtn = field.querySelector(".clear-btn");
  const removeBtn = field.querySelector(".remove-waypoint-btn");
  const suggestList = field.querySelector(".suggest");

  if (coords) {
    input.value = coords.label;
    clearBtn.hidden = false;
    updateWaypointMarker(wpId, coords, idx);
    reverse("waypoint", coords, wpId);
  }

  input.addEventListener("input", () => {
    clearBtn.hidden = !input.value.trim();
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    wpObj.pt = null;
    markers.waypoints[wpId]?.remove();
    delete markers.waypoints[wpId];
    checkAndCompute();
  });

  removeBtn.addEventListener("click", () => {
    field.remove();
    markers.waypoints[wpId]?.remove();
    delete markers.waypoints[wpId];
    state.waypoints = state.waypoints.filter((w) => w.id !== wpId);
    renumberWaypoints();
    checkAndCompute();
  });

  attachSuggest(input, suggestList, (pt) => {
    input.value = pt.label;
    clearBtn.hidden = false;
    wpObj.pt = pt;
    updateWaypointMarker(wpId, pt, state.waypoints.indexOf(wpObj) + 1);
    checkAndCompute();
  });

  updateTimelineConnector();
  if (coords) checkAndCompute();
}

function updateWaypointMarker(wpId, pt, num) {
  markers.waypoints[wpId]?.remove();
  const markerEl = createCustomMarker("waypoint", num);
  markers.waypoints[wpId] = new maplibregl.Marker({ element: markerEl, anchor: "bottom" })
    .setLngLat([pt.lng, pt.lat])
    .addTo(map);
}

function renumberWaypoints() {
  state.waypoints.forEach((w, i) => {
    const num = i + 1;
    const input = document.querySelector(`.waypoint-field[data-waypoint-id="${w.id}"] input`);
    if (input) input.placeholder = `Étape ${num}…`;
    if (w.pt) updateWaypointMarker(w.id, w.pt, num);
  });
  updateTimelineConnector();
}

function updateTimelineConnector() {
  const line = $("timeline-connector-body");
  const count = state.waypoints.length;
  if (line) line.style.minHeight = `${20 + count * 46}px`;
}

$("add-waypoint-btn")?.addEventListener("click", () => addWaypoint());

/* Clic sur la carte pour poser Départ / Destination / Étapes */
map.on("click", (e) => {
  if (nav.on) return;
  const hitAlt = map.queryRenderedFeatures(e.point, { layers: ["route-alt-line"] });
  if (hitAlt && hitAlt.length > 0) return;

  const coords = { lng: e.lngLat.lng, lat: e.lngLat.lat, label: `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}` };
  if (!state.from) {
    setPoint("from", coords);
    reverse("from", coords);
    openRoutePanel();
  } else if (!state.to) {
    setPoint("to", coords);
    reverse("to", coords);
    openRoutePanel();
  } else {
    addWaypoint(coords);
    openRoutePanel();
  }
});

/* ---------- Géolocalisation & Marqueur Véhicule ---------- */
function updateUserLocation(coords, heading = null) {
  if (!coords || typeof coords.lng !== "number" || typeof coords.lat !== "number") return;
  state.userLocation = { lng: coords.lng, lat: coords.lat };

  if (heading != null && !isNaN(heading)) {
    userHeading = heading;
  }

  if (!userLocationMarker) {
    const el = document.createElement("div");
    el.className = "user-location-marker";
    el.innerHTML = `
      <div class="user-heading-cone" id="user-heading-cone">
        <svg viewBox="0 0 64 64">
          <defs>
            <linearGradient id="user-cone-grad" x1="50%" y1="100%" x2="50%" y2="0%">
              <stop offset="0%" stop-color="#2563eb" stop-opacity="0.55"/>
              <stop offset="100%" stop-color="#2563eb" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <path d="M32 32 L10 0 A36 36 0 0 1 54 0 Z" fill="url(#user-cone-grad)"/>
        </svg>
      </div>
      <div class="user-pulse-ring"></div>
      <div class="user-dot"></div>
    `;
    userLocationMarker = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([coords.lng, coords.lat])
      .addTo(map);
  } else {
    userLocationMarker.setLngLat([coords.lng, coords.lat]);
  }

  const cone = document.getElementById("user-heading-cone");
  if (cone && userHeading != null) {
    cone.style.display = "block";
    cone.style.transform = `rotate(${userHeading - map.getBearing()}deg)`;
  }
}

function startLiveUserTracking() {
  if (userGeoWatchId !== null || !navigator.geolocation) return;
  userGeoWatchId = navigator.geolocation.watchPosition(
    (p) => {
      updateUserLocation({ lng: p.coords.longitude, lat: p.coords.latitude }, p.coords.heading);
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

$("locate")?.addEventListener("click", () => {
  if (!navigator.geolocation) {
    say("Géolocalisation non disponible.");
    return;
  }
  say("Acquisition du signal GPS…");
  $("locate").classList.add("is-active");
  navigator.geolocation.getCurrentPosition(
    (p) => {
      $("locate").classList.remove("is-active");
      say("");
      const coords = { lng: p.coords.longitude, lat: p.coords.latitude };
      updateUserLocation(coords, p.coords.heading);
      setPoint("from", { lng: coords.lng, lat: coords.lat, label: "Ma position actuelle" });
      map.flyTo({ center: [coords.lng, coords.lat], zoom: 15.5, duration: 750 });
      startLiveUserTracking();
    },
    () => {
      $("locate").classList.remove("is-active");
      say("Accès à la position refusé.");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

$("recenter")?.addEventListener("click", () => {
  const btn = $("recenter");
  if (nav.on) {
    resumeNavFollow();
    return;
  }

  btn?.classList.add("is-locating");
  if (!navigator.geolocation) {
    btn?.classList.remove("is-locating");
    if (state.userLocation) {
      map.flyTo({ center: [state.userLocation.lng, state.userLocation.lat], zoom: 16, duration: 750 });
    }
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (p) => {
      btn?.classList.remove("is-locating");
      btn?.classList.add("tracking");
      const coords = { lng: p.coords.longitude, lat: p.coords.latitude };
      updateUserLocation(coords, p.coords.heading);
      map.flyTo({ center: [coords.lng, coords.lat], zoom: 16.2, duration: 850 });
      startLiveUserTracking();
    },
    () => {
      btn?.classList.remove("is-locating");
      if (state.userLocation) {
        map.flyTo({ center: [state.userLocation.lng, state.userLocation.lat], zoom: 16, duration: 750 });
      }
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

map.on("dragstart", () => {
  $("recenter")?.classList.remove("tracking");
  if (nav.on && nav.follow) {
    nav.follow = false;
    $("nav-resume-follow-btn").hidden = false;
  }
});

$("swap")?.addEventListener("click", () => {
  const { from, to } = state;
  if (!from && !to) return;
  state.from = state.to = null;
  for (const k of ["from", "to"]) {
    $(k).value = "";
    markers[k]?.remove();
    markers[k] = null;
    updateClearButton(k);
  }
  if (to) setPoint("from", to);
  if (from) setPoint("to", from);
});

/* ---------- Ouverture / Réduction des Panneaux ---------- */
function openRoutePanel() {
  $("panel").hidden = false;
  $("top-search-bar").hidden = true;
  $("minimized-route-bar").hidden = true;
}

function closeRoutePanel() {
  $("panel").hidden = true;
  $("top-search-bar").hidden = false;
  if (state.activeRoute) {
    $("minimized-route-bar").hidden = false;
  }
}

function minimizeRoutePanel() {
  $("panel").hidden = true;
  if (state.activeRoute) {
    $("minimized-route-bar").hidden = false;
  } else {
    $("top-search-bar").hidden = false;
  }
}

$("open-directions-btn")?.addEventListener("click", openRoutePanel);
$("close-panel-btn")?.addEventListener("click", closeRoutePanel);
$("minimize-panel-btn")?.addEventListener("click", minimizeRoutePanel);
$("restore-panel-btn")?.addEventListener("click", openRoutePanel);

function getAllActivePoints() {
  return [state.from, ...state.waypoints.map((w) => w.pt), state.to].filter(Boolean);
}

function checkAndCompute() {
  const pts = getAllActivePoints();
  if (pts.length >= 2 && state.from && state.to) {
    computeRoutes();
  } else if (pts.length === 1) {
    const pt = pts[0];
    map.flyTo({ center: [pt.lng, pt.lat], zoom: Math.max(map.getZoom(), 14), duration: 750 });
  }
}

/* ---------- Calcul d'Itinéraires Multi-Critères ---------- */
async function computeRoutes() {
  const run = ++runId;
  const pts = getAllActivePoints();
  if (pts.length < 2) return;

  state.activeRoute = null;
  say("Calcul des itinéraires haute précision…");
  $("route-box").hidden = true;
  $("criteria-selector").hidden = true;
  $("algo-controls-card")?.removeAttribute("hidden");

  state.visualizeAlgo = Boolean($("algo-live-vis-toggle")?.checked);
  window.__algoSkipRequested = false;

  const visHud = $("algo-vis-hud");
  const visNodesCount = $("vis-nodes-count");
  const visFrontierCount = $("vis-frontier-count");
  const visTimeMs = $("vis-time-ms");

  if (state.visualizeAlgo && visHud) {
    visHud.hidden = false;
  }

  const onProgress = (p) => {
    if (visNodesCount) visNodesCount.textContent = String(p.stepsCount || 0);
    if (visFrontierCount) visFrontierCount.textContent = String(p.frontierSize || 0);
    if (visTimeMs) visTimeMs.textContent = `${p.elapsedMs || 0} ms`;

    if (map.getSource("algo-explored") && p.exploredEdges?.length) {
      map.getSource("algo-explored").setData({
        type: "FeatureCollection",
        features: p.exploredEdges.map((coords) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
        })),
      });
    }
  };

  try {
    const badge = $("algo-badge-status");
    const routes = await window.ClientRouter.computeMultiCriteriaRoute(map, {
      from: state.from,
      to: state.to,
      waypoints: state.waypoints,
      mode: state.mode,
      criteria: ["fastest", "shortest", "eco", "nohighway"],
      compareModes: true,
      visualize: state.visualizeAlgo,
      useContraction: state.useContraction !== false,
      onProgress,
    });

    if (run !== runId) return;

    const { fastest, shortest, eco, nohighway } = routes || {};

    if (badge) {
      if (fastest?.algorithm === "hybrid-ch") badge.textContent = "⚡ Hybride CH · Local";
      else if (fastest?.algorithm === "hybrid-astar") badge.textContent = "⚡ Hybride A* · Local";
      else badge.textContent = "🌐 Réseau Routier Global";
    }

    state.routeCandidates = { fastest, shortest, eco, nohighway };
    state.routeModes = routes?.modes || {};
    state.activeRoute = state.routeCandidates[state.criterion] || fastest;
  } catch (err) {
    say(err?.message && err.message.length < 90 ? err.message : "Aucun itinéraire routier trouvé.");
    return;
  } finally {
    if (visHud) visHud.hidden = true;
    setTimeout(() => {
      map.getSource("algo-explored")?.setData({ type: "FeatureCollection", features: [] });
      map.getSource("algo-frontier")?.setData({ type: "FeatureCollection", features: [] });
    }, 900);
  }

  const { fastest, shortest, eco, nohighway } = state.routeCandidates;
  if (!fastest) {
    say("Aucun trajet trouvé entre ces points.");
    return;
  }

  for (const b of document.querySelectorAll("#modes button")) {
    const m = b.dataset.mode;
    const modeRoute = state.routeModes?.[m] || (m === state.mode ? fastest : null);
    const smallEl = b.querySelector("small");
    if (smallEl) smallEl.textContent = modeRoute ? fmtDuration(modeRoute.duration) : "–";
  }

  const fillCritSub = (id, r, crit) => {
    const el = $(id);
    if (!el) return;
    if (!r) { el.textContent = "–"; return; }
    const fuel = computeFuelDetails(r.distance, crit, state.mode);
    el.innerHTML = `${fmtDuration(r.duration)} · ${fmtDistance(r.distance)}<span class="crit-fuel-tag">${fuel.fuelStr}</span>`;
  };

  fillCritSub("crit-fastest-sub", fastest, "fastest");
  fillCritSub("crit-shortest-sub", shortest, "shortest");
  fillCritSub("crit-eco-sub", eco, "eco");
  fillCritSub("crit-nohighway-sub", nohighway, "nohighway");

  renderComparisonTable(state.routeCandidates, state.routeModes);

  $("criteria-selector").hidden = false;
  $("algo-controls-card").hidden = false;
  updateCriteriaUI();

  showCurrentRoute(true);
}

function computeFuelDetails(distanceMeters, criterion = "fastest", mode = "car") {
  const km = (distanceMeters || 0) / 1000;
  if (mode !== "car") {
    const kcal = Math.round(km * (mode === "bike" ? 28 : 65));
    const co2SavedKg = (km * 0.125).toFixed(1);
    return { litres: 0, eur: 0, fuelStr: `${kcal} kcal`, ecoMeta: `${kcal} kcal · -${co2SavedKg} kg CO₂` };
  }

  let rate = 0.064;
  if (criterion === "shortest") rate = 0.058;
  else if (criterion === "eco") rate = 0.049;
  else if (criterion === "nohighway") rate = 0.053;

  const litres = km * rate;
  const eur = litres * 1.85;
  return {
    litres,
    eur,
    fuelStr: `${litres.toFixed(1)} L (${eur.toFixed(1)} €)`,
    ecoMeta: `${litres.toFixed(1)} L · ${eur.toFixed(1)} €`,
  };
}

function renderComparisonTable(candidates, modes) {
  const tbody = $("comparison-table-body");
  if (!tbody || !candidates) return;
  tbody.replaceChildren();

  const rows = [];
  const variantLabels = {
    car: [
      { key: "fastest", badge: `<span class="table-badge fastest">⚡ Rapide</span>` },
      { key: "shortest", badge: `<span class="table-badge shortest">📏 Court</span>` },
      { key: "eco", badge: `<span class="table-badge eco">🌿 Éco</span>` },
      { key: "nohighway", badge: `<span class="table-badge nohighway">🚫 Hors autoroute</span>` },
    ],
    bike: [
      { key: "fastest", badge: `<span class="table-badge bike">⚡ Vélo rapide</span>` },
      { key: "shortest", badge: `<span class="table-badge shortest">📏 Vélo court</span>` },
      { key: "eco", badge: `<span class="table-badge eco">🌿 Pistes cyclables</span>` },
      { key: "nohighway", badge: `<span class="table-badge nohighway">🍃 Rues calmes</span>` },
    ],
    foot: [
      { key: "fastest", badge: `<span class="table-badge foot">⚡ Piéton rapide</span>` },
      { key: "shortest", badge: `<span class="table-badge foot">📏 Piéton court</span>` },
    ],
  };

  const activeVariants = variantLabels[state.mode] || variantLabels.car;
  for (const v of activeVariants) {
    const r = candidates[v.key];
    if (r) {
      const fuel = computeFuelDetails(r.distance, v.key, state.mode);
      rows.push({
        mode: state.mode,
        criterion: v.key,
        badge: v.badge,
        dur: r.duration,
        dist: r.distance,
        fuel: state.mode === "car" ? fuel.fuelStr : fuel.ecoMeta,
      });
    }
  }

  for (const altMode of ["car", "bike", "foot"]) {
    if (altMode === state.mode) continue;
    const r = modes?.[altMode];
    if (!r) continue;
    const badgeMap = {
      car: `<span class="table-badge fastest">🚗 Voiture</span>`,
      bike: `<span class="table-badge bike">🚲 Vélo</span>`,
      foot: `<span class="table-badge foot">🚶 À pied</span>`,
    };
    const fuel = computeFuelDetails(r.distance, "fastest", altMode);
    rows.push({
      mode: altMode,
      criterion: "fastest",
      badge: badgeMap[altMode],
      dur: r.duration,
      dist: r.distance,
      fuel: altMode === "car" ? fuel.fuelStr : fuel.ecoMeta,
    });
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.className = "clickable-row";
    if (state.mode === row.mode && state.criterion === row.criterion) {
      tr.classList.add("is-selected");
    }
    tr.innerHTML = `
      <td>${row.badge}</td>
      <td><b>${fmtDuration(row.dur)}</b></td>
      <td>${fmtDistance(row.dist)}</td>
      <td><small>${row.fuel}</small></td>
    `;
    tr.addEventListener("click", () => {
      const modeChanged = row.mode !== state.mode;
      state.mode = row.mode;
      state.criterion = row.criterion;
      state.activeRoute = null;
      for (const b of document.querySelectorAll("#modes button")) {
        const isSel = b.dataset.mode === state.mode;
        b.setAttribute("aria-pressed", String(isSel));
        b.setAttribute("aria-selected", String(isSel));
      }
      if (modeChanged) {
        computeRoutes();
      } else {
        state.activeRoute = state.routeCandidates?.[state.criterion] || state.routeCandidates?.fastest;
        updateCriteriaUI();
        showCurrentRoute(false);
        renderComparisonTable(state.routeCandidates, state.routeModes);
      }
    });
    tbody.appendChild(tr);
  }
}

function updateCriteriaUI() {
  document.querySelectorAll(".criteria-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.criterion === state.criterion));
  });
  const noHwBtn = document.querySelector('.criteria-btn[data-criterion="nohighway"]');
  if (noHwBtn) {
    if (state.mode === "foot") {
      noHwBtn.hidden = true;
    } else {
      noHwBtn.hidden = false;
      const titleEl = noHwBtn.querySelector("b");
      if (titleEl) {
        titleEl.textContent = state.mode === "bike" ? "Rues calmes" : "Hors autoroute";
      }
    }
  }
}

document.querySelectorAll(".criteria-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.criterion = btn.dataset.criterion;
    state.activeRoute = state.routeCandidates?.[state.criterion] || state.routeCandidates?.fastest;
    updateCriteriaUI();
    showCurrentRoute(false);
    renderComparisonTable(state.routeCandidates, state.routeModes);
  });
});

/* ---------- Affichage de la Route Active + Tracés Alternatifs Cliquables ---------- */
function extractMainViaSummary(steps) {
  const counts = new Map();
  for (const s of steps) {
    const label = (s.name || s.ref || "").trim();
    if (!label || label === "Route" || label === "Destination") continue;
    counts.set(label, (counts.get(label) || 0) + (s.distance || 0));
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return "Itinéraire optimal dégagé";
  const topNames = sorted.slice(0, 2).map((e) => e[0]).join(" · ");
  return `Via ${topNames}`;
}

function showCurrentRoute(fit = false, forcedRoute = null) {
  if (forcedRoute) {
    state.activeRoute = forcedRoute;
  } else {
    state.activeRoute = (state.criterion && state.routeCandidates?.[state.criterion])
      || state.routeCandidates?.fastest
      || Object.values(state.routeCandidates || {}).find(Boolean)
      || state.activeRoute;
  }
  const r = state.activeRoute;
  if (!r) return;

  state.activeRoute = r;
  say("");

  if (!map.getSource("route")) {
    setupRouteLayers();
  }

  const modeColor = MODES[state.mode]?.color || "#2563eb";

  // 1. Afficher les itinéraires alternatifs en pointillés cliquables
  const altFeatures = [];
  if (state.routeCandidates) {
    for (const [critKey, cand] of Object.entries(state.routeCandidates)) {
      if (!cand || critKey === state.criterion || !cand.geometry) continue;
      altFeatures.push({
        type: "Feature",
        properties: { criterion: critKey },
        geometry: cand.geometry,
      });
    }
  }
  map.getSource("route-alt")?.setData({ type: "FeatureCollection", features: altFeatures });
  map.getSource("route-passed")?.setData({ type: "FeatureCollection", features: [] });

  // 2. Afficher la route active principale
  map.getSource("route")?.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { color: modeColor },
        geometry: r.geometry,
      },
    ],
  });

  if (fit && r.geometry?.coordinates?.length) {
    const c = r.geometry.coordinates;
    const bounds = c.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
    const wide = window.innerWidth >= 720;
    map.fitBounds(bounds, {
      padding: wide ? { top: 75, bottom: 75, left: 455, right: 75 } : { top: 90, bottom: 150, left: 35, right: 35 },
      duration: 850,
    });
  }

  const arrivalDate = new Date(Date.now() + r.duration * 1000);
  const arrivalTime = arrivalDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  $("route-duration-hero").textContent = fmtDuration(r.duration);
  $("route-distance-hero").textContent = fmtDistance(r.distance);
  $("route-eta-hero").textContent = `Arrivée ${arrivalTime}`;

  const fuelEl = $("route-fuel-hero");
  const fuelInfo = computeFuelDetails(r.distance, state.criterion, state.mode);
  fuelEl.textContent = state.mode === "car" ? fuelInfo.fuelStr : `0 L · ${fuelInfo.ecoMeta}`;
  fuelEl.hidden = false;

  const allSteps = r.legs.flatMap((leg) => leg.steps || []);
  const viaEl = $("route-via-text");
  if (viaEl) viaEl.textContent = extractMainViaSummary(allSteps);

  $("min-mode-icon").textContent = state.mode === "car" ? "🚗" : state.mode === "bike" ? "🚲" : "🚶";
  $("min-duration").textContent = fmtDuration(r.duration);
  $("min-meta").textContent = `${fmtDistance(r.distance)} · arrivée ${arrivalTime}`;

  // Feuille de route interactive (cliquer sur une étape zoome sur le carrefour)
  const ol = $("steps");
  ol.replaceChildren();

  for (const s of allSteps) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.className = "step-info";

    const iconWrap = document.createElement("div");
    iconWrap.className = "step-maneuver-icon";
    iconWrap.innerHTML = getManeuverSvg(s);

    const txt = document.createElement("div");
    txt.className = "step-text";
    txt.textContent = s.maneuver?.instruction || (s.name ? `Prenez ${s.name}` : "Continuez");

    info.append(iconWrap, txt);
    li.append(info);

    if (s.distance > 0) {
      const dist = document.createElement("span");
      dist.className = "step-dist-pill";
      dist.textContent = fmtDistance(s.distance);
      li.append(dist);
    }

    li.addEventListener("click", () => {
      const loc = s.maneuver?.location || s.location;
      if (loc && Array.isArray(loc)) {
        map.flyTo({ center: loc, zoom: 17, pitch: 52, duration: 750 });
      }
    });

    ol.append(li);
  }

  $("route-box").hidden = false;
}

for (const b of document.querySelectorAll("#modes button")) {
  b.addEventListener("click", () => {
    if (state.mode === b.dataset.mode && state.activeRoute) return;
    state.mode = b.dataset.mode;
    state.activeRoute = null;
    for (const btn of document.querySelectorAll("#modes button")) {
      const isSel = btn.dataset.mode === state.mode;
      btn.setAttribute("aria-pressed", String(isSel));
      btn.setAttribute("aria-selected", String(isSel));
    }
    computeRoutes();
  });
}

/* ==========================================================================
   MOTEUR DE CONDUITE COCKPIT 3D (Caméra Adaptative, Voies, Jauge SVG & Sim)
   ========================================================================== */
const nav = {
  on: false,
  watch: null,
  follow: true,
  overviewMode: false,
  off: 0,
  voice: true,
  wake: null,
  rerouting: false,
  said: new Set(),
  lastPos: null,
  lastBearing: 0,
  lastSpeakTime: 0,
  lastStepIndex: -1,
  lastAnnouncedKey: "",
};

function loadRoute(r) {
  nav.route = r;
  nav.geom = r.geometry.coordinates;
  nav.cum = [0];
  for (let i = 1; i < nav.geom.length; i++) {
    nav.cum.push(nav.cum[i - 1] + hav(nav.geom[i - 1], nav.geom[i]));
  }
  nav.total = nav.cum[nav.cum.length - 1] || 1;
  const scale = nav.total / (r.distance || nav.total);
  let acc = 0;
  nav.steps = r.legs?.flatMap((l) => l.steps || []) || [];

  if (nav.steps.length === 0) {
    nav.steps = [{
      name: "Itinéraire",
      roadClass: "primary",
      maxspeed: 80,
      distance: nav.total,
      duration: r.duration || 60,
      maneuver: { type: "depart", instruction: "Suivez l'itinéraire" },
    }];
  }

  nav.ends = nav.steps.map((s) => (acc += (s.distance || 50) * scale));
}

function snap(pos) {
  const k = Math.cos(pos[1] * Math.PI / 180), m = 111320, g = nav.geom;
  let best = { d: Infinity, along: 0, segIdx: 0, point: pos };
  for (let i = 0; i < g.length - 1; i++) {
    const ax = (g[i][0] - pos[0]) * k * m, ay = (g[i][1] - pos[1]) * m;
    const dx = (g[i + 1][0] - pos[0]) * k * m - ax, dy = (g[i + 1][1] - pos[1]) * m - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) {
      best = {
        d,
        along: nav.cum[i] + t * (nav.cum[i + 1] - nav.cum[i]),
        segIdx: i,
        point: [
          g[i][0] + (g[i + 1][0] - g[i][0]) * t,
          g[i][1] + (g[i + 1][1] - g[i][1]) * t,
        ],
      };
    }
  }
  return best;
}

/** Découpe dynamique du tracé en "déjà parcouru" (gris) et "devant le véhicule" (lumineux) */
function updateLiveRouteSplit(snapped) {
  if (!nav.geom || nav.geom.length < 2) return;
  const idx = snapped.segIdx;
  const pt = snapped.point;

  const passedCoords = [...nav.geom.slice(0, idx + 1), pt];
  const aheadCoords = [pt, ...nav.geom.slice(idx + 1)];

  if (passedCoords.length >= 2) {
    map.getSource("route-passed")?.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: passedCoords },
    });
  }

  if (aheadCoords.length >= 2) {
    map.getSource("route")?.setData({
      type: "Feature",
      properties: { color: MODES[state.mode].color },
      geometry: { type: "LineString", coordinates: aheadCoords },
    });
  }
}

function speak(text, force = false) {
  if (!nav.voice) return;
  const now = Date.now();
  if (!force && nav.lastAnnouncedKey && nav.lastAnnouncedKey === text && now - (nav.lastSpeakTime || 0) < 4000) {
    return;
  }
  if (!force && now - (nav.lastSpeakTime || 0) < 1200) {
    // Avoid double speak bursts
    return;
  }
  if (window.PiperTTS && typeof window.PiperTTS.speak === "function") {
    window.PiperTTS.speak(text, { force });
  } else if (window.speechSynthesis) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
  nav.lastSpeakTime = now;
  nav.lastAnnouncedKey = text;
}

async function requestWake() {
  try { nav.wake = await navigator.wakeLock?.request("screen"); } catch {}
}

function estimateSpeedLimit(step) {
  if (state.mode === "foot") return 6;
  if (state.mode === "bike") return 25;

  if (step?.maxspeed && !isNaN(Number(step.maxspeed)) && Number(step.maxspeed) > 0) {
    return Number(step.maxspeed);
  }

  const loc = step?.location ||
              (state.userLocation ? [state.userLocation.lng, state.userLocation.lat] : null) ||
              (state.from ? [state.from.lng, state.from.lat] : null);
  const text = `${step?.name || ""} ${step?.ref || ""}`.trim();

  if (window.ClientRouter?.resolveSpeedLimit) {
    return window.ClientRouter.resolveSpeedLimit(step?.roadClass || "street", step?.maxspeed, state.mode, loc, text);
  }
  return 50;
}

/** Met à jour l'anneau SVG du compteur de vitesse et les alertes visuelles */
function updateSpeedometerGauge(speedKmh, speedLimit) {
  $("current-speed-val").textContent = String(speedKmh);
  $("speed-limit-val").textContent = String(speedLimit);

  const gauge = $("speedometer-pill");
  const ringFill = $("speed-ring-fill");
  const circumference = 182.2; // 2 * PI * 29
  const ratio = Math.min(1.15, Math.max(0, speedKmh / Math.max(10, speedLimit)));
  const offset = circumference - Math.min(1, ratio) * circumference;

  if (ringFill) {
    ringFill.style.strokeDashoffset = String(offset);
  }

  if (gauge) {
    const isOver = speedKmh > speedLimit + 3;
    const isWarn = !isOver && speedKmh >= speedLimit - 3;
    gauge.classList.toggle("speeding", isOver);
    gauge.classList.toggle("speed-warning", isWarn);
  }
}

/* ---------- Simulation de Conduite Multi-Vitesses (1x, 3x, 8x) ---------- */
let simInterval = null;
let simDistance = 0;
let currentSimSpeedKmh = 0;
let simMultiplier = 1;

function stopDriveSimulation() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
  const btn = $("sim-btn");
  if (btn) btn.setAttribute("aria-pressed", "false");
  const tag = $("sim-speed-tag");
  if (tag) tag.hidden = true;
}

function startDriveSimulation(multiplier = 2) {
  const r = state.activeRoute;
  if (!r) return;
  if (!nav.on) startNav();
  if (!nav.geom || nav.geom.length < 2) return;

  stopDriveSimulation();
  simMultiplier = multiplier;

  const btn = $("sim-btn");
  if (btn) btn.setAttribute("aria-pressed", "true");
  const tag = $("sim-speed-tag");
  if (tag) {
    tag.textContent = `${simMultiplier}x`;
    tag.hidden = false;
  }

  if (simDistance >= nav.total - 30) simDistance = 0;
  currentSimSpeedKmh = 25;

  simInterval = setInterval(() => {
    if (!nav.on) {
      stopDriveSimulation();
      return;
    }

    let segIdx = 0;
    while (segIdx < nav.cum.length - 1 && nav.cum[segIdx + 1] < simDistance) {
      segIdx++;
    }

    if (segIdx >= nav.geom.length - 1 || simDistance >= nav.total) {
      onFix({
        coords: {
          longitude: nav.geom[nav.geom.length - 1][0],
          latitude: nav.geom[nav.geom.length - 1][1],
          speed: 0,
          heading: nav.lastBearing,
        },
      });
      stopDriveSimulation();
      return;
    }

    const p1 = nav.geom[segIdx];
    const p2 = nav.geom[segIdx + 1];
    const segLen = (nav.cum[segIdx + 1] - nav.cum[segIdx]) || 1;
    const segProgress = Math.min(1, Math.max(0, (simDistance - nav.cum[segIdx]) / segLen));

    const lng = p1[0] + (p2[0] - p1[0]) * segProgress;
    const lat = p1[1] + (p2[1] - p1[1]) * segProgress;
    const headingDeg = calcBearing(p1, p2);

    let stepIdx = nav.ends.findIndex((e) => e > simDistance);
    if (stepIdx < 0) stepIdx = nav.steps.length - 1;
    const currentStep = nav.steps[stepIdx];
    const limit = estimateSpeedLimit(currentStep);

    const distToTurn = Math.max(0, nav.ends[stepIdx] - simDistance);
    let targetSpeed = limit;
    if (distToTurn < 55) targetSpeed = Math.min(limit, 26);
    else if (distToTurn < 130) targetSpeed = Math.min(limit, 44);

    if (currentSimSpeedKmh < targetSpeed) {
      currentSimSpeedKmh = Math.min(targetSpeed, currentSimSpeedKmh + 3.2);
    } else if (currentSimSpeedKmh > targetSpeed) {
      currentSimSpeedKmh = Math.max(targetSpeed, currentSimSpeedKmh - 4.2);
    }

    const displaySpeed = Math.max(5, Math.round(currentSimSpeedKmh + Math.sin(Date.now() / 650) * 1.2));
    const speedMs = displaySpeed / 3.6;

    simDistance += speedMs * 0.2 * simMultiplier;

    onFix({
      coords: {
        longitude: lng,
        latitude: lat,
        speed: speedMs,
        heading: headingDeg,
      },
    });
  }, 200);
}

function cycleDriveSimulation() {
  if (!simInterval) {
    startDriveSimulation(2);
  } else if (simMultiplier === 2) {
    startDriveSimulation(5);
  } else if (simMultiplier === 5) {
    startDriveSimulation(10);
  } else {
    stopDriveSimulation();
  }
}

/* ---------- Démarrage & Arrêt du Mode Conduite ---------- */
function resumeNavFollow() {
  nav.follow = true;
  nav.overviewMode = false;
  $("nav-resume-follow-btn").hidden = true;
  $("nav-overview-btn")?.setAttribute("aria-pressed", "false");
  if (nav.lastPos) {
    map.easeTo({
      center: nav.lastPos,
      zoom: 17.2,
      pitch: 58,
      bearing: nav.lastBearing || 0,
      duration: 650,
    });
  }
}

function toggleNavOverview() {
  if (!nav.on || !nav.geom?.length) return;
  nav.overviewMode = !nav.overviewMode;
  $("nav-overview-btn")?.setAttribute("aria-pressed", String(nav.overviewMode));

  if (nav.overviewMode) {
    nav.follow = false;
    $("nav-resume-follow-btn").hidden = false;
    const bounds = nav.geom.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(nav.geom[0], nav.geom[0]));
    map.fitBounds(bounds, {
      padding: { top: 160, bottom: 130, left: 50, right: 50 },
      pitch: 0,
      bearing: 0,
      duration: 800,
    });
  } else {
    resumeNavFollow();
  }
}

function startNav() {
  const r = state.activeRoute;
  if (!r) return;
  loadRoute(r);
  Object.assign(nav, {
    on: true,
    follow: true,
    overviewMode: false,
    off: 0,
    rerouting: false,
    said: new Set(),
    lastStepIndex: -1,
    lastSpeakTime: 0,
    lastAnnouncedKey: "",
  });
  simDistance = 0;

  // Masquer les tracés alternatifs pour une lisibilité totale en conduite
  map.getSource("route-alt")?.setData({ type: "FeatureCollection", features: [] });

  $("banner-dist").textContent = "-- m";
  $("banner-text").textContent = "Acquisition du signal GPS…";
  $("banner-lanes").hidden = true;
  $("banner-next-step").hidden = true;
  $("nav-resume-follow-btn").hidden = true;

  const initialLimit = estimateSpeedLimit(nav.steps[0]);
  state.speedLimitKmh = initialLimit;
  updateSpeedometerGauge(0, initialLimit);

  document.body.classList.add("navigating");
  ensure3DBuildings();
  requestWake();

  // Positionner immédiatement la caméra en mode Cockpit 3D au départ du trajet
  if (nav.geom?.length >= 2) {
    const p0 = nav.geom[0];
    const p1 = nav.geom[Math.min(3, nav.geom.length - 1)];
    const initBearing = calcBearing(p0, p1);
    nav.lastPos = p0;
    nav.lastBearing = initBearing;
    updateUserLocation({ lng: p0[0], lat: p0[1] }, initBearing);
    map.easeTo({
      center: p0,
      zoom: 17.2,
      pitch: 58,
      bearing: initBearing,
      duration: 900,
    });
  }

  // Annonce vocale d'accueil
  if (nav.steps[0]?.maneuver?.instruction) {
    speak(`Départ. ${nav.steps[0].maneuver.instruction}`, true);
  } else {
    speak("Départ. Suivez l'itinéraire.", true);
  }

  if (navigator.geolocation) {
    nav.watch = navigator.geolocation.watchPosition(onFix, onFixError, {
      enableHighAccuracy: true,
      maximumAge: 500,
      timeout: 15000,
    });
  }
}

function stopNav(msg) {
  stopDriveSimulation();
  nav.on = false;
  if (nav.watch !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(nav.watch);
  }
  nav.watch = null;
  nav.wake?.release?.().catch(() => {});
  nav.wake = null;
  window.PiperTTS?.stop();
  window.speechSynthesis?.cancel();
  document.body.classList.remove("navigating");
  $("nav-resume-follow-btn").hidden = true;
  map.easeTo({ bearing: 0, pitch: state.is3D ? 58 : 0, duration: 700 });
  if (state.activeRoute) showCurrentRoute(true);
  say(msg || "");
}

function onFixError(err) {
  if (err.code === 1) stopNav("Position GPS refusée.");
}

function onFix(p) {
  if (!nav.on) return;
  const rawPos = [p.coords.longitude, p.coords.latitude];
  const s = snap(rawPos);

  // En conduite normale (< 35m d'écart), aimanter le curseur sur la route ("Map Matching")
  const matchedPos = s.d < 35 ? s.point : rawPos;
  nav.lastPos = matchedPos;

  // Calcul du cap anticipé sur la géométrie de la route
  let roadBearing = p.coords.heading;
  if (roadBearing == null || isNaN(roadBearing)) {
    const nextPt = nav.geom[Math.min(s.segIdx + 1, nav.geom.length - 1)];
    roadBearing = calcBearing(matchedPos, nextPt);
  }
  nav.lastBearing = roadBearing;

  updateUserLocation({ lng: matchedPos[0], lat: matchedPos[1] }, roadBearing);
  updateLiveRouteSplit(s);

  const rawSpeed = p.coords.speed;
  const speedKmh = rawSpeed != null && !isNaN(rawSpeed) && rawSpeed >= 0 ? Math.round(rawSpeed * 3.6) : 0;
  state.currentSpeedKmh = speedKmh;

  const remaining = Math.max(0, nav.total - s.along);
  const progressPct = Math.min(100, Math.max(0, ((nav.total - remaining) / nav.total) * 100));
  const progFill = $("nav-progress-fill");
  if (progFill) progFill.style.width = `${progressPct.toFixed(1)}%`;

  if (remaining < 22) {
    speak("Vous êtes arrivé à destination.", true);
    stopNav("Vous êtes arrivé à destination.");
    return;
  }

  // Détection de sortie d'itinéraire (> 50m sur 3 mesures) -> Recalcul automatique
  if (s.d > 50 && !nav.rerouting) {
    nav.off = (nav.off || 0) + 1;
    if (nav.off >= 3) {
      nav.rerouting = true;
      speak("Recalcul de l'itinéraire.", true);
      $("banner-text").textContent = "Recalcul en cours…";
      state.from = { lng: rawPos[0], lat: rawPos[1], label: "Position GPS" };
      computeRoutes().then(() => {
        nav.rerouting = false;
        nav.off = 0;
        if (state.activeRoute) loadRoute(state.activeRoute);
      });
      return;
    }
  } else {
    nav.off = 0;
  }

  let i = nav.ends.findIndex((e) => e > s.along);
  if (i < 0) i = nav.steps.length - 1;

  const currentStep = nav.steps[i] || nav.steps[0];
  const next = nav.steps[Math.min(i + 1, nav.steps.length - 1)];
  const afterNext = nav.steps[Math.min(i + 2, nav.steps.length - 1)];
  const toNext = Math.max(0, (nav.ends[i] || 0) - s.along);
  const instructionText = next?.maneuver?.instruction || (next?.name ? `Prenez ${next.name}` : "Continuez tout droit");

  // Nom de la rue actuelle dans la pilule inférieure (utilise la rue effectivement empruntée ou la plus proche en avant)
  const streetEl = $("current-street-name");
  if (streetEl) {
    let streetName = currentStep?.name && currentStep.name !== "Route" ? currentStep.name : (next?.name && next.name !== "Route" ? next.name : "Sur l'itinéraire");
    if (next?.name && next.name !== "Route" && toNext > 150) {
      streetName = next.name;
    }
    streetEl.textContent = streetName;
  }

  // Limitation de vitesse et jauge circulaire SVG
  const speedLimit = estimateSpeedLimit(currentStep);
  state.speedLimitKmh = speedLimit;
  updateSpeedometerGauge(speedKmh, speedLimit);

  // Mise à jour de la bannière principale + Cartouche Route + Voies + "Puis"
  if (!nav.rerouting) {
    $("banner-dist").textContent = fmtDistance(toNext);
    $("banner-text").textContent = instructionText;
    $("banner-icon-wrap").innerHTML = getManeuverSvg(next);

    const shieldEl = $("banner-road-shield");
    const shield = extractRoadShield(next) || extractRoadShield(currentStep);
    if (shieldEl) {
      if (shield) {
        shieldEl.textContent = shield.code;
        shieldEl.className = `road-shield ${shield.cls}`;
        shieldEl.hidden = false;
      } else {
        shieldEl.hidden = true;
      }
    }

    updateLaneGuidanceUI(next, toNext);

    // Sous-bannière "Puis" si une autre manœuvre suit à moins de 250m
    const nextBar = $("banner-next-step");
    if (nextBar) {
      if (state.announceCarrefours && afterNext && afterNext !== next && (next?.distance || 999) < 250) {
        $("banner-next-icon").innerHTML = getManeuverSvg(afterNext);
        $("banner-next-text").textContent = afterNext.maneuver?.instruction || afterNext.name || "Continuez";
        nextBar.hidden = false;
      } else {
        nextBar.hidden = true;
      }
    }
  }

  // Annonces vocales progressives (détecte rond-point et espace les annonces pour éviter double)
  if (nav.voice && next && toNext > 0) {
    const stepKey = `step-${i}`;
    const maneuverType = next?.maneuver?.type || "";
    const isRoundabout = maneuverType === "roundabout" || maneuverType === "rotary";
    const now = Date.now();
    const elapsed = now - (nav.lastSpeakTime || 0);

    if (isRoundabout) {
      const exit = next?.maneuver?.exit || 1;
      if (toNext <= 220 && toNext > 80 && !nav.said.has(`${stepKey}-r200`)) {
        if (elapsed > 2000) {
          nav.said.add(`${stepKey}-r200`);
          speak(`Dans 200 mètres, prenez la ${exit === 1 ? "première" : exit === 2 ? "deuxième" : exit === 3 ? "troisième" : exit + "e"} sortie du rond-point.`);
          return;
        }
      } else if (toNext <= 80 && toNext > 15 && !nav.said.has(`${stepKey}-r60`)) {
        if (elapsed > 1500) {
          nav.said.add(`${stepKey}-r60`);
          speak(`Prenez la ${exit === 1 ? "première" : exit === 2 ? "deuxième" : exit === 3 ? "troisième" : exit + "e"} sortie du rond-point.`);
          return;
        }
      }
    }

    if (speedKmh > 90 && toNext <= 900 && toNext > 650 && !nav.said.has(`${stepKey}-900`) && elapsed > 4500) {
      nav.said.add(`${stepKey}-900`);
      speak(`Dans 900 mètres, ${instructionText}`);
      return;
    } else if (toNext <= 400 && toNext > 200 && !nav.said.has(`${stepKey}-400`) && elapsed > 3500) {
      nav.said.add(`${stepKey}-400`);
      speak(`Dans 400 mètres, ${instructionText}`);
      return;
    } else if (toNext <= 150 && toNext > 40 && !nav.said.has(`${stepKey}-150`) && elapsed > 2500) {
      nav.said.add(`${stepKey}-150`);
      speak(`Dans 150 mètres, ${instructionText}`);
      return;
    } else if (toNext <= 70 && toNext > 10 && !nav.said.has(`${stepKey}-now`) && elapsed > 2000) {
      nav.said.add(`${stepKey}-now`);
      speak(instructionText);
      return;
    }
  }

  const sec = (nav.route.duration * remaining) / nav.total;
  const arrival = new Date(Date.now() + sec * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  $("eta").textContent = arrival;
  $("eta-remaining-badge").textContent = fmtDuration(sec);
  $("eta-sub").textContent = `${fmtDistance(remaining)} restants · ${state.criterion === "fastest" ? "Trajet optimal" : "Itinéraire personnalisé"}`;

  // Caméra Cockpit Dynamique : zoom adaptatif selon la vitesse et l'approche du virage
  if (nav.follow && !nav.overviewMode) {
    let targetZoom = 17.1;
    if (toNext < 110) targetZoom = 17.6; // Zoom précis sur le carrefour imminent
    else if (speedKmh > 100) targetZoom = 15.6; // Dézoom autoroutier pour voir loin
    else if (speedKmh > 70) targetZoom = 16.3;

    const offsetPx = window.innerHeight > 540 ? [0, Math.round(window.innerHeight * 0.18)] : [0, 50];

    map.easeTo({
      center: matchedPos,
      zoom: targetZoom,
      pitch: 58,
      bearing: roadBearing,
      offset: offsetPx,
      duration: 380,
    });
  }
}

/* ---------- Annulation Complète du Trajet ---------- */
function cancelTrip() {
  if (nav.on) stopNav();

  state.from = null;
  state.to = null;
  state.waypoints = [];
  state.activeRoute = null;
  state.routeCandidates = {};

  if ($("from")) $("from").value = "";
  if ($("to")) $("to").value = "";
  $("clear-from")?.setAttribute("hidden", "");
  $("clear-to")?.setAttribute("hidden", "");

  if ($("quick-search-input")) $("quick-search-input").value = "";
  $("quick-clear-btn")?.setAttribute("hidden", "");

  const wpContainer = $("waypoints-container");
  if (wpContainer) wpContainer.innerHTML = "";

  markers.from?.remove();
  markers.from = null;
  markers.to?.remove();
  markers.to = null;
  for (const id in markers.waypoints) markers.waypoints[id]?.remove();
  markers.waypoints = {};

  const empty = { type: "FeatureCollection", features: [] };
  map.getSource("route")?.setData(empty);
  map.getSource("route-alt")?.setData(empty);
  map.getSource("route-passed")?.setData(empty);
  map.getSource("algo-explored")?.setData(empty);
  map.getSource("algo-frontier")?.setData(empty);
  $("algo-vis-hud")?.setAttribute("hidden", "");

  $("route-box")?.setAttribute("hidden", "");
  $("criteria-selector")?.setAttribute("hidden", "");
  $("algo-controls-card")?.setAttribute("hidden", "");
  $("minimized-route-bar")?.setAttribute("hidden", "");

  $("panel")?.setAttribute("hidden", "");
  $("top-search-bar")?.removeAttribute("hidden");
  say("Trajet réinitialisé.");
}

$("start")?.addEventListener("click", startNav);
$("min-start-btn")?.addEventListener("click", startNav);
$("preview-sim-btn")?.addEventListener("click", () => startDriveSimulation(3));
$("stop")?.addEventListener("click", () => stopNav("Guidage terminé."));
$("nav-resume-follow-btn")?.addEventListener("click", resumeNavFollow);
$("nav-overview-btn")?.addEventListener("click", toggleNavOverview);

$("cancel-route-btn")?.addEventListener("click", cancelTrip);
$("cancel-route-action-btn")?.addEventListener("click", cancelTrip);
$("min-cancel-btn")?.addEventListener("click", cancelTrip);

/* ---------- Paramètres & Voix ---------- */
function syncAlgoUI() {
  const crit = state.criterion || "fastest";
  if ($("settings-criterion-select")) $("settings-criterion-select").value = crit;
  if ($("algo-criterion-select")) $("algo-criterion-select").value = crit;
  if ($("settings-ch-toggle")) $("settings-ch-toggle").checked = state.useContraction !== false;
}

function populateVoiceSelect() {
  const select = $("settings-voice-select");
  if (!select || !window.PiperTTS) return;

  const voicesData = window.PiperTTS.getRealAvailableVoices();
  const currentEngine = window.PiperTTS.getEngineStatus();
  const activeUri = window.PiperTTS.selectedVoiceURI;
  const activeVoiceName = window.PiperTTS.voiceName;

  select.innerHTML = "";
  let matched = false;

  const addGroup = (label, list) => {
    if (!list || !list.length) return;
    const grp = document.createElement("optgroup");
    grp.label = label;
    list.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = `web:${v.voiceURI}`;
      opt.textContent = v.displayName;
      if (!matched && (activeUri === v.voiceURI || activeVoiceName === `web:${v.voiceURI}`)) {
        opt.selected = true;
        matched = true;
      }
      grp.appendChild(opt);
    });
    select.appendChild(grp);
  };

  addGroup("🇧🇪 Français (Belgique)", voicesData.belgian);
  addGroup("🇫🇷 Français (France)", voicesData.french);
  addGroup("🌐 Autres Voix Francophones", voicesData.otherFr);

  if (voicesData.piper && voicesData.piper.length > 0 && currentEngine.backendAvailable) {
    const groupPiper = document.createElement("optgroup");
    groupPiper.label = "🤖 Modèles Neuronaux Piper ONNX";
    voicesData.piper.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = `piper:${v.id}`;
      opt.textContent = `${v.label} · Piper Studio`;
      if (!activeUri && (activeVoiceName === v.id || activeVoiceName === `piper:${v.id}`)) {
        opt.selected = true;
        matched = true;
      }
      groupPiper.appendChild(opt);
    });
    select.appendChild(groupPiper);
  }

  if (!matched && select.options.length > 0) {
    select.selectedIndex = 0;
    window.PiperTTS.setVoice(select.value);
  }

  updateVoiceEngineUI();
}

function updateVoiceEngineUI(status) {
  const current = status || window.PiperTTS?.getEngineStatus();
  if (!current) return;

  const badge = $("voice-engine-badge");
  const details = $("voice-engine-details");

  if (badge) {
    if (current.backendAvailable && !current.selectedVoiceURI) {
      badge.textContent = "🟢 Piper Neural ONNX";
      badge.className = "engine-badge live-ok";
    } else {
      badge.textContent = "✨ Voix HD Réelle";
      badge.className = "engine-badge web-hd";
    }
  }

  if (details) {
    if (current.backendAvailable && !current.selectedVoiceURI) {
      details.textContent = `Moteur Piper ONNX actif · Modèle ${current.voiceId} · Rendu neural studio haute fidélité.`;
    } else {
      details.textContent = `Voix active : ${current.webVoiceName} · Prosodie GPS fluide & égalisation acoustique.`;
    }
  }
}

window.addEventListener("piper-engine-status", (e) => updateVoiceEngineUI(e.detail));
window.addEventListener("piper-voices-ready", populateVoiceSelect);
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = populateVoiceSelect;
}

function openSettingsModal() {
  const modal = $("settings-modal");
  if (!modal) return;

  syncAlgoUI();
  populateVoiceSelect();

  if ($("settings-criterion-select")) $("settings-criterion-select").value = state.criterion || "fastest";
  if ($("settings-ch-toggle")) $("settings-ch-toggle").checked = state.useContraction !== false;
  if ($("settings-vis-toggle")) $("settings-vis-toggle").checked = state.visualizeAlgo;
  if ($("algo-live-vis-toggle")) $("algo-live-vis-toggle").checked = state.visualizeAlgo;

  const rateSlider = $("voice-rate-slider");
  if (rateSlider && window.PiperTTS) {
    rateSlider.value = String(window.PiperTTS.voiceRate);
    if ($("voice-rate-label")) $("voice-rate-label").textContent = `${Number(window.PiperTTS.voiceRate).toFixed(2)}x`;
  }

  const pitchSlider = $("voice-pitch-slider");
  if (pitchSlider && window.PiperTTS) {
    pitchSlider.value = String(window.PiperTTS.voicePitch);
    if ($("voice-pitch-label")) $("voice-pitch-label").textContent = Number(window.PiperTTS.voicePitch).toFixed(2);
  }

  if ($("settings-announce-roundabouts")) $("settings-announce-roundabouts").checked = state.announceRoundabouts;
  if ($("settings-announce-carrefours")) $("settings-announce-carrefours").checked = state.announceCarrefours;

  updateVoiceEngineUI();
  modal.showModal();
  $("close-settings")?.focus();
}

function handleCriterionChange(newCriterion) {
  state.criterion = newCriterion;
  safeStorage.setItem("mon_maps_criterion", newCriterion);
  syncAlgoUI();
  updateCriteriaUI();
  if (state.routeCandidates && state.routeCandidates[newCriterion]) {
    state.activeRoute = state.routeCandidates[newCriterion];
    showCurrentRoute(false);
    renderComparisonTable(state.routeCandidates, state.routeModes);
  } else {
    const pts = getAllActivePoints();
    if (pts.length >= 2 && state.from && state.to) computeRoutes();
  }
}

$("open-settings-quick-btn")?.addEventListener("click", openSettingsModal);
$("open-settings-panel-btn")?.addEventListener("click", openSettingsModal);
$("close-settings")?.addEventListener("click", () => $("settings-modal")?.close());
$("settings-modal")?.addEventListener("click", (e) => {
  if (e.target === $("settings-modal")) $("settings-modal").close();
});

$("settings-criterion-select")?.addEventListener("change", (e) => handleCriterionChange(e.target.value));
$("algo-criterion-select")?.addEventListener("change", (e) => handleCriterionChange(e.target.value));

$("settings-ch-toggle")?.addEventListener("change", (e) => {
  state.useContraction = e.target.checked;
  safeStorage.setItem("mon_maps_use_ch", String(e.target.checked));
  if (window.ClientRouter?.ROUTER_CONFIG) {
    window.ClientRouter.ROUTER_CONFIG.useContraction = e.target.checked;
  }
  syncAlgoUI();
  const pts = getAllActivePoints();
  if (pts.length >= 2 && state.from && state.to) computeRoutes();
});

$("settings-vis-toggle")?.addEventListener("change", (e) => {
  state.visualizeAlgo = e.target.checked;
  if ($("algo-live-vis-toggle")) $("algo-live-vis-toggle").checked = e.target.checked;
  safeStorage.setItem("mon_maps_vis_algo", String(state.visualizeAlgo));
});

$("algo-live-vis-toggle")?.addEventListener("change", (e) => {
  state.visualizeAlgo = e.target.checked;
  if ($("settings-vis-toggle")) $("settings-vis-toggle").checked = e.target.checked;
  safeStorage.setItem("mon_maps_vis_algo", String(state.visualizeAlgo));
  const pts = getAllActivePoints();
  if (pts.length >= 2 && state.from && state.to) computeRoutes();
});

$("settings-voice-select")?.addEventListener("change", (e) => {
  window.PiperTTS?.setVoice(e.target.value);
  updateVoiceEngineUI();
});

$("test-voice-btn")?.addEventListener("click", () => {
  window.PiperTTS?.testVoice();
});

$("voice-rate-slider")?.addEventListener("input", (e) => {
  const r = parseFloat(e.target.value);
  window.PiperTTS?.setRate(r);
  if ($("voice-rate-label")) $("voice-rate-label").textContent = `${r.toFixed(2)}x`;
});

$("voice-pitch-slider")?.addEventListener("input", (e) => {
  const p = parseFloat(e.target.value);
  window.PiperTTS?.setPitch(p);
  if ($("voice-pitch-label")) $("voice-pitch-label").textContent = p.toFixed(2);
});

$("settings-announce-roundabouts")?.addEventListener("change", (e) => {
  state.announceRoundabouts = e.target.checked;
  safeStorage.setItem("mon_maps_roundabouts", String(e.target.checked));
});

$("settings-announce-carrefours")?.addEventListener("change", (e) => {
  state.announceCarrefours = e.target.checked;
  safeStorage.setItem("mon_maps_carrefours", String(e.target.checked));
});

syncAlgoUI();
populateVoiceSelect();

$("algo-vis-skip-btn")?.addEventListener("click", () => {
  window.__algoSkipRequested = true;
});

$("sim-btn")?.addEventListener("click", cycleDriveSimulation);
$("speedometer-pill")?.addEventListener("click", cycleDriveSimulation);

$("speed-limit-badge")?.addEventListener("click", () => {
  const limits = [30, 50, 70, 80, 90, 110, 120, 130];
  const curIdx = limits.indexOf(state.speedLimitKmh);
  const nextLimit = limits[(curIdx + 1) % limits.length];
  state.speedLimitKmh = nextLimit;
  updateSpeedometerGauge(state.currentSpeedKmh, nextLimit);
});

$("mute")?.addEventListener("click", () => {
  nav.voice = !nav.voice;
  $("mute").setAttribute("aria-pressed", String(nav.voice));
  if (!nav.voice) {
    window.PiperTTS?.stop();
    window.speechSynthesis?.cancel();
  }
});

/* ---------- Redimensionnement & Rotation Mobile ---------- */
window.addEventListener("resize", () => map?.resize());
window.addEventListener("orientationchange", () => setTimeout(() => map?.resize(), 150));

// Mode Démo Drive via paramètre URL (?drive=1)
if (new URLSearchParams(window.location.search).has("drive")) {
  document.body.classList.add("navigating");
  if ($("banner-dist")) $("banner-dist").textContent = "180 m";
  if ($("banner-text")) $("banner-text").textContent = "Serrez à droite vers Avenue Louise";
  if ($("eta")) $("eta").textContent = "18:42";
  if ($("eta-remaining-badge")) $("eta-remaining-badge").textContent = "14 min";
  if ($("eta-sub")) $("eta-sub").textContent = "9.4 km restants · Trajet optimal";
  updateSpeedometerGauge(48, 50);
}

/* ---------- Enregistrement du Service Worker PWA ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js?v=19")
      .then((reg) => reg.update())
      .catch(() => {});
  });
}