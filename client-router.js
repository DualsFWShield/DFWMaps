"use strict";

/* ==========================================================================
   ClientRouter · Moteur d'itinéraire hybride, sans API de routage
   --------------------------------------------------------------------------
   Pipeline unique :
     1. Les tuiles vectorielles OpenFreeMap (couche "transportation") sont
        téléchargées le long du trajet et décodées localement (décodeur MVT
        intégré, aucune dépendance).
     2. Les segments sont soudés en un graphe routier orienté (sens uniques
        respectés), on garde la plus grande composante connexe.
     3. Départ / étapes / arrivée sont projetés SUR le segment de route le
        plus proche (le segment est coupé en deux) : plus aucun connecteur
        en ligne droite.
     4. Recherche du chemin :
          - Contraction Hierarchies (prétraitement + Dijkstra bidirectionnel
            sur les graphes "montants") quand le graphe est assez petit,
          - sinon A* bidirectionnel (potentiels moyens, Goldberg/Ikeda).
        Les deux se replient l'un sur l'autre si nécessaire.
   Aucune ligne droite entre villes : l'itinéraire n'est constitué que de
   segments de routes réelles issus des tuiles.
   ========================================================================== */

const ROUTER_CONFIG = {
  tileJsonUrl: "https://tiles.openfreemap.org/planet",
  maxZoom: 14,          // plus fin = plus de détail, plus de tuiles
  minZoom: 7,
  maxTiles: 200,        // budget de tuiles par calcul
  concurrency: 8,
  useContraction: true, // false = toujours A* bidirectionnel
  chMaxNodes: 40000,    // au-delà, le prétraitement CH n'est plus rentable
  chTimeBudgetMs: 15000,
  maxSnapMeters: 2500,  // distance max point -> route
};

/* --------------------------------------------------------------------------
   File de priorité binaire (Min-Heap)
   -------------------------------------------------------------------------- */
class MinPriorityQueue {
  constructor() { this.heap = []; }
  size() { return this.heap.length; }
  isEmpty() { return this.heap.length === 0; }
  clear() { this.heap.length = 0; }
  peekPriority() { return this.heap.length ? this.heap[0].priority : null; }

  push(item, priority) {
    this.heap.push({ item, priority });
    this._bubbleUp(this.heap.length - 1);
  }

  popEntry() {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const bottom = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this._sinkDown(0);
    }
    return top;
  }

  pop() {
    const e = this.popEntry();
    return e ? e.item : null;
  }

  _bubbleUp(idx) {
    const node = this.heap[idx];
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const parent = this.heap[parentIdx];
      if (node.priority >= parent.priority) break;
      this.heap[idx] = parent;
      idx = parentIdx;
    }
    this.heap[idx] = node;
  }

  _sinkDown(idx) {
    const length = this.heap.length;
    const node = this.heap[idx];
    while (true) {
      const l = (idx << 1) + 1;
      const r = l + 1;
      let swap = -1;
      let best = node.priority;
      if (l < length && this.heap[l].priority < best) { swap = l; best = this.heap[l].priority; }
      if (r < length && this.heap[r].priority < best) { swap = r; }
      if (swap === -1) break;
      this.heap[idx] = this.heap[swap];
      idx = swap;
    }
    this.heap[idx] = node;
  }
}

/* --------------------------------------------------------------------------
   Géométrie
   -------------------------------------------------------------------------- */
function haversineMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const x = sinLat * sinLat + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * sinLng * sinLng;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, x)));
}

