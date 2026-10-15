"use strict";

/* ==========================================================================
   Mon Maps · Navigation, Multi-étapes, OpenFreeMap 3D & Compteur Vitesse
   ========================================================================== */

const MODES = {
  car:  { label: "Voiture", path: "routed-car",  bFast: "car-fast", bEco: "car-eco", color: "#2563eb" },
  bike: { label: "Vélo",    path: "routed-bike", bFast: "fastbike", bEco: "safety",  color: "#059669" },
  foot: { label: "À pied",  path: "routed-foot", bFast: "hiking",   bEco: "hiking",  color: "#ea580c" },
};

const $ = (id) => document.getElementById(id);

const state = {
  from: null,
  waypoints: [], // { id, pt }
  to: null,
  mode: "car",
  criterion: localStorage.getItem("mon_maps_criterion") || "fastest", // "fastest" | "shortest" | "eco" | "nohighway"
  routeCandidates: {},  // { fastest: route, shortest: route, eco: route, nohighway: route }
  activeRoute: null,
  userLocation: null,
  followOrientation: false,
  is3D: false,
  activeLayer: "ofm-bright",
  currentSpeedKmh: 0,
  speedLimitKmh: 80,
  visualizeAlgo: localStorage.getItem("mon_maps_vis_algo") === "true",
  useContraction: localStorage.getItem("mon_maps_use_ch") !== "false",
  algorithm: "hybrid",
  announceRoundabouts: localStorage.getItem("mon_maps_roundabouts") !== "false",
  announceCarrefours: localStorage.getItem("mon_maps_carrefours") !== "false",
};

const markers = {
  from: null,
  waypoints: {},
  to: null,
};

let waypointSeq = 0;
let runId = 0;
let orientationHandler = null;

/* ---------- Formats & Maths ---------- */
function fmtDuration(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function hav(a, b) {
  const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

const say = (text) => {
  const el = $("status");
  if (el) el.textContent = text;
};

/* ---------- Thème (Clair / Sombre) & Adaptation de la carte ---------- */
function toggleTheme() {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const nextTheme = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  try { localStorage.setItem("maps-theme", nextTheme); } catch {}

  // Mettre à jour immédiatement la carte selon le nouveau thème
  const conf = MAP_STYLES[state.activeLayer] || MAP_STYLES["openfreemap"];
  if (conf.type === "vector") {
    const isDark = nextTheme === "dark";
    const nextUrl = isDark ? (conf.darkUrl || conf.url) : (conf.lightUrl || conf.url);
    if (nextUrl) {
      map.setStyle(nextUrl);
      if (state.is3D || conf.is3D) {
        setTimeout(() => enable3DView(true), 400);
      }
    }
  } else if (conf.type === "raster-composite") {
    if (state.activeLayer !== "sat-hybrid") {
      $("map")?.classList.toggle("map-dark-theme", nextTheme === "dark");
    }
  }
}

function initTheme() {
  const getPreferredTheme = () => {
    try {
      const saved = localStorage.getItem("maps-theme");
      if (saved) return saved;
    } catch {}
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("maps-theme", theme); } catch {}
  };

  applyTheme(getPreferredTheme());

  $("theme-toggle")?.addEventListener("click", toggleTheme);
  $("theme-toggle-fab")?.addEventListener("click", toggleTheme);
}
initTheme();

/* ---------- Styles Cartographiques Unifiés (S'adaptent au mode Clair/Sombre) ---------- */
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

// Initialisation de MapLibre avec OpenFreeMap par défaut
const initialLayer = (() => {
  try {
    let saved = localStorage.getItem("maps-layer");
    if (saved === "ofm-bright" || saved === "ofm-dark") saved = "openfreemap";
    if (saved === "ofm-3d") saved = "openfreemap-3d";
    if (saved && MAP_STYLES[saved]) return saved;
  } catch {}
  return "openfreemap";
})();

const initialIsDark = (() => {
  try {
    const saved = localStorage.getItem("maps-theme");
    if (saved) return saved === "dark";
  } catch {}
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
})();

const map = new maplibregl.Map({
  container: "map",
  style: initialIsDark
    ? (MAP_STYLES[initialLayer].darkUrl || "https://tiles.openfreemap.org/styles/dark")
    : (MAP_STYLES[initialLayer].lightUrl || "https://tiles.openfreemap.org/styles/bright"),
  center: [2.35, 46.8],
  zoom: 5,
});

function setupRouteLayers() {
  if (!map.getSource("route")) {
    map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  const layout = { "line-cap": "round", "line-join": "round" };
  if (!map.getLayer("route-casing")) {
    map.addLayer({
      id: "route-casing",
      type: "line",
      source: "route",
      layout,
      paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.9 },
    });
  }
  if (!map.getLayer("route-line")) {
    const color = MODES[state.mode]?.color || "#2563eb";
    map.addLayer({
      id: "route-line",
      type: "line",
      source: "route",
      layout,
      paint: { "line-color": ["get", "color"], "line-width": 5 },
    });
  }

  // Couches pour la visualisation en temps réel du raisonnement de l'algorithme A*
  if (!map.getSource("algo-explored")) {
    map.addSource("algo-explored", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  if (!map.getLayer("algo-explored-lines")) {
    map.addLayer({
      id: "algo-explored-lines",
      type: "line",
      source: "algo-explored",
      layout,
      paint: { "line-color": "#f59e0b", "line-width": 3.5, "line-opacity": 0.8 },
    });
  }

  if (!map.getSource("algo-frontier")) {
    map.addSource("algo-frontier", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
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
        "circle-opacity": 0.9,
      },
    });
  }

  if (state.activeRoute) {
    showCurrentRoute(false);
  }
}

function ensure3DBuildings() {
  if (!map.getSource("openmaptiles")) return;
  if (map.getLayer("building-3d") || map.getLayer("3d-buildings-extrusion")) return;

  const isDark = state.activeLayer === "ofm-dark" || document.documentElement.dataset.theme === "dark";
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
          "fill-extrusion-color": isDark ? "#283344" : "#e2e8f0",
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 14],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.82,
        },
      },
      firstSymbolId
    );
  } catch {}
}

