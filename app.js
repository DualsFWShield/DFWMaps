"use strict";

/* ==========================================================================
   Mon Maps · Client Logic & Navigation Engine
   ========================================================================== */

const MODES = {
  car:  { label: "Voiture", path: "routed-car",  color: "#2563eb" },
  bike: { label: "Vélo",    path: "routed-bike", color: "#059669" },
  foot: { label: "À pied",  path: "routed-foot", color: "#ea580c" },
};

const $ = (id) => document.getElementById(id);
const state = { from: null, to: null, mode: "car", routes: {} };
const markers = {};
let runId = 0;

/* ---------- Thème (Clair / Sombre) ---------- */
function initTheme() {
  const toggleBtn = $("theme-toggle");
  if (!toggleBtn) return;

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

  toggleBtn.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    applyTheme(current === "dark" ? "light" : "dark");
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    try {
      if (!localStorage.getItem("maps-theme")) {
        applyTheme(e.matches ? "dark" : "light");
      }
    } catch {}
  });
}
initTheme();

/* ---------- Carte (MapLibre GL JS) ---------- */
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© les contributeurs d'OpenStreetMap",
      },
      sat: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagerie © Esri, Maxar, Earthstar Geographics",
      },
      "sat-labels": {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
      },
    },
    layers: [
      { id: "osm", type: "raster", source: "osm" },
      { id: "sat", type: "raster", source: "sat", layout: { visibility: "none" } },
      { id: "sat-labels", type: "raster", source: "sat-labels", layout: { visibility: "none" } },
    ],
  },
  center: [2.35, 46.8],
  zoom: 5,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

map.on("load", () => {
  map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const layout = { "line-cap": "round", "line-join": "round" };
  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "route",
    layout,
    paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    layout,
    paint: { "line-color": ["get", "color"], "line-width": 5 },
  });
});

map.on("click", (e) => {
  const key = state.from ? "to" : "from";
  const pt = { lng: e.lngLat.lng, lat: e.lngLat.lat, label: `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}` };
  setPoint(key, pt);
  reverse(key, pt);
});