function calculateBearing(p1, p2) {
  const rad = Math.PI / 180;
  const y = Math.sin((p2[0] - p1[0]) * rad) * Math.cos(p2[1] * rad);
  const x =
    Math.cos(p1[1] * rad) * Math.sin(p2[1] * rad) -
    Math.sin(p1[1] * rad) * Math.cos(p2[1] * rad) * Math.cos((p2[0] - p1[0]) * rad);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/* --------------------------------------------------------------------------
   Propriétés des routes & Détection géographique (Belgique / France)
   -------------------------------------------------------------------------- */
const ROAD_PROPERTIES = {
  motorway:    { baseSpeed: 130, carSpeed: 120, fuelDrag: 1.35, label: "Autoroute" },
  trunk:       { baseSpeed: 110, carSpeed: 100, fuelDrag: 1.20, label: "Voie express" },
  primary:     { baseSpeed: 80,  carSpeed: 70,  fuelDrag: 1.00, label: "Route principale" },
  secondary:   { baseSpeed: 80,  carSpeed: 60,  fuelDrag: 0.98, label: "Route secondaire" },
  tertiary:    { baseSpeed: 70,  carSpeed: 50,  fuelDrag: 0.97, label: "Route locale" },
  minor:       { baseSpeed: 50,  carSpeed: 35,  fuelDrag: 1.02, label: "Rue" },
  street:      { baseSpeed: 50,  carSpeed: 30,  fuelDrag: 1.05, label: "Rue" },
  residential: { baseSpeed: 30,  carSpeed: 30,  fuelDrag: 1.10, label: "Zone résidentielle" },
  service:     { baseSpeed: 20,  carSpeed: 15,  fuelDrag: 1.15, label: "Voie de service" },
  track:       { baseSpeed: 25,  carSpeed: 20,  fuelDrag: 1.25, label: "Chemin" },
  cycleway:    { baseSpeed: 25,  carSpeed: 20,  fuelDrag: 0.95, label: "Piste cyclable" },
  path:        { baseSpeed: 15,  carSpeed: 10,  fuelDrag: 0.95, label: "Sentier" },
  footway:     { baseSpeed: 6,   carSpeed: 5,   fuelDrag: 0.95, label: "Voie piétonne" },
  pedestrian:  { baseSpeed: 15,  carSpeed: 10,  fuelDrag: 0.95, label: "Rue piétonne" },
};

function isBelgiumCoord(coord) {
  if (!coord || !Array.isArray(coord) || coord.length < 2) return false;
  const lng = Number(coord[0]), lat = Number(coord[1]);
  if (isNaN(lng) || isNaN(lat)) return false;
  return lng >= 2.50 && lng <= 6.45 && lat >= 49.48 && lat <= 51.52;
}

function isBrusselsCoord(coord) {
  if (!coord || !Array.isArray(coord) || coord.length < 2) return false;
  const lng = Number(coord[0]), lat = Number(coord[1]);
  if (isNaN(lng) || isNaN(lat)) return false;
  return lng >= 4.24 && lng <= 4.50 && lat >= 50.76 && lat <= 50.93;
}

function isFlandersCoord(coord) {
  if (!isBelgiumCoord(coord)) return false;
  if (isBrusselsCoord(coord)) return false;
  const lng = Number(coord[0]), lat = Number(coord[1]);
  if (lat >= 50.78) return true;
  if (lat >= 50.68 && lng < 4.05) return true;
  return false;
}

function resolveSpeedLimit(roadClass, maxspeed, mode = "car", location = null, roadName = "") {
  if (mode === "foot") return 5;
  if (mode === "bike") return 18;
  if (maxspeed && !isNaN(Number(maxspeed)) && Number(maxspeed) > 0) return Number(maxspeed);

  const cls = (roadClass || "street").toLowerCase();
  const text = String(roadName || "").toLowerCase();

  // Réglementation routière spécifique à la Belgique
  if (isBelgiumCoord(location)) {
    const inBru = isBrusselsCoord(location);
    const inFland = isFlandersCoord(location);

    // Ring belge (R0 Ring de Bruxelles, R1 Ring d'Anvers, R2, R3...) -> 100 km/h (ou 90)
    if (/(\br\s*\d+|\bring\b)/i.test(text)) return 100;

    // Autoroutes belges (E411, E40, E19, E25, E42, A1, A4...) -> STRICTEMENT 120 km/h (jamais 130 km/h !)
    if (cls === "motorway" || /(\b[ea]\s*\d+|\bautoroute\b)/i.test(text)) return 120;

    // Voies express / voies rapides 2x2
    if (cls === "trunk" || /(\bexpress\b|\bvoie rapide\b)/i.test(text)) return 100;

    // Routes nationales et secondaires
    if (cls === "primary" || cls === "secondary") {
      if (inBru) return 50; // Grands axes bruxellois à 50
      if (inFland) return 70; // Flandre : 70 km/h par défaut hors agglomération
      return 90; // Wallonie : 90 km/h par défaut hors agglomération
    }

    if (cls === "tertiary") {
      if (inBru) return 30;
      if (inFland) return 70;
      return 70;
    }

    // Zones résidentielles & zones de rencontre
    if (cls === "residential" || cls === "living_street") return 30;

    // Voirie urbaine standard : Bruxelles est à 30 km/h généralisé ("Ville 30") depuis 2021
    if (cls === "minor" || cls === "street") {
      return inBru ? 30 : 50;
    }

    return inBru ? 30 : 50;
  }

  // Réglementation France / Standard par défaut
  const info = ROAD_PROPERTIES[cls] || ROAD_PROPERTIES.street;
  return info.baseSpeed;
}

/** Classe "interne" à partir des attributs d'une tuile OpenMapTiles. */
function resolveClass(props) {
  const c = props.class;
  if (c === "path") {
    const sub = props.subclass;
    if (sub === "cycleway") return "cycleway";
    if (sub === "pedestrian") return "pedestrian";
    if (sub === "footway" || sub === "steps" || sub === "corridor" || sub === "platform") return "footway";
    return "path";
  }
  return c;
}

/** Une classe de route est-elle utilisable pour ce mode ? */
function isClassAllowed(cls, mode) {
  switch (mode) {
    case "foot":
      return ["primary", "secondary", "tertiary", "minor", "service", "track", "path", "cycleway", "footway", "pedestrian"].includes(cls);
    case "bike":
      return ["primary", "secondary", "tertiary", "minor", "service", "track", "path", "cycleway", "pedestrian"].includes(cls);
    default:
      return ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"].includes(cls);
  }
}

/** Durée réelle (s), coût d'optimisation et vitesse affichée pour un segment. */
function arcCosts(cls, dist, mode, criterion, coord = null, name = "", ref = "") {
  const info = ROAD_PROPERTIES[cls] || ROAD_PROPERTIES.street;

  if (mode === "foot") {
    const duration = dist / (4.8 / 3.6);
    return { duration, cost: duration, speed: 5 };
  }

  if (mode === "bike") {
    const kmh = cls === "cycleway" ? 22 : cls === "path" || cls === "track" ? 14 : cls === "pedestrian" ? 6 : 18;
    const duration = dist / (kmh / 3.6);
    const factor = cls === "cycleway" ? 0.7 : cls === "primary" ? 1.4 : cls === "secondary" ? 1.15 : cls === "path" ? 1.1 : 1.0;
    return { duration, cost: duration * factor, speed: kmh };
  }

  let baseSpeed = info.baseSpeed;
  let carSpeed = info.carSpeed;

  // Ajustement dynamique si le segment est situé en Belgique
  if (isBelgiumCoord(coord)) {
    const inBru = isBrusselsCoord(coord);
    const inFland = isFlandersCoord(coord);
    const text = `${name || ""} ${ref || ""}`.toLowerCase();

    if (/(\br\s*\d+|\bring\b)/i.test(text)) {
      baseSpeed = 100;
      carSpeed = 95;
    } else if (cls === "motorway" || /(\b[ea]\s*\d+|\bautoroute\b)/i.test(text)) {
      baseSpeed = 120;
      carSpeed = 115;
    } else if (cls === "trunk") {
      baseSpeed = 100;
      carSpeed = 95;
    } else if (cls === "primary" || cls === "secondary") {
      if (inBru) {
        baseSpeed = 50;
        carSpeed = 40;
      } else if (inFland) {
        baseSpeed = 70;
        carSpeed = 60;
      } else {
        baseSpeed = 90;
        carSpeed = 75;
      }
    } else if (cls === "tertiary") {
      baseSpeed = inBru ? 30 : 70;
      carSpeed = inBru ? 25 : 55;
    } else if (cls === "minor" || cls === "street") {
      baseSpeed = inBru ? 30 : 50;
      carSpeed = inBru ? 25 : 32;
    } else if (cls === "residential") {
      baseSpeed = 30;
      carSpeed = 25;
    }
  }

  const duration = dist / (carSpeed / 3.6);
  const isHighway = cls === "motorway" || cls === "trunk";
  let cost;
  switch (criterion) {
    case "shortest": cost = dist; break;
    case "eco": cost = dist * info.fuelDrag; break;
    case "nohighway": cost = isHighway ? duration * 50 : duration; break;
    default: cost = duration;
  }
  return { duration, cost, speed: baseSpeed };
}

/** Borne inférieure du coût par mètre (heuristique A* admissible). */
function lowerBoundPerMeter(mode, criterion) {
  if (mode === "foot") return 1 / (4.8 / 3.6);
  if (mode === "bike") return 0.7 / (22 / 3.6);
  if (criterion === "shortest") return 1;
  if (criterion === "eco") return 0.95;
  return 1 / (120 / 3.6);
}

/* ==========================================================================
   DÉCODEUR MVT (Mapbox Vector Tile) minimal — aucune dépendance
   ========================================================================== */
const _utf8 = new TextDecoder("utf-8");

function readVarint(buf, st) {
  let r = 0;
  let m = 1;
  let b;
  do {
    b = buf[st.p++];
    r += (b & 0x7f) * m;
    m *= 128;
  } while (b & 0x80);
  return r;
}

function skipField(buf, st, wireType) {
  if (wireType === 0) readVarint(buf, st);
  else if (wireType === 1) st.p += 8;
  else if (wireType === 2) st.p += readVarint(buf, st);
  else if (wireType === 5) st.p += 4;
  else throw new Error("Type protobuf inconnu : " + wireType);
}

function decodeValue(buf, s, e) {
  const st = { p: s };
  let val = null;
  while (st.p < e) {
    const key = readVarint(buf, st);
    const f = key >> 3;
    const wt = key & 7;
    if (f === 1 && wt === 2) {
      const len = readVarint(buf, st);
      val = _utf8.decode(buf.subarray(st.p, st.p + len));
      st.p += len;
    } else if (f === 2 && wt === 5) {
      val = new DataView(buf.buffer, buf.byteOffset + st.p, 4).getFloat32(0, true);
      st.p += 4;
    } else if (f === 3 && wt === 1) {
      val = new DataView(buf.buffer, buf.byteOffset + st.p, 8).getFloat64(0, true);
      st.p += 8;
    } else if (f === 4 || f === 5) {
      val = readVarint(buf, st);
    } else if (f === 6) {
      const v = readVarint(buf, st);
      val = v % 2 === 0 ? v / 2 : -(v + 1) / 2;
    } else if (f === 7) {
      val = readVarint(buf, st) !== 0;
    } else {
      skipField(buf, st, wt);
    }
  }
  return val;
}

function decodeFeature(buf, s, e, keys, values) {
  const st = { p: s };
  const tags = [];
  const geom = [];
  let type = 0;
  while (st.p < e) {
    const key = readVarint(buf, st);
    const f = key >> 3;
    const wt = key & 7;
    if (f === 2 && wt === 2) {
      const len = readVarint(buf, st);
      const end2 = st.p + len;
      while (st.p < end2) tags.push(readVarint(buf, st));
    } else if (f === 3 && wt === 0) {
      type = readVarint(buf, st);
    } else if (f === 4 && wt === 2) {
      const len = readVarint(buf, st);
      const end2 = st.p + len;
      while (st.p < end2) geom.push(readVarint(buf, st));
    } else {
      skipField(buf, st, wt);
    }
  }
  const props = {};
  for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
  return { type, props, lines: decodeGeometry(geom) };
}

function decodeGeometry(g) {
  const lines = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < g.length) {
    const ci = g[i++];
    const cmd = ci & 7;
    const cnt = Math.floor(ci / 8);
    if (cmd === 1 || cmd === 2) {
      for (let k = 0; k < cnt; k++) {
        const dx = g[i++];
        const dy = g[i++];
        x += (dx >>> 1) ^ -(dx & 1);
        y += (dy >>> 1) ^ -(dy & 1);
        if (cmd === 1) { cur = []; lines.push(cur); }
        if (cur) cur.push([x, y]);
      }
    }
  }
  return lines;
}