map.on("load", () => {
  setupRouteLayers();
  state.activeLayer = initialLayer;
  if (MAP_STYLES[initialLayer].is3D) {
    enable3DView(true);
  }
  highlightActiveLayer(initialLayer);
});

map.on("style.load", () => {
  setupRouteLayers();
  if (state.is3D || MAP_STYLES[state.activeLayer]?.is3D) {
    ensure3DBuildings();
  }
});

/* Gestion du changement de style cartographique */
function switchBaseLayer(layerId) {
  if (layerId === "ofm-bright" || layerId === "ofm-dark") layerId = "openfreemap";
  if (layerId === "ofm-3d") layerId = "openfreemap-3d";

  const conf = MAP_STYLES[layerId] || MAP_STYLES["openfreemap"];
  state.activeLayer = layerId;
  const isDark = document.documentElement.dataset.theme === "dark";

  if (conf.type === "vector") {
    const url = isDark ? (conf.darkUrl || conf.url) : (conf.lightUrl || conf.url);
    map.setStyle(url);
    if (conf.is3D || state.is3D) {
      setTimeout(() => enable3DView(true), 400);
    } else {
      map.easeTo({ pitch: 0, duration: 600 });
    }
    $("map")?.classList.remove("map-dark-theme");
  } else if (conf.type === "raster-composite") {
    // Revenir sur le style OpenFreeMap de base et ajouter la source raster
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
        rasterBase: {
          type: "raster",
          tiles: [baseRasterUrl],
          tileSize: 256,
          maxzoom: 19,
        },
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

    map.setStyle(rasterStyle);
  }

  highlightActiveLayer(layerId);
  try { localStorage.setItem("maps-layer", layerId); } catch {}
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
    map.easeTo({
      pitch: 60,
      zoom: Math.max(currentZoom, 14.5),
      bearing: map.getBearing() || -15,
      duration: 1000,
    });
  } else {
    map.easeTo({ pitch: 0, duration: 600 });
  }
}

$("toggle-3d-btn")?.addEventListener("click", () => {
  if (state.activeLayer !== "openfreemap-3d" && !state.is3D) {
    switchBaseLayer("openfreemap-3d");
  } else {
    enable3DView(!state.is3D);
  }
});

// Tiroir de couches
const layersModal = $("layers-modal");
$("layers")?.addEventListener("click", () => {
  if (layersModal.hasAttribute("open")) {
    layersModal.removeAttribute("open");
  } else {
    layersModal.setAttribute("open", "");
  }
});
$("close-layers")?.addEventListener("click", () => layersModal.removeAttribute("open"));

document.querySelectorAll(".layer-card").forEach((card) => {
  card.addEventListener("click", () => {
    switchBaseLayer(card.dataset.layerId);
    layersModal.removeAttribute("open");
  });
});

/* Zoom controls */
$("zoom-in-btn")?.addEventListener("click", () => map.zoomIn({ duration: 300 }));
$("zoom-out-btn")?.addEventListener("click", () => map.zoomOut({ duration: 300 }));

/* Boussole */
const compassNeedle = $("compass-needle");
function updateCompassUI() {
  const bearing = map.getBearing();
  if (compassNeedle) compassNeedle.style.transform = `rotate(${-bearing}deg)`;
}
map.on("rotate", updateCompassUI);
map.on("move", updateCompassUI);

$("compass-btn")?.addEventListener("click", () => {
  map.easeTo({ bearing: 0, pitch: state.is3D ? 60 : 0, duration: 600 });
});

/* Suivi du cap */
const orientationBtn = $("orientation-btn");
function toggleOrientationFollow() {
  state.followOrientation = !state.followOrientation;
  orientationBtn?.setAttribute("aria-pressed", String(state.followOrientation));

  if (!state.followOrientation) {
    if (orientationHandler) {
      window.removeEventListener("deviceorientation", orientationHandler);
      window.removeEventListener("deviceorientationabsolute", orientationHandler);
      orientationHandler = null;
    }
    say("Suivi d'orientation désactivé.");
    return;
  }

  say("Suivi d'orientation activé.");
  if (window.DeviceOrientationEvent) {
    orientationHandler = (e) => {
      if (!state.followOrientation) return;
      let heading = null;
      if (e.webkitCompassHeading != null) heading = e.webkitCompassHeading;
      else if (e.alpha != null) heading = 360 - e.alpha;
      if (heading != null) map.setBearing(heading);
    };

    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission()
        .then((perm) => {
          if (perm === "granted") window.addEventListener("deviceorientation", orientationHandler);
        })
        .catch(() => {});
    } else {
      window.addEventListener("deviceorientationabsolute", orientationHandler);
      window.addEventListener("deviceorientation", orientationHandler);
    }
  } else if (state.from && state.to) {
    const angle = Math.atan2(state.to.lng - state.from.lng, state.to.lat - state.from.lat) * (180 / Math.PI);
    map.easeTo({ bearing: angle, pitch: 45, duration: 800 });
  }
}
orientationBtn?.addEventListener("click", toggleOrientationFollow);

/* ---------- Icônes de manœuvre (SVG) ---------- */
function getManeuverSvg(step) {
  const m = step?.maneuver || {};
  const t = m.type || "";
  const mod = m.modifier || "";

  if (t === "depart") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
  }
  if (t === "arrive") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;
  }
  if (t === "roundabout" || t === "rotary") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="17 4 21 4 21 8"/></svg>`;
  }
  if (mod.includes("left")) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 19V9a4 4 0 0 0-4-4H6"/><polyline points="10 9 6 5 10 1"/></svg>`;
  }
  if (mod.includes("right")) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 19V9a4 4 0 0 1 4-4h8"/><polyline points="14 9 18 5 14 1"/></svg>`;
  }
  if (mod === "uturn") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a6 6 0 0 1-6 6H4"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
}

/* ---------- Recherche Intelligente (Proximité Prioritaire) ---------- */
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