/* ---------- Formatages ---------- */
function fmtDuration(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

const say = (text) => { $("status").textContent = text; };

/* ---------- Icônes de manœuvre (SVG) ---------- */
function getManeuverSvg(step) {
  const m = step.maneuver || {};
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
  // Tout droit / Continuer
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
}

/* ---------- Géocodage (Photon) ---------- */
function parsePhotonProps(p) {
  const street = [p.housenumber, p.street].filter(Boolean).join(" ");
  const main = p.name || street || p.city || "Adresse";
  const sub = [...new Set([street !== main ? street : null, p.postcode, p.city, p.state, p.country].filter(Boolean))].join(", ");
  const full = [...new Set([main, sub].filter(Boolean))].join(", ");
  return { main, sub, full };
}

async function reverse(key, pt) {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lon=${pt.lng}&lat=${pt.lat}&lang=fr`);
    const f = (await r.json()).features?.[0];
    if (f && state[key] === pt) {
      const parsed = parsePhotonProps(f.properties);
      pt.label = parsed.full || pt.label;
      $(key).value = pt.label;
      updateClearButton(key);
    }
  } catch { /* coordonnées conservées */ }
}

function updateClearButton(key) {
  const btn = $(`clear-${key}`);
  if (btn) btn.hidden = !$(key).value.trim();
}

function clearPoint(key) {
  state[key] = null;
  $(key).value = "";
  updateClearButton(key);
  markers[key]?.remove();
  markers[key] = null;
  $(`${key}-list`).hidden = true;
  map.getSource("route")?.setData({ type: "FeatureCollection", features: [] });
  $("route-box").hidden = true;
  for (const b of document.querySelectorAll("#modes button small")) {
    b.textContent = "–";
  }
  say("Point effacé. Choisissez un point sur la carte ou saisissez une adresse.");
}

$("clear-from")?.addEventListener("click", () => clearPoint("from"));
$("clear-to")?.addEventListener("click", () => clearPoint("to"));

function attachSuggest(key) {
  const input = $(key);
  const list = $(`${key}-list`);
  let timer, seq = 0;

  input.addEventListener("input", () => {
    updateClearButton(key);
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) {
      list.hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      const id = ++seq;
      try {
        const c = map.getCenter();
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lang=fr&lat=${c.lat}&lon=${c.lng}`);
        const data = await r.json();
        if (id !== seq) return;
        list.replaceChildren();

        for (const f of data.features) {
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
          `;
          li.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            list.hidden = true;
            setPoint(key, {
              lng: f.geometry.coordinates[0],
              lat: f.geometry.coordinates[1],
              label: full,
            });
          });
          list.append(li);
        }
        list.hidden = !list.children.length;
      } catch {
        list.hidden = true;
      }
    }, 320);
  });

  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 180));
}
attachSuggest("from");
attachSuggest("to");

/* ---------- Marqueurs visuels personnalisés ---------- */
function createCustomMarker(key) {
  const el = document.createElement("div");
  el.className = `custom-marker marker-${key}`;
  el.innerHTML = `
    <div class="marker-pin">
      <div class="marker-dot"></div>
    </div>
  `;
  return el;
}

/* ---------- Points de départ / d'arrivée ---------- */
function setPoint(key, pt) {
  state[key] = pt;
  $(key).value = pt.label;
  updateClearButton(key);

  markers[key]?.remove();
  const markerEl = createCustomMarker(key);
  markers[key] = new maplibregl.Marker({ element: markerEl, anchor: "bottom" })
    .setLngLat([pt.lng, pt.lat])
    .addTo(map);

  if (state.from && state.to) {
    computeRoutes();
  } else {
    map.flyTo({ center: [pt.lng, pt.lat], zoom: Math.max(map.getZoom(), 14), duration: 800 });
  }
}

$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    say("La géolocalisation n'est pas disponible sur cet appareil.");
    return;
  }
  say("Localisation en cours…");
  $("locate").classList.add("is-active");
  navigator.geolocation.getCurrentPosition(
    (p) => {
      $("locate").classList.remove("is-active");
      say("");
      setPoint("from", { lng: p.coords.longitude, lat: p.coords.latitude, label: "Ma position actuelle" });
    },
    () => {
      $("locate").classList.remove("is-active");
      say("Position refusée. Autorisez la localisation dans votre navigateur.");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

$("swap").addEventListener("click", () => {
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

/* ---------- Itinéraires (OSRM) ---------- */
async function computeRoutes() {
  const run = ++runId;
  const { from, to } = state;
  say("Calcul des itinéraires en cours…");
  $("route-box").hidden = true;
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;

  const results = await Promise.all(Object.entries(MODES).map(async ([k, m]) => {
    try {
      const r = await fetch(`https://routing.openstreetmap.de/${m.path}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`);
      const d = await r.json();
      return [k, d.code === "Ok" ? d.routes[0] : null];
    } catch {
      return [k, null];
    }
  }));

  if (run !== runId) return; // annulation si requête plus récente

  state.routes = Object.fromEntries(results);
  for (const b of document.querySelectorAll("#modes button")) {
    const r = state.routes[b.dataset.mode];
    b.querySelector("small").textContent = r ? fmtDuration(r.duration) : "–";
  }

  if (!Object.values(state.routes).some(Boolean)) {
    say("Aucun trajet trouvé pour ces points. Réessayez avec d'autres coordonnées.");
    return;
  }
  showMode(state.mode, true);
}

const MOD = {
  left: "à gauche",
  "slight left": "légèrement à gauche",
  "sharp left": "franchement à gauche",
  right: "à droite",
  "slight right": "légèrement à droite",
  "sharp right": "franchement à droite",
  straight: "tout droit",
  uturn: "demi-tour",
};

function stepText(s) {
  const m = s.maneuver || {}, on = s.name ? ` sur ${s.name}` : "", mod = MOD[m.modifier] || "";
  switch (m.type) {
    case "depart": return `Partez${on}`;
    case "arrive": return "Vous êtes arrivé à destination";
    case "roundabout": case "rotary": return `Au rond-point, prenez la sortie ${m.exit || ""}${on}`.replace("  ", " ");
    case "merge": return `Insérez-vous${on}`;
    case "fork": return `Restez ${mod}${on}`;
    default:
      if (m.modifier === "uturn") return `Faites demi-tour${on}`;
      if (!m.modifier || m.modifier === "straight") return `Continuez tout droit${on}`;
      return `Tournez ${mod}${on}`;
  }
}