function decodeLayer(buf, s, e, wanted) {
  const st = { p: s };
  let name = "";
  let extent = 4096;
  const keys = [];
  const values = [];
  const featRanges = [];
  while (st.p < e) {
    const key = readVarint(buf, st);
    const f = key >> 3;
    const wt = key & 7;
    if (wt === 2) {
      const len = readVarint(buf, st);
      const a = st.p;
      if (f === 1) name = _utf8.decode(buf.subarray(a, a + len));
      else if (f === 2) featRanges.push([a, a + len]);
      else if (f === 3) keys.push(_utf8.decode(buf.subarray(a, a + len)));
      else if (f === 4) values.push(decodeValue(buf, a, a + len));
      st.p = a + len;
    } else if (f === 5 && wt === 0) {
      extent = readVarint(buf, st);
    } else {
      skipField(buf, st, wt);
    }
  }
  if (!wanted.has(name)) return null;
  return { name, extent, features: featRanges.map(([a, b]) => decodeFeature(buf, a, b, keys, values)) };
}

function decodeTile(buf, wanted) {
  const st = { p: 0 };
  const layers = {};
  while (st.p < buf.length) {
    const key = readVarint(buf, st);
    const f = key >> 3;
    const wt = key & 7;
    if (f === 3 && wt === 2) {
      const len = readVarint(buf, st);
      const layer = decodeLayer(buf, st.p, st.p + len, wanted);
      if (layer) layers[layer.name] = layer;
      st.p += len;
    } else {
      skipField(buf, st, wt);
    }
  }
  return layers;
}

/* ==========================================================================
   TUILES : planification, téléchargement, cache
   ========================================================================== */
const _tileCache = new Map();
const _tileCacheMax = 500;
let _tileTemplatePromise = null;

function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const la = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

function tileToLngLat(tx, ty, z, px, py, extent) {
  const n = 2 ** z;
  const x = (tx + px / extent) / n;
  const y = (ty + py / extent) / n;
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

function tileWidthMeters(z, lat) {
  return (40075016 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** Tuiles couvrant un corridor autour de la polyligne départ → étapes → arrivée. */
function planTiles(points, z, ring) {
  const n = 2 ** z;
  const set = new Map();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = haversineMeters([a.lng, a.lat], [b.lng, b.lat]);
    const step = tileWidthMeters(z, a.lat) * 0.5;
    const steps = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= steps; k++) {
      const lng = a.lng + ((b.lng - a.lng) * k) / steps;
      const lat = a.lat + ((b.lat - a.lat) * k) / steps;
      const [tx, ty] = lngLatToTile(lng, lat, z);
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          set.set(`${x}/${y}`, [x, y]);
        }
      }
    }
  }
  return [...set.values()];
}

function chooseZoom(points, ring, zoomCap) {
  let plan = null;
  for (let z = zoomCap; z >= ROUTER_CONFIG.minZoom; z--) {
    plan = { z, tiles: planTiles(points, z, ring) };
    if (plan.tiles.length <= ROUTER_CONFIG.maxTiles) break;
  }
  return plan;
}

async function getTileTemplate() {
  if (!_tileTemplatePromise) {
    _tileTemplatePromise = fetch(ROUTER_CONFIG.tileJsonUrl)
      .then((r) => {
        if (!r.ok) throw new Error("TileJSON indisponible (" + r.status + ")");
        return r.json();
      })
      .then((j) => {
        if (!j.tiles || !j.tiles[0]) throw new Error("TileJSON invalide");
        return j.tiles[0];
      })
      .catch((err) => {
        _tileTemplatePromise = null;
        throw err;
      });
  }
  return _tileTemplatePromise;
}

async function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (_tileCache.has(key)) {
    const cached = _tileCache.get(key);
    _tileCache.delete(key);
    _tileCache.set(key, cached);
    return cached;
  }

  const p = (async () => {
    const tpl = await getTileTemplate();
    const url = tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    const res = await fetch(url);
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(`Tuile ${key} : HTTP ${res.status}`);
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const ds = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")));
      bytes = new Uint8Array(await ds.arrayBuffer());
    }
    if (!bytes.length) return null;
    return decodeTile(bytes, new Set(["transportation", "transportation_name"]));
  })();

  if (_tileCache.size >= _tileCacheMax) {
    const oldest = _tileCache.keys().next().value;
    _tileCache.delete(oldest);
  }
  _tileCache.set(key, p);
  p.catch(() => _tileCache.delete(key));
  return p;
}

async function loadTiles(plan, onTile) {
  const results = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < plan.tiles.length) {
      const idx = next++;
      const [x, y] = plan.tiles[idx];
      const decoded = await fetchTile(plan.z, x, y);
      results[idx] = { x, y, decoded };
      done++;
      onTile?.(done, plan.tiles.length);
    }
  };
  await Promise.all(Array.from({ length: ROUTER_CONFIG.concurrency }, worker));
  return results;
}

/* ==========================================================================
   CONSTRUCTION DU GRAPHE (segments soudés entre tuiles)
   ========================================================================== */
class GraphBuilder {
  constructor() {
    this.lng = [];
    this.lat = [];
    this.keyMap = new Map();
    this.boundaryGrid = new Map();
    this.segs = [];
    this.segKeys = new Set();
  }

  _newNode(lng, lat) {
    this.lng.push(lng);
    this.lat.push(lat);
    return this.lng.length - 1;
  }

  /** Nœud exact (sommet intérieur d'une tuile). */
  node(lng, lat) {
    const key = lng.toFixed(6) + "," + lat.toFixed(6);
    let id = this.keyMap.get(key);
    if (id === undefined) {
      id = this._newNode(lng, lat);
      this.keyMap.set(key, id);
    }
    return id;
  }

  /** Nœud situé sur une bordure de tuile : fusionné avec ceux des tuiles voisines. */
  boundaryNode(lng, lat, tolMeters) {
    const cell = Math.max(tolMeters / 111320, 1e-6);
    const cx = Math.floor(lng / cell);
    const cy = Math.floor(lat / cell);
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let best = -1;
    let bestD = tolMeters;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.boundaryGrid.get(`${cx + dx}:${cy + dy}:${cell}`);
        if (!list) continue;
        for (const id of list) {
          const d = Math.hypot((this.lng[id] - lng) * cosLat * 111320, (this.lat[id] - lat) * 111320);
          if (d <= bestD) { bestD = d; best = id; }
        }
      }
    }
    if (best >= 0) return best;
    const id = this._newNode(lng, lat);
    const gk = `${cx}:${cy}:${cell}`;
    let list = this.boundaryGrid.get(gk);
    if (!list) { list = []; this.boundaryGrid.set(gk, list); }
    list.push(id);
    return id;
  }

  addSeg(a, b, props) {
    if (a === b) return -1;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (this.segKeys.has(k)) return -1;
    this.segKeys.add(k);
    this.segs.push({ a, b, dead: false, ...props });
    return this.segs.length - 1;
  }

  /** Ne garde que la plus grande composante connexe (supprime les îlots isolés). */
  keepLargestComponent() {
    const n = this.lng.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    for (const s of this.segs) {
      const ra = find(s.a);
      const rb = find(s.b);
      if (ra !== rb) parent[ra] = rb;
    }
    const count = new Map();
    for (const s of this.segs) {
      const r = find(s.a);
      count.set(r, (count.get(r) || 0) + 1);
    }
    let bestRoot = -1;
    let bestCount = 0;
    for (const [r, c] of count) if (c > bestCount) { bestCount = c; bestRoot = r; }
    for (const s of this.segs) if (find(s.a) !== bestRoot) s.dead = true;
  }
}