function attachSuggest(input, list, onSelect) {
  let timer, seq = 0;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      list.hidden = true;
      return;
    }

    timer = setTimeout(async () => {
      const id = ++seq;
      try {
        const ref = getProximityRefPoint();
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10&lang=fr&lat=${ref.lat}&lon=${ref.lng}`);
        const data = await r.json();
        if (id !== seq) return;
        list.replaceChildren();

        const sorted = data.features.map((f) => {
          const coords = f.geometry.coordinates;
          const dist = hav([ref.lng, ref.lat], coords);
          return { f, dist };
        }).sort((a, b) => a.dist - b.dist);

        for (const { f, dist } of sorted) {
          const { main, sub, full } = parsePhotonProps(f.properties);
          const li = document.createElement("li");
          li.innerHTML = `
            <div class="suggest-item-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                <circle cx="12" cy="9" r="2.5"/>
              </svg>
            </div>
            <div class="suggest-item-text">
              <span class="suggest-item-main">${main}</span>
              ${sub ? `<span class="suggest-item-sub">${sub}</span>` : ""}
            </div>
            <span class="suggest-dist">${fmtDistance(dist)}</span>
          `;
          const selectItem = (e) => {
            e.preventDefault();
            e.stopPropagation();
            list.hidden = true;
            onSelect({
              lng: f.geometry.coordinates[0],
              lat: f.geometry.coordinates[1],
              label: full,
            });
          };
          li.addEventListener("pointerdown", selectItem);
          li.addEventListener("click", selectItem);
          list.append(li);
        }
        list.hidden = !list.children.length;
      } catch {
        list.hidden = true;
      }
    }, 280);
  });

  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 180));
}

// Recherche rapide supérieure (style Google Maps)
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
  map.flyTo({ center: [pt.lng, pt.lat], zoom: 15, duration: 800 });
  setPoint("to", pt);
  openRoutePanel();
});

// Catégories rapides
document.querySelectorAll(".category-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const q = chip.dataset.query;
    quickInput.value = chip.textContent.trim();
    if (quickClear) quickClear.hidden = false;
    const ref = getProximityRefPoint();
    fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10&lang=fr&lat=${ref.lat}&lon=${ref.lng}`)
      .then((r) => r.json())
      .then((data) => {
        quickList.replaceChildren();
        for (const f of data.features) {
          const { main, sub, full } = parsePhotonProps(f.properties);
          const dist = hav([ref.lng, ref.lat], f.geometry.coordinates);
          const li = document.createElement("li");
          li.innerHTML = `
            <div class="suggest-item-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
            </div>
            <div class="suggest-item-text">
              <span class="suggest-item-main">${main}</span>
              ${sub ? `<span class="suggest-item-sub">${sub}</span>` : ""}
            </div>
            <span class="suggest-dist">${fmtDistance(dist)}</span>
          `;
          const selectChipItem = (e) => {
            e.preventDefault();
            e.stopPropagation();
            quickList.hidden = true;
            map.flyTo({ center: f.geometry.coordinates, zoom: 16, duration: 800 });
            setPoint("to", { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], label: full });
            openRoutePanel();
          };
          li.addEventListener("pointerdown", selectChipItem);
          li.addEventListener("click", selectChipItem);
          quickList.append(li);
        }
        quickList.hidden = !quickList.children.length;
      })
      .catch(() => {});
  });
});

attachSuggest($("from"), $("from-list"), (pt) => setPoint("from", pt));
attachSuggest($("to"), $("to-list"), (pt) => setPoint("to", pt));

/* ---------- Boutons d'effacement & Inversion ---------- */
function updateClearButton(key) {
  const btn = $(`clear-${key}`);
  if (btn) btn.hidden = !$(key).value.trim();
}

$("from").addEventListener("input", () => updateClearButton("from"));
$("to").addEventListener("input", () => updateClearButton("to"));

function clearPoint(key) {
  state[key] = null;
  $(key).value = "";
  updateClearButton(key);
  markers[key]?.remove();
  markers[key] = null;
  $(`${key}-list`).hidden = true;
  map.getSource("route")?.setData({ type: "FeatureCollection", features: [] });
  $("route-box").hidden = true;
  $("criteria-selector").hidden = true;
  $("minimized-route-bar").hidden = true;
  for (const b of document.querySelectorAll("#modes button small")) b.textContent = "–";
  say("Point effacé.");
}

$("clear-from")?.addEventListener("click", () => clearPoint("from"));
$("clear-to")?.addEventListener("click", () => clearPoint("to"));