function showMode(mode, fit = false) {
  state.mode = mode;
  for (const b of document.querySelectorAll("#modes button")) {
    const isSelected = b.dataset.mode === mode;
    b.setAttribute("aria-pressed", String(isSelected));
    b.setAttribute("aria-selected", String(isSelected));
  }
  const r = state.routes[mode];
  const src = map.getSource("route");

  if (!r) {
    src?.setData({ type: "FeatureCollection", features: [] });
    $("route-box").hidden = true;
    if (state.from && state.to) say(`Pas d'itinéraire ${MODES[mode].label.toLowerCase()} disponible.`);
    return;
  }

  say("");
  src?.setData({ type: "Feature", properties: { color: MODES[mode].color }, geometry: r.geometry });

  if (fit) {
    const c = r.geometry.coordinates;
    const bounds = c.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
    const wide = window.innerWidth >= 720;
    map.fitBounds(bounds, {
      padding: wide ? { top: 70, bottom: 70, left: 440, right: 70 } : { top: 320, bottom: 60, left: 40, right: 40 },
      duration: 800,
    });
  }

  // Statistiques Hero
  const arrivalDate = new Date(Date.now() + r.duration * 1000);
  const arrivalTime = arrivalDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  $("route-duration-hero").textContent = fmtDuration(r.duration);
  $("route-distance-hero").textContent = fmtDistance(r.distance);
  $("route-eta-hero").textContent = `Arrivée à ${arrivalTime}`;

  // Liste des étapes (Turn-by-turn)
  const ol = $("steps");
  ol.replaceChildren();

  for (const s of r.legs[0].steps) {
    const li = document.createElement("li");

    const info = document.createElement("div");
    info.className = "step-info";

    const iconWrap = document.createElement("div");
    iconWrap.className = "step-maneuver-icon";
    iconWrap.setAttribute("aria-hidden", "true");
    iconWrap.innerHTML = getManeuverSvg(s);

    const txt = document.createElement("div");
    txt.className = "step-text";
    txt.textContent = stepText(s);

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

  if (window.innerWidth < 720) {
    $("steps-wrap").removeAttribute("open");
  } else {
    $("steps-wrap").setAttribute("open", "");
  }
  $("route-box").hidden = false;
}

for (const b of document.querySelectorAll("#modes button")) {
  b.addEventListener("click", () => showMode(b.dataset.mode, true));
}

/* ---------- Vue Satellite ---------- */
function setSatellite(on) {
  for (const id of ["sat", "sat-labels"]) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  map.setLayoutProperty("osm", "visibility", on ? "none" : "visible");
  $("layers").setAttribute("aria-pressed", String(on));
  $("layers").title = on ? "Vue plan standard" : "Vue satellite";
  try { localStorage.setItem("maps-sat", on ? "1" : "0"); } catch {}
}

map.on("load", () => {
  try { if (localStorage.getItem("maps-sat") === "1") setSatellite(true); } catch {}
});
$("layers").addEventListener("click", () => setSatellite($("layers").getAttribute("aria-pressed") !== "true"));

/* ---------- Guidage en temps réel ---------- */
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

function hav(a, b) {
  const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

function loadRoute(r) {
  nav.route = r;
  nav.geom = r.geometry.coordinates;
  nav.cum = [0];
  for (let i = 1; i < nav.geom.length; i++) nav.cum.push(nav.cum[i - 1] + hav(nav.geom[i - 1], nav.geom[i]));
  nav.total = nav.cum[nav.cum.length - 1] || 1;
  const scale = nav.total / (r.distance || nav.total);
  let acc = 0;
  nav.steps = r.legs[0].steps;
  nav.ends = nav.steps.map((s) => (acc += s.distance * scale));
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

function speak(text) {
  if (!nav.voice || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-FR";
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

async function requestWake() {
  try { nav.wake = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (nav.on && document.visibilityState === "visible") requestWake();
});

function startNav() {
  const r = state.routes[state.mode];
  if (!r) return;
  if (!navigator.geolocation) {
    say("La géolocalisation n'est pas disponible sur cet appareil.");
    return;
  }
  loadRoute(r);
  Object.assign(nav, { on: true, follow: true, centered: false, off: 0, rerouting: false });
  nav.said.clear();

  $("banner-dist").textContent = "-- m";
  $("banner-text").textContent = "Recherche du signal GPS…";
  $("banner-icon-wrap").innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;

  $("eta").textContent = "--:--";
  $("eta-sub").textContent = "Calcul de l'arrivée…";
  $("recenter").hidden = true;

  document.body.classList.add("navigating");
  requestWake();

  nav.watch = navigator.geolocation.watchPosition(onFix, onFixError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
}

function stopNav(msg) {
  nav.on = false;
  if (nav.watch !== null) navigator.geolocation.clearWatch(nav.watch);
  nav.watch = null;
  nav.marker?.remove();
  nav.marker = null;
  nav.wake?.release?.().catch(() => {});
  nav.wake = null;
  window.speechSynthesis?.cancel();
  document.body.classList.remove("navigating");
  $("recenter").hidden = true;
  map.easeTo({ bearing: 0, pitch: 0 });
  say(msg || "");
}

function onFixError(err) {
  if (err.code === 1) stopNav("Position refusée. Autorisez la localisation pour utiliser le guidage.");
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

  const s = snap(pos);
  nav.off = s.d > Math.max(40, (p.coords.accuracy || 0) * 1.5) ? nav.off + 1 : 0;
  if (nav.off >= 3 && !nav.rerouting) {
    reroute(pos);
    return;
  }

  const remaining = Math.max(0, nav.total - s.along);
  if (remaining < 25) {
    speak("Vous êtes arrivé à destination.");
    stopNav("Vous êtes arrivé à destination.");
    return;
  }

  let i = nav.ends.findIndex((e) => e > s.along);
  if (i < 0) i = nav.steps.length - 1;
  const next = nav.steps[Math.min(i + 1, nav.steps.length - 1)];
  const toNext = Math.max(0, nav.ends[i] - s.along);
  const text = stepText(next);

  if (!nav.rerouting) {
    $("banner-dist").textContent = fmtDistance(toNext);
    $("banner-text").textContent = text;
    $("banner-icon-wrap").innerHTML = getManeuverSvg(next);
  }

  const sec = (nav.route.duration * remaining) / nav.total;
  const arrival = new Date(Date.now() + sec * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  $("eta").textContent = arrival;
  $("eta-sub").textContent = `${fmtDuration(sec)} restantes · ${fmtDistance(remaining)}`;

  // Guidage vocal intelligent
  const far = state.mode === "car" ? 400 : 80, near = state.mode === "car" ? 80 : 20;
  const lower = text.charAt(0).toLowerCase() + text.slice(1);
  if (toNext <= near && !nav.said.has(`${i}n`)) {
    nav.said.add(`${i}n`).add(`${i}f`);
    speak(text);
  } else if (toNext <= far && !nav.said.has(`${i}f`)) {
    nav.said.add(`${i}f`);
    speak(`Dans ${fmtDistance(toNext)}, ${lower}`);
  }

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

async function reroute(pos) {
  nav.rerouting = true;
  $("banner-dist").textContent = "";
  $("banner-text").textContent = "Recalcul de l'itinéraire…";
  try {
    const m = MODES[state.mode], to = state.to;
    const res = await fetch(`https://routing.openstreetmap.de/${m.path}/route/v1/driving/${pos[0]},${pos[1]};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`);
    const d = await res.json();
    if (d.code === "Ok" && nav.on) {
      const r = d.routes[0];
      state.routes[state.mode] = r;
      loadRoute(r);
      nav.said.clear();
      map.getSource("route")?.setData({ type: "Feature", properties: { color: m.color }, geometry: r.geometry });
    }
  } catch {}
  nav.rerouting = false;
  nav.off = 0;
}

map.on("dragstart", () => {
  if (nav.on && nav.follow) {
    nav.follow = false;
    $("recenter").hidden = false;
  }
});
$("recenter").addEventListener("click", () => {
  nav.follow = true;
  nav.centered = false;
  $("recenter").hidden = true;
});

$("start").addEventListener("click", startNav);
$("stop").addEventListener("click", () => stopNav("Guidage arrêté."));

$("mute").addEventListener("click", () => {
  nav.voice = !nav.voice;
  $("mute").setAttribute("aria-pressed", String(nav.voice));
  if (!nav.voice) window.speechSynthesis?.cancel();
});

/* ---------- PWA : Installation et hors ligne ---------- */
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("install").hidden = false;
});
window.addEventListener("appinstalled", () => {
  $("install").hidden = true;
});
$("install").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $("install").hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js?v=2")
      .then((reg) => reg.update())
      .catch(() => {});
  });
}
window.addEventListener("offline", () => say("Hors connexion : cartes en cache disponibles, itinéraires indisponibles sans réseau."));