/** Clipping de segment (Liang-Barsky) sur [0, E]². */
function clipSegment(p0, p1, E) {
  let t0 = 0;
  let t1 = 1;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const checks = [
    [-dx, p0[0]],
    [dx, E - p0[0]],
    [-dy, p0[1]],
    [dy, E - p0[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return [
    [p0[0] + t0 * dx, p0[1] + t0 * dy],
    [p0[0] + t1 * dx, p0[1] + t1 * dy],
  ];
}

/** Index des noms de rues (couche transportation_name) : cellules de quelques dizaines de mètres. */
function buildNameIndex(layer, z, tx, ty, cellDeg) {
  const index = new Map();
  if (!layer) return index;
  const stepMeters = (cellDeg * 111320) / 2;
  const add = (lng, lat, name, ref) => {
    const key = `${Math.floor(lng / cellDeg)}:${Math.floor(lat / cellDeg)}`;
    let list = index.get(key);
    if (!list) { list = []; index.set(key, list); }
    list.push({ lng, lat, name, ref });
  };
  for (const f of layer.features) {
    const name = f.props.name || f.props["name:latin"] || f.props.name_en || "";
    const ref = f.props.ref || "";
    if (!name && !ref) continue;
    for (const line of f.lines) {
      let prev = null;
      for (const q of line) {
        const cur = tileToLngLat(tx, ty, z, q[0], q[1], layer.extent);
        if (prev) {
          const len = haversineMeters(prev, cur);
          const n = Math.max(1, Math.ceil(len / stepMeters));
          for (let k = 0; k <= n; k++) {
            add(prev[0] + ((cur[0] - prev[0]) * k) / n, prev[1] + ((cur[1] - prev[1]) * k) / n, name, ref);
          }
        }
        prev = cur;
      }
    }
  }
  return index;
}

function lookupName(index, lng, lat, cellDeg) {
  const cx = Math.floor(lng / cellDeg);
  const cy = Math.floor(lat / cellDeg);
  let best = null;
  let bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const list = index.get(`${cx + dx}:${cy + dy}`);
      if (!list) continue;
      for (const s of list) {
        const d = (s.lng - lng) ** 2 + (s.lat - lat) ** 2;
        if (d < bestD) { bestD = d; best = s; }
      }
    }
  }
  return best && bestD <= (cellDeg * 1.5) ** 2 ? best : null;
}

function ingestTile(builder, tile, z, mode) {
  const tr = tile.decoded?.transportation;
  if (!tr) return;
  const E = tr.extent || 4096;
  const [, centerLat] = tileToLngLat(tile.x, tile.y, z, E / 2, E / 2, E);
  const unitM = tileWidthMeters(z, centerLat) / E;
  const weldTol = Math.max(3, 2.5 * unitM);
  const cellDeg = Math.max(0.00015, (3 * unitM) / 111320);
  const nameIndex = buildNameIndex(tile.decoded.transportation_name, z, tile.x, tile.y, cellDeg);
  const eps = 1e-6;
  const onBorder = (q) => q[0] <= eps || q[0] >= E - eps || q[1] <= eps || q[1] >= E - eps;

  const vertex = (q) => {
    const [lng, lat] = tileToLngLat(tile.x, tile.y, z, q[0], q[1], E);
    return onBorder(q) ? builder.boundaryNode(lng, lat, weldTol) : builder.node(lng, lat);
  };

  for (const f of tr.features) {
    if (f.type !== 2) continue;
    const p = f.props;
    const cls = resolveClass(p);
    if (!cls || !isClassAllowed(cls, mode)) continue;
    if (p.access === "no") continue;
    if (mode === "car" && (p.service === "parking_aisle" || p.service === "driveway" || p.service === "drive-through")) continue;

    const ow = mode === "car" ? Number(p.oneway) || 0 : 0;
    const ramp = Number(p.ramp) === 1;
    const isRoundabout = Boolean(p.junction === "roundabout" || p.roundabout === 1 || p.subclass === "roundabout" || p.class === "roundabout");

    for (const line of f.lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const clipped = clipSegment(line[i], line[i + 1], E);
        if (!clipped) continue;
        let a = vertex(clipped[0]);
        let b = vertex(clipped[1]);
        if (a === b) continue;

        const mid = [(builder.lng[a] + builder.lng[b]) / 2, (builder.lat[a] + builder.lat[b]) / 2];
        const nm = lookupName(nameIndex, mid[0], mid[1], cellDeg);

        let oneway = 0;
        if (ow === 1) oneway = 1;
        else if (ow === -1) { oneway = 1; [a, b] = [b, a]; }

        builder.addSeg(a, b, { cls, name: nm?.name || "", ref: nm?.ref || "", ramp, oneway, isRoundabout });
      }
    }
  }
}

/* --------------------------------------------------------------------------
   Projection des points sur le segment de route le plus proche
   -------------------------------------------------------------------------- */
class SegmentIndex {
  constructor(builder, cell = 0.004) {
    this.b = builder;
    this.cell = cell;
    this.grid = new Map();
    for (let i = 0; i < builder.segs.length; i++) if (!builder.segs[i].dead) this.add(i);
  }