/* ---------- Marqueurs Cartographiques (Ancrage Précis au pixel près) ---------- */
function createCustomMarker(type, num) {
  const el = document.createElement("div");
  el.className = `custom-marker marker-${type}`;
  const color = type === "from" ? "#10b981" : type === "to" ? "#f43f5e" : "#8b5cf6";
  const innerContent = num != null
    ? `<circle cx="15" cy="15" r="8.5" fill="#ffffff"/><text x="15" y="19" text-anchor="middle" fill="${color}" font-size="12" font-weight="900" font-family="Figtree, system-ui, sans-serif">${num}</text>`
    : `<circle cx="15" cy="15" r="5.5" fill="#ffffff"/>`;

  el.innerHTML = `
    <svg width="30" height="40" viewBox="0 0 30 40" fill="none" style="display:block; overflow:visible;">
      <path d="M15 0 C6.716 0 0 6.716 0 15 C0 26.5 15 40 15 40 C15 40 30 26.5 30 15 C30 6.716 23.284 0 15 0 Z" fill="${color}" stroke="#ffffff" stroke-width="1.8"/>
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

/* ---------- Multi-étapes ---------- */
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
  if (line) line.style.minHeight = `${20 + count * 48}px`;
}

$("add-waypoint-btn")?.addEventListener("click", () => addWaypoint());

/* Clics carte pour ajouter des points */
map.on("click", (e) => {
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

/* Position actuelle */
$("locate")?.addEventListener("click", () => {
  if (!navigator.geolocation) {
    say("La géolocalisation n'est pas disponible.");
    return;
  }
  say("Localisation en cours…");
  $("locate").classList.add("is-active");
  navigator.geolocation.getCurrentPosition(
    (p) => {
      $("locate").classList.remove("is-active");
      say("");
      state.userLocation = { lng: p.coords.longitude, lat: p.coords.latitude };
      setPoint("from", { lng: p.coords.longitude, lat: p.coords.latitude, label: "Ma position actuelle" });
    },
    () => {
      $("locate").classList.remove("is-active");
      say("Position refusée.");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

$("recenter")?.addEventListener("click", () => {
  if (state.userLocation) {
    map.flyTo({ center: [state.userLocation.lng, state.userLocation.lat], zoom: 16, duration: 800 });
  } else if (state.from) {
    map.flyTo({ center: [state.from.lng, state.from.lat], zoom: 15, duration: 800 });
  } else {
    navigator.geolocation?.getCurrentPosition((p) => {
      state.userLocation = { lng: p.coords.longitude, lat: p.coords.latitude };
      map.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 16, duration: 800 });
    });
  }
});

$("swap")?.addEventListener("click", () => {
  const { from, to } = state;
  if (!from && !to) return;
  $("swap").classList.add("is-active");
  setTimeout(() => $("swap").classList.remove("is-active"), 350);

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

/* ---------- Navigation Panels & Google Maps Style Controls ---------- */
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
    map.flyTo({ center: [pt.lng, pt.lat], zoom: Math.max(map.getZoom(), 14), duration: 800 });
  }
}

/* ---------- Calcul d'Itinéraires Distincts (Rapide, Court, Économique, Sans autoroute) ---------- */
async function computeRoutes() {
  const run = ++runId;
  const pts = getAllActivePoints();
  if (pts.length < 2) return;

  say("Calcul des itinéraires optimisés…");
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
    if (visNodesCount) visNodesCount.textContent = "0";
    if (visFrontierCount) visFrontierCount.textContent = "0";
    if (visTimeMs) visTimeMs.textContent = "0 ms";
  }

  const onProgress = (p) => {
    if (visNodesCount) visNodesCount.textContent = String(p.stepsCount);
    if (visFrontierCount) visFrontierCount.textContent = String(p.frontierSize);
    if (visTimeMs) visTimeMs.textContent = `${p.elapsedMs} ms`;

    if (map.getSource("algo-explored") && p.exploredEdges.length) {
      map.getSource("algo-explored").setData({
        type: "FeatureCollection",
        features: p.exploredEdges.map((coords) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
        })),
      });
    }

    if (map.getSource("algo-frontier") && p.frontierNodes.length) {
      map.getSource("algo-frontier").setData({
        type: "FeatureCollection",
        features: p.frontierNodes.map((coords) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords },
        })),
      });
    }
  };

  try {
    const badge = $("algo-badge-status");
    if (badge) badge.textContent = "⚡ Hybride CH / A*";

    const useCH = state.useContraction !== false;

    // Calcul 100% autonome et local via le moteur hybride vectoriel sans API (factorisé : 1 graphe -> 4 critères)
    const routes = await window.ClientRouter.computeMultiCriteriaRoute(map, {
      from: state.from,
      to: state.to,
      waypoints: state.waypoints,
      mode: state.mode,
      criteria: ["fastest", "shortest", "eco", "nohighway"],
      visualize: state.visualizeAlgo,
      useContraction: useCH,
      onProgress,
    });

    if (run !== runId) return;

    const fastest = routes?.fastest;
    const shortest = routes?.shortest;
    const eco = routes?.eco;
    const nohighway = routes?.nohighway;

    if (badge) {
      badge.textContent = fastest?.algorithm === "hybrid-ch" ? "⚡ Hybride CH (Local)" : "⚡ Hybride A* (Local)";
    }

    state.routeCandidates = { fastest, shortest, eco, nohighway };
  } catch (err) {
    console.warn("ClientRouter error:", err);
    say("Erreur lors du calcul d'itinéraire.");
    return;
  } finally {
    if (visHud) visHud.hidden = true;
    setTimeout(() => {
      map.getSource("algo-explored")?.setData({ type: "FeatureCollection", features: [] });
      map.getSource("algo-frontier")?.setData({ type: "FeatureCollection", features: [] });
    }, 1200);
  }

  const fastest = state.routeCandidates.fastest;
  const shortest = state.routeCandidates.shortest;
  const eco = state.routeCandidates.eco;
  const nohighway = state.routeCandidates.nohighway;

  if (!fastest) {
    say("Aucun trajet trouvé. Essayez d'autres points.");
    return;
  }

  // Mise à jour de la durée du mode courant
  for (const b of document.querySelectorAll("#modes button")) {
    if (b.dataset.mode === state.mode) {
      b.querySelector("small").textContent = fmtDuration(fastest.duration);
    }
  }

  // Métadonnées d'affichage des critères
  $("crit-fastest-sub").textContent = fmtDuration(fastest.duration);
  $("crit-shortest-sub").textContent = fmtDistance(shortest.distance);

  const fuelL = (eco.distance / 1000) * 0.062;
  const fuelEur = fuelL * 1.85;
  $("crit-eco-sub").textContent = state.mode === "car" ? `${fuelL.toFixed(1)} L (${fuelEur.toFixed(1)} €)` : "0 L · 100% vert";

  const noHwEl = $("crit-nohighway-sub");
  if (noHwEl) {
    noHwEl.textContent = nohighway ? fmtDuration(nohighway.duration) : "–";
  }

  $("criteria-selector").hidden = false;
  $("algo-controls-card").hidden = false;
  updateCriteriaUI();

  showCurrentRoute(true);
}


function updateCriteriaUI() {
  document.querySelectorAll(".criteria-btn").forEach((btn) => {
    const isSelected = btn.dataset.criterion === state.criterion;
    btn.setAttribute("aria-pressed", String(isSelected));
  });
}

document.querySelectorAll(".criteria-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.criterion = btn.dataset.criterion;
    updateCriteriaUI();
    showCurrentRoute(false);
  });
});

/* Affichage effectif de la route choisie */
function showCurrentRoute(fit = false) {
  const r = state.routeCandidates[state.criterion] || state.routeCandidates.fastest;
  if (!r) return;

  state.activeRoute = r;
  say("");

  // Tracer la ligne sur la carte avec la couleur du mode
  const modeColor = MODES[state.mode].color;
  map.getSource("route")?.setData({
    type: "Feature",
    properties: { color: modeColor },
    geometry: r.geometry,
  });

  if (fit && r.geometry?.coordinates?.length) {
    const c = r.geometry.coordinates;
    const bounds = c.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
    const wide = window.innerWidth >= 720;
    map.fitBounds(bounds, {
      padding: wide ? { top: 70, bottom: 70, left: 440, right: 70 } : { top: 120, bottom: 120, left: 30, right: 30 },
      duration: 800,
    });
  }

  // Statistiques Hero
  const arrivalDate = new Date(Date.now() + r.duration * 1000);
  const arrivalTime = arrivalDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  $("route-duration-hero").textContent = fmtDuration(r.duration);
  $("route-distance-hero").textContent = fmtDistance(r.distance);
  $("route-eta-hero").textContent = `Arrivée à ${arrivalTime}`;

  // Pillule Essence / Éco
  const fuelEl = $("route-fuel-hero");
  if (state.mode === "car") {
    const fuelL = (r.distance / 1000) * 0.062;
    const fuelEur = fuelL * 1.85;
    fuelEl.textContent = `~${fuelL.toFixed(1)} L (${fuelEur.toFixed(1)} €)`;
    fuelEl.hidden = false;
  } else {
    fuelEl.hidden = true;
  }

  // Barre réduite Google Maps (minimized bottom card)
  $("min-mode-icon").textContent = state.mode === "car" ? "🚗" : state.mode === "bike" ? "🚲" : "🚶";
  $("min-duration").textContent = fmtDuration(r.duration);
  $("min-meta").textContent = `${fmtDistance(r.distance)} · arrivée ${arrivalTime}`;

  // Étapes turn-by-turn
  const allSteps = r.legs.flatMap((leg) => leg.steps || []);
  const ol = $("steps");
  ol.replaceChildren();

  for (const s of allSteps) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.className = "step-info";

    const iconWrap = document.createElement("div");
    iconWrap.className = "step-maneuver-icon";
    iconWrap.setAttribute("aria-hidden", "true");
    iconWrap.innerHTML = getManeuverSvg(s);

    const txt = document.createElement("div");
    txt.className = "step-text";
    txt.textContent = s.name ? `${s.maneuver?.type || "Direction"} sur ${s.name}` : (s.maneuver?.instruction || "Continuez");

    info.append(iconWrap, txt);
    li.append(info);

    if (s.distance > 0) {
      const dist = document.createElement("span");
      dist.className = "step-dist-pill";
      dist.textContent = fmtDistance(s.distance);
      li.append(dist);
    }
    ol.append(li);
  }

  $("route-box").hidden = false;
}

// Changement de mode de transport
for (const b of document.querySelectorAll("#modes button")) {
  b.addEventListener("click", () => {
    state.mode = b.dataset.mode;
    for (const btn of document.querySelectorAll("#modes button")) {
      const isSel = btn.dataset.mode === state.mode;
      btn.setAttribute("aria-pressed", String(isSel));
      btn.setAttribute("aria-selected", String(isSel));
    }
    computeRoutes();
  });
}

/* ---------- Guidage en temps réel avec Compteur Vitesse & Limites ---------- */
const nav = {
  on: false,
  watch: null,
  follow: true,
  centered: false,
  marker: null,
  off: 0,
  voice: true,
  wake: null,
  rerouting: false,
  said: new Set(),
};

function loadRoute(r) {
  nav.route = r;
  nav.geom = r.geometry.coordinates;
  nav.cum = [0];
  for (let i = 1; i < nav.geom.length; i++) nav.cum.push(nav.cum[i - 1] + hav(nav.geom[i - 1], nav.geom[i]));
  nav.total = nav.cum[nav.cum.length - 1] || 1;
  const scale = nav.total / (r.distance || nav.total);
  let acc = 0;
  nav.steps = r.legs?.flatMap((l) => l.steps || []) || [];

  // Si aucune étape fournie, générer automatiquement les étapes détaillées
  if (nav.steps.length === 0 && window.ClientRouter?.buildTurnByTurnInstructions) {
    nav.steps = window.ClientRouter.buildTurnByTurnInstructions(nav.geom, r.edges || [], state.mode);
  }
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
  let best = { d: Infinity, along: 0 };
  for (let i = 0; i < g.length - 1; i++) {
    const ax = (g[i][0] - pos[0]) * k * m, ay = (g[i][1] - pos[1]) * m;
    const dx = (g[i + 1][0] - pos[0]) * k * m - ax, dy = (g[i + 1][1] - pos[1]) * m - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.d) best = { d, along: nav.cum[i] + t * (nav.cum[i + 1] - nav.cum[i]) };
  }
  return best;
}

function speak(text, force = false) {
  if (!nav.voice) return;
  if (window.PiperTTS && typeof window.PiperTTS.speak === "function") {
    window.PiperTTS.speak(text, { force });
    return;
  }
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-FR";
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
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

  const name = step?.name || "";
  const ref = step?.ref || "";
  const text = `${name} ${ref}`.trim();

  if (window.ClientRouter?.resolveSpeedLimit) {
    return window.ClientRouter.resolveSpeedLimit(step?.roadClass || "street", step?.maxspeed, state.mode, loc, text);
  }

  return 50;
}

let simInterval = null;
let simDistance = 0;
let currentSimSpeedKmh = 0;

function stopDriveSimulation() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
  const btn = $("sim-btn");
  if (btn) btn.setAttribute("aria-pressed", "false");
}

function startDriveSimulation() {
  const r = state.activeRoute;
  if (!r) return;
  if (!nav.on) startNav();
  if (!nav.geom || nav.geom.length < 2) return;

  stopDriveSimulation();
  const btn = $("sim-btn");
  if (btn) btn.setAttribute("aria-pressed", "true");

  simDistance = 0;
  currentSimSpeedKmh = 15;

  simInterval = setInterval(() => {
    if (!nav.on) {
      stopDriveSimulation();
      return;
    }

    // Recherche du segment correspondant dans nav.geom
    let segIdx = 0;
    while (segIdx < nav.cum.length - 1 && nav.cum[segIdx + 1] < simDistance) {
      segIdx++;
    }

    if (segIdx >= nav.geom.length - 1 || simDistance >= nav.total) {
      // Fin du trajet atteinte
      onFix({
        coords: {
          longitude: nav.geom[nav.geom.length - 1][0],
          latitude: nav.geom[nav.geom.length - 1][1],
          speed: 0,
          heading: 0,
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

    // Calcul du cap en degrés
    const angleRad = Math.atan2(p2[0] - p1[0], p2[1] - p1[1]);
    const headingDeg = (angleRad * (180 / Math.PI) + 360) % 360;

    // Détermination de l'étape courante et de la limitation
    let stepIdx = nav.ends.findIndex((e) => e > simDistance);
    if (stepIdx < 0) stepIdx = nav.steps.length - 1;
    const currentStep = nav.steps[stepIdx];
    const limit = estimateSpeedLimit(currentStep);

    // Ajustement dynamique de la vitesse (freinage à l'approche du virage)
    const distToTurn = Math.max(0, nav.ends[stepIdx] - simDistance);
    let targetSpeed = limit;
    if (distToTurn < 60) {
      targetSpeed = Math.min(limit, 28);
    } else if (distToTurn < 120) {
      targetSpeed = Math.min(limit, 42);
    }

    // Accélération / Décélération lissée
    if (currentSimSpeedKmh < targetSpeed) {
      currentSimSpeedKmh = Math.min(targetSpeed, currentSimSpeedKmh + 3.8);
    } else if (currentSimSpeedKmh > targetSpeed) {
      currentSimSpeedKmh = Math.max(targetSpeed, currentSimSpeedKmh - 4.5);
    }

    // Fluctuation naturelle vivante (ex: +- 1.5 km/h)
    const displaySpeed = Math.max(0, Math.round(currentSimSpeedKmh + Math.sin(Date.now() / 700) * 1.5));
    const speedMs = displaySpeed / 3.6;

    // Incrément de distance à vitesse x3.5 pour fluidité de démo
    const timeDeltaSec = 0.25 * 3.5;
    simDistance += speedMs * timeDeltaSec;

    onFix({
      coords: {
        longitude: lng,
        latitude: lat,
        speed: speedMs,
        heading: headingDeg,
      },
    });
  }, 250);
}

function toggleDriveSimulation() {
  if (simInterval) {
    stopDriveSimulation();
  } else {
    startDriveSimulation();
  }
}

function startNav() {
  const r = state.activeRoute;
  if (!r) return;
  loadRoute(r);
  Object.assign(nav, { on: true, follow: true, centered: false, off: 0, rerouting: false });
  nav.said.clear();

  $("banner-dist").textContent = "-- m";
  $("banner-text").textContent = "Recherche du signal GPS…";
  $("banner-icon-wrap").innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;

  $("eta").textContent = "--:--";
  $("eta-sub").textContent = "Calcul de l'arrivée…";

  // Initialisation du compteur et limitation
  $("current-speed-val").textContent = "0";
  const initialLimit = estimateSpeedLimit(nav.steps[0]);
  state.speedLimitKmh = initialLimit;
  $("speed-limit-val").textContent = String(initialLimit);

  document.body.classList.add("navigating");
  requestWake();

  if (navigator.geolocation) {
    nav.watch = navigator.geolocation.watchPosition(onFix, onFixError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
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
  nav.marker?.remove();
  nav.marker = null;
  nav.wake?.release?.().catch(() => {});
  nav.wake = null;
  window.PiperTTS?.stop();
  window.speechSynthesis?.cancel();
  document.body.classList.remove("navigating");
  map.easeTo({ bearing: 0, pitch: state.is3D ? 60 : 0 });
  say(msg || "");
}

function onFixError(err) {
  if (err.code === 1) stopNav("Position refusée.");
  else $("banner-text").textContent = "Signal GPS temporairement indisponible…";
}

function onFix(p) {
  if (!nav.on) return;
  const pos = [p.coords.longitude, p.coords.latitude];

  if (!nav.marker) {
    const el = document.createElement("div");
    el.className = "me";
    nav.marker = new maplibregl.Marker({ element: el }).setLngLat(pos).addTo(map);
  } else {
    nav.marker.setLngLat(pos);
  }

  // Calcul et affichage de la vitesse réelle en km/h
  const rawSpeed = p.coords.speed;
  const speedKmh = rawSpeed != null && !isNaN(rawSpeed) && rawSpeed >= 0 ? Math.round(rawSpeed * 3.6) : 0;
  state.currentSpeedKmh = speedKmh;
  $("current-speed-val").textContent = String(speedKmh);

  const s = snap(pos);
  const remaining = Math.max(0, nav.total - s.along);
  if (remaining < 25) {
    speak("Vous êtes arrivé à destination.", true);
    stopNav("Vous êtes arrivé à destination.");
    return;
  }

  // Détection de déviation / sortie de trajet (> 45m pendant plus de 3 fixes)
  if (s.d > 45 && !nav.rerouting) {
    nav.off = (nav.off || 0) + 1;
    if (nav.off >= 3) {
      nav.rerouting = true;
      speak("Recalcul de l'itinéraire en cours…", true);
      $("banner-text").textContent = "Recalcul de l'itinéraire…";
      state.from = { lng: pos[0], lat: pos[1], label: "Position GPS" };
      computeRoutes().then(() => {
        nav.rerouting = false;
        nav.off = 0;
        if (state.activeRoute) {
          loadRoute(state.activeRoute);
        }
      });
      return;
    }
  } else {
    nav.off = 0;
  }

  let i = nav.ends.findIndex((e) => e > s.along);
  if (i < 0) i = nav.steps.length - 1;

  // L'étape sur laquelle on circule ACTUELLEMENT
  const currentStep = nav.steps[i] || nav.steps[0];
  // La prochaine étape visée par la manœuvre
  const next = nav.steps[Math.min(i + 1, nav.steps.length - 1)];
  const toNext = Math.max(0, (nav.ends[i] || 0) - s.along);
  const instructionText = next?.maneuver?.instruction || (next?.name ? `Prenez ${next.name}` : "Continuez tout droit");

  // Vitesse maximale autorisée de la ROUTE ACTUELLE (et non la suivante)
  const speedLimit = estimateSpeedLimit(currentStep);
  state.speedLimitKmh = speedLimit;
  $("speed-limit-val").textContent = String(speedLimit);

  // Alerte visuelle de dépassement de vitesse
  const speedPill = $("speedometer-pill");
  if (speedPill) {
    speedPill.classList.toggle("speeding", speedKmh > speedLimit + 3);
  }

  if (!nav.rerouting) {
    $("banner-dist").textContent = fmtDistance(toNext);
    $("banner-text").textContent = instructionText;
    $("banner-icon-wrap").innerHTML = getManeuverSvg(next);
  }

  // Annonce vocale proactive intelligente (à 300m puis à 60m)
  if (nav.voice && next && toNext > 0) {
    const stepKey = `step-${i}`;
    const now = Date.now();
    const timeSinceLastSpoken = now - (nav.lastSpeakTime || 0);

    if (toNext <= 320 && toNext > 120 && !nav.said.has(`${stepKey}-300`)) {
      if (timeSinceLastSpoken > 3500) {
        nav.said.add(`${stepKey}-300`);
        nav.lastSpeakTime = now;
        speak(`Dans 300 mètres, ${instructionText}`);
      }
    } else if (toNext <= 65 && toNext > 12 && !nav.said.has(`${stepKey}-now`)) {
      if (timeSinceLastSpoken > 2800) {
        nav.said.add(`${stepKey}-now`);
        nav.lastSpeakTime = now;
        speak(instructionText);
      }
    }
  }

  const sec = (nav.route.duration * remaining) / nav.total;
  const arrival = new Date(Date.now() + sec * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  $("eta").textContent = arrival;
  $("eta-sub").textContent = `${fmtDuration(sec)} restantes · ${fmtDistance(remaining)}`;

  if (nav.follow) {
    const opts = { center: pos, duration: 900 };
    if (!nav.centered) {
      opts.zoom = 17;
      nav.centered = true;
    }
    if (p.coords.heading != null && !Number.isNaN(p.coords.heading) && (p.coords.speed || 0) > 1) {
      opts.bearing = p.coords.heading;
    }
    map.easeTo(opts);
  }
}

function cancelTrip() {
  if (nav.on) {
    stopNav();
  }

  state.from = null;
  state.to = null;
  state.waypoints = [];
  state.activeRoute = null;
  state.routeCandidates = {};

  const fromInput = $("from");
  const toInput = $("to");
  if (fromInput) fromInput.value = "";
  if (toInput) toInput.value = "";
  $("clear-from")?.setAttribute("hidden", "");
  $("clear-to")?.setAttribute("hidden", "");

  const quickSearchInput = $("quick-search-input");
  if (quickSearchInput) quickSearchInput.value = "";
  $("quick-clear-btn")?.setAttribute("hidden", "");

  const wpContainer = $("waypoints-container");
  if (wpContainer) wpContainer.innerHTML = "";

  if (markers.from) {
    markers.from.remove();
    markers.from = null;
  }
  if (markers.to) {
    markers.to.remove();
    markers.to = null;
  }
  for (const id in markers.waypoints) {
    markers.waypoints[id]?.remove();
  }
  markers.waypoints = {};

  if (map.getSource("route")) {
    map.getSource("route").setData({ type: "FeatureCollection", features: [] });
  }
  map.getSource("algo-explored")?.setData({ type: "FeatureCollection", features: [] });
  map.getSource("algo-frontier")?.setData({ type: "FeatureCollection", features: [] });
  $("algo-vis-hud")?.setAttribute("hidden", "");

  $("route-box")?.setAttribute("hidden", "");
  $("criteria-selector")?.setAttribute("hidden", "");
  $("algo-controls-card")?.setAttribute("hidden", "");
  $("minimized-route-bar")?.setAttribute("hidden", "");

  const routeDurationHero = $("route-duration-hero");
  if (routeDurationHero) routeDurationHero.textContent = "--";
  const routeDistanceHero = $("route-distance-hero");
  if (routeDistanceHero) routeDistanceHero.textContent = "-- km";
  const stepsList = $("steps");
  if (stepsList) stepsList.innerHTML = "";

  $("panel")?.setAttribute("hidden", "");
  $("top-search-bar")?.removeAttribute("hidden");

  say("Itinéraire annulé.");
}

$("start")?.addEventListener("click", startNav);
$("min-start-btn")?.addEventListener("click", startNav);
$("stop")?.addEventListener("click", () => stopNav("Guidage arrêté."));

$("cancel-route-btn")?.addEventListener("click", cancelTrip);
$("cancel-route-action-btn")?.addEventListener("click", cancelTrip);
$("min-cancel-btn")?.addEventListener("click", cancelTrip);

/* ---------- Paramètres (Moteur Hybride & Voix Réelles) ---------- */
function syncAlgoUI() {
  const crit = state.criterion || "fastest";
  if ($("settings-criterion-select")) $("settings-criterion-select").value = crit;
  if ($("algo-criterion-select")) $("algo-criterion-select").value = crit;
  if ($("settings-ch-toggle")) $("settings-ch-toggle").checked = state.useContraction !== false;

  const badge = $("algo-badge-status");
  if (badge) {
    badge.textContent = state.useContraction !== false ? "⚡ Hybride CH (Local)" : "⚡ Hybride A* (Local)";
  }
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

  // 1. Voix Belges en priorité
  if (voicesData.belgian && voicesData.belgian.length > 0) {
    const groupBe = document.createElement("optgroup");
    groupBe.label = "🇧🇪 Français (Belgique)";
    voicesData.belgian.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = `web:${v.voiceURI}`;
      opt.textContent = v.displayName;
      if (activeUri === v.voiceURI || activeVoiceName === `web:${v.voiceURI}`) {
        opt.selected = true;
        matched = true;
      }
      groupBe.appendChild(opt);
    });
    select.appendChild(groupBe);
  }

  // 2. Voix Françaises (France)
  if (voicesData.french && voicesData.french.length > 0) {
    const groupFr = document.createElement("optgroup");
    groupFr.label = "🇫🇷 Français (France)";
    voicesData.french.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = `web:${v.voiceURI}`;
      opt.textContent = v.displayName;
      if (!matched && (activeUri === v.voiceURI || activeVoiceName === `web:${v.voiceURI}`)) {
        opt.selected = true;
        matched = true;
      }
      groupFr.appendChild(opt);
    });
    select.appendChild(groupFr);
  }

  // 3. Autres voix francophones (Canada, etc.)
  if (voicesData.otherFr && voicesData.otherFr.length > 0) {
    const groupOther = document.createElement("optgroup");
    groupOther.label = "🌐 Autres Voix Françaises";
    voicesData.otherFr.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = `web:${v.voiceURI}`;
      opt.textContent = v.displayName;
      if (!matched && (activeUri === v.voiceURI || activeVoiceName === `web:${v.voiceURI}`)) {
        opt.selected = true;
        matched = true;
      }
      groupOther.appendChild(opt);
    });
    select.appendChild(groupOther);
  }

  // 4. Modèles neuronaux Piper ONNX (si le backend local est actif)
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

  // Si aucune voix n'était encore sélectionnée, choisir la première option disponible
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
      badge.title = "Synthèse vocale native Piper ONNX exécutée localement";
    } else {
      badge.textContent = "✨ Voix HD Réelle";
      badge.className = "engine-badge web-hd";
      badge.title = `Synthèse vocale active : ${current.webVoiceName}`;
    }
  }

  if (details) {
    if (current.backendAvailable && !current.selectedVoiceURI) {
      details.textContent = `Moteur Piper ONNX actif · Modèle ${current.voiceId} · Rendu neural studio haute fidélité.`;
    } else {
      details.textContent = `Voix active : ${current.webVoiceName} · Prosodie GPS fluide & égalisation acoustique anti-sifflement.`;
    }
  }
}

window.addEventListener("piper-engine-status", (e) => updateVoiceEngineUI(e.detail));
window.addEventListener("piper-voices-ready", populateVoiceSelect);
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    populateVoiceSelect();
  };
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
  try { localStorage.setItem("mon_maps_criterion", newCriterion); } catch {}
  syncAlgoUI();
  const pts = getAllActivePoints();
  if (pts.length >= 2 && state.from && state.to) {
    computeRoutes();
  }
}

$("open-settings-quick-btn")?.addEventListener("click", openSettingsModal);
$("open-settings-panel-btn")?.addEventListener("click", openSettingsModal);
$("settings-fab-btn")?.addEventListener("click", openSettingsModal);
$("close-settings")?.addEventListener("click", () => $("settings-modal")?.close());
$("settings-modal")?.addEventListener("click", (e) => {
  if (e.target === $("settings-modal")) $("settings-modal").close();
});

$("settings-criterion-select")?.addEventListener("change", (e) => handleCriterionChange(e.target.value));
$("algo-criterion-select")?.addEventListener("change", (e) => handleCriterionChange(e.target.value));

$("settings-ch-toggle")?.addEventListener("change", (e) => {
  state.useContraction = e.target.checked;
  try { localStorage.setItem("mon_maps_use_ch", String(e.target.checked)); } catch {}
  if (window.ClientRouter?.ROUTER_CONFIG) {
    window.ClientRouter.ROUTER_CONFIG.useContraction = e.target.checked;
  }
  syncAlgoUI();
  const pts = getAllActivePoints();
  if (pts.length >= 2 && state.from && state.to) {
    computeRoutes();
  }
});

$("settings-vis-toggle")?.addEventListener("change", (e) => {
  state.visualizeAlgo = e.target.checked;
  if ($("algo-live-vis-toggle")) $("algo-live-vis-toggle").checked = e.target.checked;
  try { localStorage.setItem("mon_maps_vis_algo", String(state.visualizeAlgo)); } catch {}
});
$("algo-live-vis-toggle")?.addEventListener("change", (e) => {
  state.visualizeAlgo = e.target.checked;
  if ($("settings-vis-toggle")) $("settings-vis-toggle").checked = e.target.checked;
  try { localStorage.setItem("mon_maps_vis_algo", String(state.visualizeAlgo)); } catch {}
  const pts = getAllActivePoints();
  if (pts.length >= 2 && state.from && state.to) {
    computeRoutes();
  }
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
  try { localStorage.setItem("mon_maps_roundabouts", String(e.target.checked)); } catch {}
});

$("settings-announce-carrefours")?.addEventListener("change", (e) => {
  state.announceCarrefours = e.target.checked;
  try { localStorage.setItem("mon_maps_carrefours", String(e.target.checked)); } catch {}
});

syncAlgoUI();
populateVoiceSelect();

$("algo-vis-skip-btn")?.addEventListener("click", () => {
  window.__algoSkipRequested = true;
});

$("sim-btn")?.addEventListener("click", toggleDriveSimulation);
$("speedometer-pill")?.addEventListener("click", toggleDriveSimulation);
$("speed-limit-badge")?.addEventListener("click", () => {
  // Cycle manuel de test des limitations autorisées
  const limits = [30, 50, 70, 80, 90, 110, 130];
  const curIdx = limits.indexOf(state.speedLimitKmh);
  const nextLimit = limits[(curIdx + 1) % limits.length];
  state.speedLimitKmh = nextLimit;
  $("speed-limit-val").textContent = String(nextLimit);
  $("speedometer-pill")?.classList.toggle("speeding", state.currentSpeedKmh > nextLimit + 3);
});

$("mute")?.addEventListener("click", () => {
  nav.voice = !nav.voice;
  $("mute").setAttribute("aria-pressed", String(nav.voice));
  if (!nav.voice) {
    window.PiperTTS?.stop();
    window.speechSynthesis?.cancel();
  }
});

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js?v=12")
      .then((reg) => reg.update())
      .catch(() => {});
  });
}