  add(i) {
    const { b, cell } = this;
    const s = b.segs[i];
    const x0 = b.lng[s.a], y0 = b.lat[s.a], x1 = b.lng[s.b], y1 = b.lat[s.b];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / cell));
    let last = "";
    for (let k = 0; k <= steps; k++) {
      const x = x0 + ((x1 - x0) * k) / steps;
      const y = y0 + ((y1 - y0) * k) / steps;
      const key = `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
      if (key === last) continue;
      last = key;
      let list = this.grid.get(key);
      if (!list) { list = []; this.grid.set(key, list); }
      list.push(i);
    }
  }

  nearest(lng, lat, maxMeters) {
    const { b, cell } = this;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const kx = 111320 * cosLat;
    const ky = 111320;
    const cellMin = cell * kx;
    const maxRing = Math.ceil(maxMeters / Math.max(1, cellMin)) + 1;
    const cx = Math.floor(lng / cell);
    const cy = Math.floor(lat / cell);
    let best = null;

    for (let r = 0; r <= maxRing; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const list = this.grid.get(`${cx + dx}:${cy + dy}`);
          if (!list) continue;
          for (const i of list) {
            const s = b.segs[i];
            if (s.dead) continue;
            const ax = (b.lng[s.a] - lng) * kx, ay = (b.lat[s.a] - lat) * ky;
            const bx = (b.lng[s.b] - lng) * kx, by = (b.lat[s.b] - lat) * ky;
            const vx = bx - ax, vy = by - ay;
            const len2 = vx * vx + vy * vy;
            let t = len2 > 0 ? -(ax * vx + ay * vy) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(ax + t * vx, ay + t * vy);
            if (!best || d < best.dist) best = { seg: i, t, dist: d };
          }
        }
      }
      if (best && best.dist <= (r - 1) * cellMin) break;
    }
    return best && best.dist <= maxMeters ? best : null;
  }

  /** Projette le point sur la route : coupe le segment en deux et renvoie l'id du nœud. */
  snap(lng, lat, maxMeters) {
    const hit = this.nearest(lng, lat, maxMeters);
    if (!hit) return null;
    const { b } = this;
    const s = b.segs[hit.seg];
    if (hit.t < 0.02) return { node: s.a, dist: hit.dist };
    if (hit.t > 0.98) return { node: s.b, dist: hit.dist };

    const plng = b.lng[s.a] + (b.lng[s.b] - b.lng[s.a]) * hit.t;
    const plat = b.lat[s.a] + (b.lat[s.b] - b.lat[s.a]) * hit.t;
    const p = b.node(plng, plat);

    s.dead = true;
    const props = { cls: s.cls, name: s.name, ref: s.ref, ramp: s.ramp, oneway: s.oneway, isRoundabout: s.isRoundabout };
    b.segKeys.delete(s.a < s.b ? `${s.a}-${s.b}` : `${s.b}-${s.a}`);
    const i1 = b.addSeg(s.a, p, props);
    const i2 = b.addSeg(p, s.b, props);
    if (i1 >= 0) this.add(i1);
    if (i2 >= 0) this.add(i2);
    return { node: p, dist: hit.dist };
  }
}

/** Graphe orienté final (listes d'arcs sortants / entrants). */
function buildGraph(builder, mode, criterion) {
  const n = builder.lng.length;
  const out = new Array(n);
  const inn = new Array(n);
  for (let i = 0; i < n; i++) { out[i] = []; inn[i] = []; }
  const edges = [];
  const { lng, lat } = builder;

  for (const s of builder.segs) {
    if (s.dead) continue;
    const A = [lng[s.a], lat[s.a]];
    const B = [lng[s.b], lat[s.b]];
    const dist = haversineMeters(A, B);
    if (dist < 0.3) continue;
    const c = arcCosts(s.cls, dist, mode, criterion, A, s.name, s.ref);
    const mk = (from, to, P, Q) => {
      const e = {
        from, to, w: c.cost, distance: dist, baseDuration: c.duration, speedLimit: c.speed,
        roadClass: s.cls, name: s.name, ref: s.ref, isRamp: s.ramp, isRoundabout: Boolean(s.isRoundabout),
        coordinates: [P, Q],
      };
      out[from].push(e);
      inn[to].push(e);
      edges.push(e);
    };
    mk(s.a, s.b, A, B);
    if (!s.oneway) mk(s.b, s.a, B, A);
  }

  let live = 0;
  for (let i = 0; i < n; i++) if (out[i].length || inn[i].length) live++;
  return { n, live, lng, lat, out, inn, edges };
}

function degreeOf(graph, node) {
  const ids = new Set();
  for (const e of graph.out[node]) ids.add(e.to);
  for (const e of graph.inn[node]) ids.add(e.from);
  return ids.size;
}

/* ==========================================================================
   A* BIDIRECTIONNEL (potentiels moyens — cohérents, donc exact)
   ========================================================================== */
async function bidirectionalAStar(graph, s, t, opts = {}) {
  const { lb, visualize = false, onProgress = null } = opts;
  if (s === t) return [];
  const n = graph.n;
  const { lng, lat } = graph;

  const dTo = (v, target) => haversineMeters([lng[v], lat[v]], [lng[target], lat[target]]);
  const pi = (v) => 0.5 * lb * (dTo(v, t) - dTo(v, s));

  const gF = new Float64Array(n).fill(Infinity);
  const gB = new Float64Array(n).fill(Infinity);
  const closedF = new Uint8Array(n);
  const closedB = new Uint8Array(n);
  const parF = new Array(n);
  const parB = new Array(n);
  const hF = new MinPriorityQueue();
  const hB = new MinPriorityQueue();

  gF[s] = 0; hF.push(s, pi(s));
  gB[t] = 0; hB.push(t, -pi(t));

  let mu = Infinity;
  let meet = -1;
  let steps = 0;
  const startTime = performance.now();
  let lastYield = startTime;
  const explored = [];

  while (!hF.isEmpty() && !hB.isEmpty()) {
    if (hF.peekPriority() + hB.peekPriority() >= mu) break;
    steps++;
    const forward = hF.peekPriority() <= hB.peekPriority();

    if (forward) {
      const { item: v } = hF.popEntry();
      if (closedF[v]) continue;
      closedF[v] = 1;
      for (const e of graph.out[v]) {
        const u = e.to;
        const ng = gF[v] + e.w;
        if (ng < gF[u]) {
          gF[u] = ng;
          parF[u] = e;
          hF.push(u, ng + pi(u));
          if (visualize) explored.push(e.coordinates);
          if (gB[u] < Infinity && ng + gB[u] < mu) { mu = ng + gB[u]; meet = u; }
        }
      }
    } else {
      const { item: v } = hB.popEntry();
      if (closedB[v]) continue;
      closedB[v] = 1;
      for (const e of graph.inn[v]) {
        const u = e.from;
        const ng = gB[v] + e.w;
        if (ng < gB[u]) {
          gB[u] = ng;
          parB[u] = e;
          hB.push(u, ng - pi(u));
          if (visualize) explored.push(e.coordinates);
          if (gF[u] < Infinity && ng + gF[u] < mu) { mu = ng + gF[u]; meet = u; }
        }
      }
    }

    if (visualize && !window.__algoSkipRequested && (steps % 60 === 0 || performance.now() - lastYield > 16)) {
      lastYield = performance.now();
      onProgress?.({
        stepsCount: steps,
        elapsedMs: Math.round(lastYield - startTime),
        frontierSize: hF.size() + hB.size(),
        exploredCount: steps,
        algoName: "A* bidirectionnel",
        exploredEdges: explored.slice(-250),
        frontierNodes: [],
      });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (meet < 0) return null;

  const edges = [];
  let cur = meet;
  while (cur !== s) { const e = parF[cur]; edges.unshift(e); cur = e.from; }
  cur = meet;
  while (cur !== t) { const e = parB[cur]; edges.push(e); cur = e.to; }
  return edges;
}

/* ==========================================================================
   CONTRACTION HIERARCHIES
   ========================================================================== */
class ContractionHierarchy {
  /**
   * Prétraitement : contracte les nœuds par ordre d'importance (différence
   * d'arêtes + voisins supprimés, mise à jour paresseuse) avec recherche de
   * témoins bornée. Renvoie null si le budget de temps est dépassé.
   */
  static async build(graph, onProgress) {
    const N = graph.n;
    const t0 = performance.now();
    const budget = ROUTER_CONFIG.chTimeBudgetMs;

    const outM = new Array(N);
    const inM = new Array(N);
    for (let i = 0; i < N; i++) { outM[i] = new Map(); inM[i] = new Map(); }
    for (const e of graph.edges) {
      const ex = outM[e.from].get(e.to);
      if (!ex || e.w < ex.w) {
        const a = { from: e.from, to: e.to, w: e.w, edge: e, c1: null, c2: null };
        outM[e.from].set(e.to, a);
        inM[e.to].set(e.from, a);
      }
    }

    const contracted = new Uint8Array(N);
    const deleted = new Int32Array(N);
    const dist = new Float64Array(N).fill(Infinity);
    const upOut = new Array(N);
    const upIn = new Array(N);

    const witness = (src, skip, bound, maxSettled) => {
      const touched = [src];
      dist[src] = 0;
      const pq = new MinPriorityQueue();
      pq.push(src, 0);
      let settled = 0;
      while (!pq.isEmpty()) {
        const { item: x, priority: d } = pq.popEntry();
        if (d > dist[x]) continue;
        if (d > bound || ++settled > maxSettled) break;
        for (const a of outM[x].values()) {
          const y = a.to;
          if (y === skip) continue;
          const nd = d + a.w;
          if (nd < dist[y]) {
            if (dist[y] === Infinity) touched.push(y);
            dist[y] = nd;
            pq.push(y, nd);
          }
        }
      }
      return touched;
    };

    // Liste des raccourcis nécessaires si on contractait v (sans rien modifier).
    const shortcutsFor = (v) => {
      const list = [];
      const ins = [...inM[v].values()];
      const outs = [...outM[v].values()];
      for (const ain of ins) {
        const u = ain.from;
        let maxW = 0;
        for (const aout of outs) if (aout.to !== u) maxW = Math.max(maxW, ain.w + aout.w);
        if (maxW === 0) continue;
        const touched = witness(u, v, maxW, 60);
        for (const aout of outs) {
          const w = aout.to;
          if (w === u) continue;
          const sw = ain.w + aout.w;
          if (dist[w] <= sw) continue;
          list.push({ u, w, sw, ain, aout });
        }
        for (const x of touched) dist[x] = Infinity;
      }
      return { list, ins: ins.length, outs: outs.length };
    };

    const priorityOf = (v) => {
      const r = shortcutsFor(v);
      return (r.list.length - r.ins - r.outs) * 2 + deleted[v];
    };

    const heap = new MinPriorityQueue();
    for (let v = 0; v < N; v++) {
      heap.push(v, priorityOf(v));
      if (v % 4000 === 3999) {
        if (performance.now() - t0 > budget) return null;
        onProgress?.({ phase: "ch", pct: Math.round((v / N) * 20), algoName: "Contraction Hierarchies (ordre)" });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    const rank = new Int32Array(N);
    let order = 0;
    let sinceYield = 0;

    while (!heap.isEmpty()) {
      const { item: v } = heap.popEntry();
      if (contracted[v]) continue;

      const r = shortcutsFor(v);
      const np = (r.list.length - r.ins - r.outs) * 2 + deleted[v];
      const top = heap.peekPriority();
      if (top !== null && np > top) { heap.push(v, np); continue; }

      for (const sc of r.list) {
        const ex = outM[sc.u].get(sc.w);
        if (!ex || sc.sw < ex.w) {
          const a = { from: sc.u, to: sc.w, w: sc.sw, edge: null, c1: sc.ain, c2: sc.aout };
          outM[sc.u].set(sc.w, a);
          inM[sc.w].set(sc.u, a);
        }
      }

      upOut[v] = [...outM[v].values()];
      upIn[v] = [...inM[v].values()];
      for (const a of upOut[v]) { inM[a.to].delete(v); deleted[a.to]++; }
      for (const a of upIn[v]) { outM[a.from].delete(v); deleted[a.from]++; }
      contracted[v] = 1;
      rank[v] = order++;

      if (++sinceYield >= 1500) {
        sinceYield = 0;
        if (performance.now() - t0 > budget) return null;
        onProgress?.({ phase: "ch", pct: 20 + Math.round((order / N) * 80), algoName: "Contraction Hierarchies (contraction)" });
        await new Promise((r2) => setTimeout(r2, 0));
      }
    }

    return new ContractionHierarchy(N, upOut, upIn);
  }

  constructor(N, upOut, upIn) {
    this.N = N;
    this.upOut = upOut; // arcs v -> w avec rank[w] > rank[v]
    this.upIn = upIn;   // arcs u -> v avec rank[u] > rank[v] (recherche arrière)
  }

  /** Dijkstra bidirectionnel sur les graphes montants + dépliage des raccourcis. */
  query(s, t) {
    if (s === t) return [];
    const dF = new Map([[s, 0]]);
    const dB = new Map([[t, 0]]);
    const pF = new Map();
    const pB = new Map();
    const hF = new MinPriorityQueue();
    const hB = new MinPriorityQueue();
    hF.push(s, 0);
    hB.push(t, 0);
    let best = Infinity;
    let meet = -1;

    const step = (heap, dMine, dOther, par, arcsOf, nextOf) => {
      if (heap.isEmpty()) return;
      const { item: v, priority: d } = heap.popEntry();
      if (d > dMine.get(v)) return;
      if (d >= best) { heap.clear(); return; }
      const ob = dOther.get(v);
      if (ob !== undefined && d + ob < best) { best = d + ob; meet = v; }
      for (const a of arcsOf[v] || []) {
        const u = nextOf(a);
        const nd = d + a.w;
        if (nd < (dMine.get(u) ?? Infinity)) {
          dMine.set(u, nd);
          par.set(u, a);
          heap.push(u, nd);
          const o = dOther.get(u);
          if (o !== undefined && nd + o < best) { best = nd + o; meet = u; }
        }
      }
    };

    while (!hF.isEmpty() || !hB.isEmpty()) {
      step(hF, dF, dB, pF, this.upOut, (a) => a.to);
      step(hB, dB, dF, pB, this.upIn, (a) => a.from);
    }
    if (meet < 0) return null;

    const arcsF = [];
    let cur = meet;
    while (cur !== s) { const a = pF.get(cur); arcsF.unshift(a); cur = a.from; }
    const arcsB = [];
    cur = meet;
    while (cur !== t) { const a = pB.get(cur); arcsB.push(a); cur = a.to; }

    const edges = [];
    for (const top of [...arcsF, ...arcsB]) {
      const stack = [top];
      while (stack.length) {
        const a = stack.pop();
        if (a.c1) { stack.push(a.c2); stack.push(a.c1); }
        else edges.push(a.edge);
      }
    }
    return edges;
  }
}

/* ==========================================================================
   FEUILLE DE ROUTE (turn-by-turn)
   ========================================================================== */
function roadLabel(edge) {
  if (!edge) return "";
  const name = (edge.name || "").trim();
  const ref = (edge.ref || "").trim();
  if (name && ref && !name.toLowerCase().includes(ref.toLowerCase())) return `${name} (${ref})`;
  if (name) return name;
  if (ref) return ref;
  switch (edge.roadClass) {
    case "motorway": return "l'autoroute";
    case "trunk": return "la voie express";
    case "primary":
    case "secondary":
    case "tertiary": return "la route";
    case "cycleway": return "la piste cyclable";
    case "path":
    case "footway":
    case "pedestrian": return "le chemin";
    default: return "";
  }
}

function buildTurnByTurnInstructions(graph, edges, coords, mode = "car") {
  if (!edges.length) return [];
  const isFast = (e) => e && (e.roadClass === "motorway" || e.roadClass === "trunk");

  // Calcule l'angle exact à la bifurcation entre l'arrivée (cur) et le départ (nxt)
  // Utilise les 8 à 12 mètres immédiats pour éliminer définitivement toute inversion gauche/droite
  const turnAngleAt = (i) => {
    const p = coords[i + 1];
    let jIn = i;
    while (jIn > 0 && haversineMeters(coords[jIn], p) < 8) jIn--;
    const bIn = calculateBearing(coords[jIn], p);

    let jOut = i + 2;
    while (jOut < coords.length - 1 && haversineMeters(p, coords[jOut]) < 8) jOut++;
    const bOut = calculateBearing(p, coords[jOut]);

    // > 0 = Droite (sens horaire), < 0 = Gauche (sens trigonométrique)
    let diff = ((bOut - bIn + 540) % 360) - 180;
    return { angle: diff, absA: Math.abs(diff), bIn, bOut };
  };

  let initialLabel = "";
  for (let k = 0; k < Math.min(8, edges.length); k++) {
    initialLabel = roadLabel(edges[k]);
    if (initialLabel) break;
  }

  const verb = mode === "car" ? "Prenez" : "Suivez";
  const steps = [];
  let maneuver = {
    type: "depart",
    modifier: "straight",
    instruction: initialLabel ? `${verb} ${initialLabel}` : `${verb} la route`,
    location: coords[0],
  };
  let currentRoad = initialLabel;
  let accDist = 0;
  let accDur = 0;
  let lastClass = edges[0].roadClass;
  let lastSpeed = edges[0].speedLimit;

  const flush = () => {
    if (accDist < 1 && steps.length > 0) return;
    steps.push({
      name: currentRoad || "Route",
      ref: "",
      roadClass: lastClass,
      maxspeed: lastSpeed,
      distance: Math.max(1, Math.round(accDist)),
      duration: Math.max(1, Math.round(accDur)),
      location: maneuver.location,
      maneuver,
    });
    accDist = 0;
    accDur = 0;
  };

  for (let i = 0; i < edges.length; i++) {
    const cur = edges[i];
    accDist += cur.distance;
    accDur += cur.baseDuration;
    lastClass = cur.roadClass;
    lastSpeed = cur.speedLimit;

    if (i === edges.length - 1) break;
    const nxt = edges[i + 1];
    const node = cur.to;
    const deg = degreeOf(graph, node);

    // 1. Détection des ronds-points : fusionne le giratoire en une seule manœuvre standardisée
    if (nxt.isRoundabout && !cur.isRoundabout) {
      let exitCount = 1;
      let rIdx = i + 1;
      let totalRDist = 0;
      let totalRDur = 0;
      let exitRoadLabel = "";

      while (rIdx < edges.length && edges[rIdx].isRoundabout) {
        totalRDist += edges[rIdx].distance;
        totalRDur += edges[rIdx].baseDuration;
        const rNode = edges[rIdx].to;
        // Si le nœud permet de quitter le rond-point vers une autre voie
        if (degreeOf(graph, rNode) >= 3 && rIdx < edges.length - 1 && edges[rIdx + 1].isRoundabout) {
          exitCount++;
        }
        rIdx++;
      }

      if (rIdx < edges.length) {
        exitRoadLabel = roadLabel(edges[rIdx]);
      }

      flush();
      const exitSuffix = exitCount === 1 ? "première" : exitCount === 2 ? "deuxième" : exitCount === 3 ? "troisième" : `${exitCount}e`;
      const targetText = exitRoadLabel ? ` sur ${exitRoadLabel}` : "";
      maneuver = {
        type: "roundabout",
        modifier: `roundabout-exit-${exitCount}`,
        instruction: `Au rond-point, prenez la ${exitSuffix} sortie${targetText}`,
        location: coords[i + 1],
      };
      if (exitRoadLabel) currentRoad = exitRoadLabel;

      accDist = totalRDist;
      accDur = totalRDur;
      i = rIdx - 1;
      continue;
    }

    // 2. Calcul d'angle précis à la jonction
    const { angle, absA } = turnAngleAt(i);
    const nextLabel = roadLabel(nxt);
    const nameChanged = Boolean(nextLabel && currentRoad && nextLabel !== currentRoad);
    const rampEnter = Boolean(nxt.isRamp && !cur.isRamp);
    const exitFast = isFast(cur) && !isFast(nxt);

    // Même axe / même route (ex: continue sur D 906 ou A 1)
    const sameNamedRoad = Boolean(
      (cur.name && nxt.name && cur.name === nxt.name) ||
      (cur.ref && nxt.ref && cur.ref === nxt.ref)
    );

    // RÈGLE ANTI-ZIGZAG :
    // - Si deg <= 2 : il n'y a pas d'intersection, la route serpente simplement. On NE GÉNÈRE AUCUN VIRAGE !
    // - Si deg >= 3 mais qu'on reste sur le même axe nommé : pas de virage sauf si carrefour en T (> 65°)
    let isRealTurn = false;
    if (rampEnter || exitFast) {
      isRealTurn = true;
    } else if (deg >= 3) {
      if (sameNamedRoad) {
        if (absA >= 65) isRealTurn = true;
      } else if (nameChanged) {
        if (absA >= 22) isRealTurn = true;
      } else {
        // Carrefour sans toponyme : virage net requis (>= 38°)
        if (absA >= 38) isRealTurn = true;
      }
    }

    // Si on continue sur le grand axe, accumuler la distance sans spammer
    if (!isRealTurn || accDist < 35) {
      if (nextLabel && (deg < 3 || !currentRoad)) currentRoad = nextLabel;
      continue;
    }

    let mod = "straight";
    if (absA > 145) mod = "uturn";
    else if (angle >= 45) mod = "right";
    else if (angle > 18) mod = "slight right";
    else if (angle <= -45) mod = "left";
    else if (angle < -18) mod = "slight left";

    const target = nextLabel || currentRoad;
    const onto = target ? ` sur ${target}` : "";
    let instr;
    let type = "turn";

    if (mod === "uturn") instr = "Faites demi-tour dès que possible";
    else if (rampEnter) instr = `Prenez la bretelle${onto}`;
    else if (exitFast) instr = `Prenez la sortie${onto}`;
    else if (mod === "right") instr = `Tournez à droite${onto}`;
    else if (mod === "slight right") instr = `Serrez à droite${onto}`;
    else if (mod === "left") instr = `Tournez à gauche${onto}`;
    else if (mod === "slight left") instr = `Serrez à gauche${onto}`;
    else { instr = `Continuez${onto}`; type = "continue"; }

    flush();
    maneuver = { type, modifier: mod, instruction: instr, location: coords[i + 1] };
    if (nextLabel) currentRoad = nextLabel;
  }

  flush();
  steps.push({
    name: "Destination",
    ref: "",
    roadClass: "street",
    maxspeed: 30,
    distance: 0,
    duration: 0,
    location: coords[coords.length - 1],
    maneuver: {
      type: "arrive",
      modifier: "straight",
      instruction: "Vous êtes arrivé à destination",
      location: coords[coords.length - 1],
    },
  });
  return steps;
}

/* ==========================================================================
   CALCUL D'ITINÉRAIRE
   ========================================================================== */
function emitProgress(onProgress, algoName, extra = {}) {
  onProgress?.({
    stepsCount: 0, elapsedMs: 0, frontierSize: 0, exploredCount: 0,
    exploredEdges: [], frontierNodes: [], algoName, ...extra,
  });
}

async function routeOnce(points, plan, opts) {
  const { mode, criterion, visualize, onProgress, useContraction } = opts;
  const t0 = performance.now();

  // 1. Tuiles
  const tiles = await loadTiles(plan, (done, total) =>
    emitProgress(onProgress, `Chargement des tuiles ${done}/${total}`, { phase: "tiles", elapsedMs: Math.round(performance.now() - t0) })
  );

  // 2. Graphe
  emitProgress(onProgress, "Construction du graphe routier", { phase: "graph" });
  const builder = new GraphBuilder();
  for (const tile of tiles) ingestTile(builder, tile, plan.z, mode);
  if (!builder.segs.length) return { error: "Aucune route chargée dans cette zone" };
  builder.keepLargestComponent();

  // 3. Projection des points sur la route
  const index = new SegmentIndex(builder);
  const maxSnap = Math.max(ROUTER_CONFIG.maxSnapMeters, tileWidthMeters(plan.z, points[0].lat) * 0.25);
  const snapped = [];
  for (let i = 0; i < points.length; i++) {
    const sn = index.snap(points[i].lng, points[i].lat, maxSnap);
    if (!sn) return { error: "Aucune route à proximité d'un des points" };
    snapped.push(sn);
  }

  const graph = buildGraph(builder, mode, criterion);
  const lb = lowerBoundPerMeter(mode, criterion);

  // 4. Contraction Hierarchies si le graphe est assez petit
  let ch = null;
  let usedCH = false;
  if (useContraction && graph.live <= ROUTER_CONFIG.chMaxNodes) {
    ch = await ContractionHierarchy.build(graph, (p) => emitProgress(onProgress, `${p.algoName} ${p.pct}%`, { phase: "ch" }));
  }

  // 5. Recherche, tronçon par tronçon
  const legs = [];
  for (let i = 0; i < snapped.length - 1; i++) {
    const s = snapped[i].node;
    const t = snapped[i + 1].node;
    let edges = null;

    if (ch) {
      edges = ch.query(s, t);
      if (edges) usedCH = true;
    }
    if (!edges) {
      edges = await bidirectionalAStar(graph, s, t, { lb, visualize, onProgress });
    }
    if (!edges) return { error: "Aucun chemin entre deux points (zone chargée insuffisante)" };

    const coords = [[graph.lng[s], graph.lat[s]]];
    let distance = 0;
    let duration = 0;
    for (const e of edges) {
      coords.push(e.coordinates[1]);
      distance += e.distance;
      duration += e.baseDuration;
    }
    const steps = buildTurnByTurnInstructions(graph, edges, coords, mode);
    if (i < snapped.length - 2 && steps.length) {
      const last = steps[steps.length - 1];
      last.name = "Étape";
      last.maneuver.instruction = "Étape atteinte";
    }
    legs.push({ coords, distance, duration, steps });
  }

  return { legs, graph, usedCH, snapped, zoom: plan.z, tileCount: plan.tiles.length };
}

/**
 * Calcul d'itinéraire unifié (l'option `algorithm` est ignorée : un seul moteur).
 * Retourne { distance (m), duration (s), geometry, legs:[{steps}] }.
 */
async function computeAutonomousRoute(
  map,
  { from, to, waypoints = [], mode = "car", criterion = "fastest", visualize = false, onProgress = null, useContraction = ROUTER_CONFIG.useContraction }
) {
  if (!from || !to) throw new Error("Points de départ et d'arrivée requis");
  const points = [from, ...waypoints.map((w) => w.pt || w), to];

  const attempts = [
    { ring: 1, zoomPenalty: 0 },
    { ring: 2, zoomPenalty: 0 },
    { ring: 3, zoomPenalty: 1 },
  ];

  let lastError = "Aucun itinéraire trouvé";
  for (const att of attempts) {
    const plan = chooseZoom(points, att.ring, ROUTER_CONFIG.maxZoom - att.zoomPenalty);
    let res;
    try {
      res = await routeOnce(points, plan, { mode, criterion, visualize, onProgress, useContraction });
    } catch (err) {
      lastError = err.message || String(err);
      continue;
    }
    if (res.error) { lastError = res.error; continue; }

    const allCoords = [];
    const allSteps = [];
    let distance = 0;
    let duration = 0;
    res.legs.forEach((leg, i) => {
      if (i === 0) allCoords.push(...leg.coords);
      else allCoords.push(...leg.coords.slice(1));
      distance += leg.distance;
      duration += leg.duration;
      allSteps.push(...leg.steps);
    });

    // Raccord (court) entre le point demandé et son projeté sur la route.
    const first = allCoords[0];
    const last = allCoords[allCoords.length - 1];
    if (haversineMeters([from.lng, from.lat], first) > 2) {
      allCoords.unshift([from.lng, from.lat]);
      distance += haversineMeters([from.lng, from.lat], first);
    }
    if (haversineMeters([to.lng, to.lat], last) > 2) {
      allCoords.push([to.lng, to.lat]);
      distance += haversineMeters([to.lng, to.lat], last);
    }

    return {
      distance: Math.round(distance),
      duration: Math.round(duration),
      algorithm: res.usedCH ? "hybrid-ch" : "hybrid-astar",
      zoom: res.zoom,
      geometry: { type: "LineString", coordinates: allCoords },
      legs: [{ distance: Math.round(distance), duration: Math.round(duration), steps: allSteps }],
    };
  }
  throw new Error(lastError);
}

/**
 * Calcul multi-critères optimisé : un seul chargement de tuiles et un seul graphe,
 * puis recherche de chemin pour chaque critère demandé.
 * Retourne un objet { [criterion]: routeResult | null }.
 */
async function computeMultiCriteriaRoute(
  map,
  { from, to, waypoints = [], mode = "car", criteria = ["fastest"], visualize = false, onProgress = null, useContraction = ROUTER_CONFIG.useContraction }
) {
  if (!from || !to) throw new Error("Points de départ et d'arrivée requis");
  const points = [from, ...waypoints.map((w) => w.pt || w), to];

  const attempts = [
    { ring: 1, zoomPenalty: 0 },
    { ring: 2, zoomPenalty: 0 },
    { ring: 3, zoomPenalty: 1 },
  ];

  let lastError = "Aucun itinéraire trouvé";

  for (const att of attempts) {
    const plan = chooseZoom(points, att.ring, ROUTER_CONFIG.maxZoom - att.zoomPenalty);
    const t0 = performance.now();

    /* 1. Charger les tuiles UNE SEULE FOIS */
    let tiles;
    try {
      tiles = await loadTiles(plan, (done, total) =>
        emitProgress(onProgress, `Chargement des tuiles ${done}/${total}`, { phase: "tiles", elapsedMs: Math.round(performance.now() - t0) })
      );
    } catch (err) {
      lastError = err.message || String(err);
      continue;
    }

    /* 2. Construire le graphe routier UNE SEULE FOIS */
    emitProgress(onProgress, "Construction du graphe routier", { phase: "graph" });
    const builder = new GraphBuilder();
    for (const tile of tiles) ingestTile(builder, tile, plan.z, mode);
    if (!builder.segs.length) { lastError = "Aucune route chargée dans cette zone"; continue; }
    builder.keepLargestComponent();

    /* 3. Projeter les points sur la route UNE SEULE FOIS */
    const index = new SegmentIndex(builder);
    const maxSnap = Math.max(ROUTER_CONFIG.maxSnapMeters, tileWidthMeters(plan.z, points[0].lat) * 0.25);
    const snapped = [];
    let snapFailed = false;
    for (let i = 0; i < points.length; i++) {
      const sn = index.snap(points[i].lng, points[i].lat, maxSnap);
      if (!sn) { lastError = "Aucune route à proximité d'un des points"; snapFailed = true; break; }
      snapped.push(sn);
    }
    if (snapFailed) continue;

    /* 4. Pour chaque critère, construire les coûts et chercher le chemin */
    const results = {};
    let hasAny = false;

    for (const criterion of criteria) {
      try {
        const graph = buildGraph(builder, mode, criterion);
        const lb = lowerBoundPerMeter(mode, criterion);

        let ch = null;
        let usedCH = false;
        if (useContraction && graph.live <= ROUTER_CONFIG.chMaxNodes) {
          const isFirst = criterion === criteria[0];
          ch = await ContractionHierarchy.build(graph, isFirst ? (p) => emitProgress(onProgress, `${p.algoName} ${p.pct}%`, { phase: "ch" }) : null);
        }

        const legs = [];
        let searchFailed = false;
        for (let i = 0; i < snapped.length - 1; i++) {
          const src = snapped[i].node;
          const dst = snapped[i + 1].node;
          let edges = null;

          if (ch) {
            edges = ch.query(src, dst);
            if (edges) usedCH = true;
          }
          if (!edges) {
            const isVis = visualize && criterion === criteria[0];
            edges = await bidirectionalAStar(graph, src, dst, { lb, visualize: isVis, onProgress: isVis ? onProgress : null });
          }
          if (!edges) { searchFailed = true; break; }

          const coords = [[graph.lng[src], graph.lat[src]]];
          let distance = 0;
          let duration = 0;
          for (const e of edges) {
            coords.push(e.coordinates[1]);
            distance += e.distance;
            duration += e.baseDuration;
          }
          const steps = buildTurnByTurnInstructions(graph, edges, coords, mode);
          if (i < snapped.length - 2 && steps.length) {
            const last = steps[steps.length - 1];
            last.name = "Étape";
            last.maneuver.instruction = "Étape atteinte";
          }
          legs.push({ coords, distance, duration, steps });
        }

        if (searchFailed) { results[criterion] = null; continue; }

        /* Assemblage final */
        const allCoords = [];
        const allSteps = [];
        let distance = 0;
        let duration = 0;
        legs.forEach((leg, idx) => {
          if (idx === 0) allCoords.push(...leg.coords);
          else allCoords.push(...leg.coords.slice(1));
          distance += leg.distance;
          duration += leg.duration;
          allSteps.push(...leg.steps);
        });

        const first = allCoords[0];
        const last = allCoords[allCoords.length - 1];
        if (haversineMeters([from.lng, from.lat], first) > 2) {
          allCoords.unshift([from.lng, from.lat]);
          distance += haversineMeters([from.lng, from.lat], first);
        }
        if (haversineMeters([to.lng, to.lat], last) > 2) {
          allCoords.push([to.lng, to.lat]);
          distance += haversineMeters([to.lng, to.lat], last);
        }

        results[criterion] = {
          distance: Math.round(distance),
          duration: Math.round(duration),
          algorithm: usedCH ? "hybrid-ch" : "hybrid-astar",
          zoom: plan.z,
          geometry: { type: "LineString", coordinates: allCoords },
          legs: [{ distance: Math.round(distance), duration: Math.round(duration), steps: allSteps }],
        };
        hasAny = true;
      } catch (err) {
        console.warn(`Criterion ${criterion} failed:`, err);
        results[criterion] = null;
      }
    }

    if (hasAny) return results;
    lastError = "Aucun itinéraire trouvé pour les critères demandés";
  }

  throw new Error(lastError);
}

window.ClientRouter = {
  MinPriorityQueue,
  ROUTER_CONFIG,
  ROAD_PROPERTIES,
  haversineMeters,
  resolveSpeedLimit,
  isBelgiumCoord,
  isBrusselsCoord,
  isFlandersCoord,
  // internes exposés pour les tests
  GraphBuilder,
  SegmentIndex,
  buildGraph,
  ContractionHierarchy,
  bidirectionalAStar,
  decodeTile,
  computeAutonomousRoute,
  computeMultiCriteriaRoute,
};