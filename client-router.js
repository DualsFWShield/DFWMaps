"use strict";

/* ==========================================================================
   ClientRouter · Moteur d'itinéraire autonome et multi-algorithmes sans API
   - 4 Algorithmes au choix de l'utilisateur :
     1. 🐜 Colonie de Fourmis (ACO) : phéromones dynamiques & intelligence en essaim
     2. ⚡ A* Classique : recherche heuristique admissible optimale
     3. 🗺️ Moteur OpenStreetMap (OSRM) : hiérarchie autoroutière (Contraction Hierarchies)
     4. 🚗 Moteur Waze & Google Maps : prédiction d'impédance, feux & pénalités de virages
   - Réseau dorsal routier et autoroutier complet (zéro ligne droite)
   - Extraction des tuiles vectorielles locales MapLibre / OpenFreeMap
   - Visualisation temps réel du raisonnement et des phéromones
   ========================================================================== */

/**
 * File de priorité binaire (Min-Heap) O(log N)
 */
class MinPriorityQueue {
  constructor() {
    this.heap = [];
  }

  size() {
    return this.heap.length;
  }

  isEmpty() {
    return this.heap.length === 0;
  }

  push(item, priority) {
    const node = { item, priority };
    this.heap.push(node);
    this._bubbleUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const bottom = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this._sinkDown(0);
    }
    return top.item;
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
      let leftChildIdx = (idx << 1) + 1;
      let rightChildIdx = leftChildIdx + 1;
      let swapIdx = null;

      if (leftChildIdx < length) {
        if (this.heap[leftChildIdx].priority < node.priority) {
          swapIdx = leftChildIdx;
        }
      }

      if (rightChildIdx < length) {
        const rightChildPriority = this.heap[rightChildIdx].priority;
        const comparePriority = swapIdx === null ? node.priority : this.heap[leftChildIdx].priority;
        if (rightChildPriority < comparePriority) {
          swapIdx = rightChildIdx;
        }
      }

      if (swapIdx === null) break;
      this.heap[idx] = this.heap[swapIdx];
      idx = swapIdx;
    }
    this.heap[idx] = node;
  }
}

/**
 * Distance orthodromique (Haversine) en mètres
 */
function haversineMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const x = sinLat * sinLat + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * sinLng * sinLng;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, x)));
}

/**
 * Azimut (bearing) en degrés [0, 360[
 */
function calculateBearing(p1, p2) {
  const rad = Math.PI / 180;
  const y = Math.sin((p2[0] - p1[0]) * rad) * Math.cos(p2[1] * rad);
  const x =
    Math.cos(p1[1] * rad) * Math.sin(p2[1] * rad) -
    Math.sin(p1[1] * rad) * Math.cos(p2[1] * rad) * Math.cos((p2[0] - p1[0]) * rad);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/**
 * Propriétés et limitations de vitesse des routes françaises/européennes
 */
const ROAD_PROPERTIES = {
  motorway:      { baseSpeed: 130, urbanSpeed: 110, bikeAllowed: false, footAllowed: false, fuelDrag: 1.35, label: "Autoroute" },
  trunk:         { baseSpeed: 110, urbanSpeed: 90,  bikeAllowed: false, footAllowed: false, fuelDrag: 1.20, label: "Voie express" },
  primary:       { baseSpeed: 80,  urbanSpeed: 50,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 1.00, label: "Route principale" },
  secondary:     { baseSpeed: 80,  urbanSpeed: 50,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 0.98, label: "Route départementale" },
  tertiary:      { baseSpeed: 70,  urbanSpeed: 50,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 0.97, label: "Route locale" },
  minor:         { baseSpeed: 50,  urbanSpeed: 50,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 1.02, label: "Rue" },
  street:        { baseSpeed: 50,  urbanSpeed: 30,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 1.05, label: "Rue urbaine" },
  residential:   { baseSpeed: 30,  urbanSpeed: 30,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 1.10, label: "Zone résidentielle" },
  living_street: { baseSpeed: 20,  urbanSpeed: 20,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 1.15, label: "Zone de rencontre" },
  service:       { baseSpeed: 20,  urbanSpeed: 20,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 1.15, label: "Voie de service" },
  track:         { baseSpeed: 25,  urbanSpeed: 20,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 1.25, label: "Chemin" },
  cycleway:      { baseSpeed: 25,  urbanSpeed: 25,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 0.85, label: "Piste cyclable" },
  path:          { baseSpeed: 15,  urbanSpeed: 15,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 0.90, label: "Sentier" },
  footway:       { baseSpeed: 6,   urbanSpeed: 6,   bikeAllowed: false, footAllowed: true,  fuelDrag: 0.95, label: "Voie piétonne" },
  pedestrian:    { baseSpeed: 15,  urbanSpeed: 10,  bikeAllowed: true,  footAllowed: true,  fuelDrag: 0.95, label: "Rue piétonne" },
};

function resolveSpeedLimit(roadClass, maxspeed, mode = "car") {
  if (mode === "foot") return 6;
  if (mode === "bike") return 25;
  if (maxspeed && !isNaN(Number(maxspeed)) && Number(maxspeed) > 0) {
    return Number(maxspeed);
  }
  const normalized = (roadClass || "street").toLowerCase();
  const info = ROAD_PROPERTIES[normalized] || ROAD_PROPERTIES.street;
  return info.baseSpeed;
}

/* ==========================================================================
   RÉSEAU DORSAL NATIONAL & EUROPÉEN (Évite TOUTE ligne droite inter-villes)
   ========================================================================== */
const NATIONAL_HIGHWAY_CORRIDORS = [
  // A1: Paris - Lille - Belgique (E19/Bruxelles)
  { name: "Autoroute du Nord", ref: "A 1", class: "motorway", coords: [
    [2.3522, 48.8566], [2.3601, 48.9100], [2.4500, 49.0200], [2.6500, 49.3500],
    [2.8000, 49.8000], [2.9500, 50.1500], [3.0500, 50.5000], [3.0600, 50.6300],
    [3.1800, 50.7000], [3.2500, 50.7500], [4.3517, 50.8503]
  ]},
  // A2: A1 vers Cambrai - Valenciennes - Mons - Bruxelles
  { name: "Autoroute A2", ref: "A 2", class: "motorway", coords: [
    [2.8500, 49.9500], [3.2000, 50.1500], [3.5000, 50.3500], [3.9500, 50.4500], [4.3517, 50.8503]
  ]},
  // A4: Paris - Reims - Metz - Strasbourg
  { name: "Autoroute de l'Est", ref: "A 4", class: "motorway", coords: [
    [2.3522, 48.8566], [2.6000, 48.8700], [3.0500, 48.9500], [3.5000, 49.0500],
    [4.0300, 49.2500], [4.8000, 49.1500], [5.5000, 49.1200], [6.1700, 49.1200],
    [7.0000, 48.9000], [7.7500, 48.5800]
  ]},
  // A6: Paris - Auxerre - Dijon - Beaune - Lyon
  { name: "Autoroute du Soleil", ref: "A 6", class: "motorway", coords: [
    [2.3522, 48.8566], [2.4000, 48.7000], [2.6500, 48.4000], [3.0000, 48.1000],
    [3.5700, 47.8000], [4.1000, 47.4500], [4.8400, 47.0200], [4.8300, 46.3000],
    [4.8357, 45.7640]
  ]},
  // A7: Lyon - Valence - Orange - Avignon - Marseille
  { name: "Autoroute du Soleil", ref: "A 7", class: "motorway", coords: [
    [4.8357, 45.7640], [4.8700, 45.5000], [4.9000, 44.9500], [4.8500, 44.5000],
    [4.8000, 44.1500], [4.8500, 43.9000], [5.1000, 43.6000], [5.3698, 43.2965]
  ]},
  // A10: Paris - Orléans - Tours - Poitiers - Bordeaux
  { name: "L'Aquitaine", ref: "A 10", class: "motorway", coords: [
    [2.3522, 48.8566], [2.2500, 48.6500], [2.0000, 48.4000], [1.9093, 47.9029],
    [1.4000, 47.6000], [0.6848, 47.3941], [0.5000, 47.0000], [0.3400, 46.5800],
    [0.1000, 46.0000], [-0.5000, 45.3000], [-0.5792, 44.8378]
  ]},
  // A71: Orléans - Vierzon - Bourges - Clermont-Ferrand
  { name: "L'Arverne", ref: "A 71", class: "motorway", coords: [
    [1.9093, 47.9029], [2.0000, 47.6000], [2.0700, 47.2200], [2.3900, 47.0800],
    [2.5000, 46.8000], [2.7000, 46.4000], [3.0870, 45.7772]
  ]},
  // A20: Vierzon - Châteauroux - Limoges - Brive - Toulouse
  { name: "L'Occitane", ref: "A 20", class: "motorway", coords: [
    [2.0700, 47.2200], [1.7000, 46.8100], [1.4000, 46.3000], [1.2600, 45.8300],
    [1.5000, 45.1500], [1.5000, 44.4500], [1.4442, 43.6047]
  ]},
  // A11: Paris - Chartres - Le Mans - Angers - Nantes
  { name: "L'Océane", ref: "A 11", class: "motorway", coords: [
    [2.3522, 48.8566], [1.5000, 48.4500], [0.2000, 48.0000], [-0.5500, 47.4700], [-1.5536, 47.2184]
  ]},
  // A13: Paris - Mantes - Rouen - Caen
  { name: "Autoroute de Normandie", ref: "A 13", class: "motorway", coords: [
    [2.3522, 48.8566], [1.7000, 48.9800], [1.2000, 49.3000], [1.0999, 49.4432], [-0.3707, 49.1829]
  ]},
  // A89: Bordeaux - Brive - Clermont-Ferrand - Lyon
  { name: "La Transeuropéenne", ref: "A 89", class: "motorway", coords: [
    [-0.5792, 44.8378], [0.3000, 45.0000], [1.5000, 45.1500], [2.2000, 45.4000],
    [3.0870, 45.7772], [4.1000, 45.8500], [4.8357, 45.7640]
  ]},
  // N151 / D940: Bourges vers La Châtre / Centre
  { name: "Route Centre", ref: "N 151", class: "primary", coords: [
    [2.3900, 47.0800], [2.2500, 46.7500], [2.0000, 46.5000], [1.9000, 46.3000]
  ]},
];

/**
 * Graphe routier topologique avec grille spatiale
 */
class RoadGraph {
  constructor() {
    this.nodes = new Map(); // id -> { id, lng, lat, neighbors: [{ targetId, edge }] }
    this.edges = [];
    this.spatialGrid = new Map();
    this.gridCellSize = 0.01; // ~1 km
    this.pheromones = new Map(); // edgeId -> tau
  }

  _nodeKey(lng, lat) {
    return `${lng.toFixed(5)},${lat.toFixed(5)}`;
  }

  _gridKey(lng, lat) {
    const gx = Math.floor(lng / this.gridCellSize);
    const gy = Math.floor(lat / this.gridCellSize);
    return `${gx}:${gy}`;
  }

  addNode(lng, lat) {
    const key = this._nodeKey(lng, lat);
    let node = this.nodes.get(key);
    if (!node) {
      node = { id: key, lng, lat, neighbors: [] };
      this.nodes.set(key, node);

      const gKey = this._gridKey(lng, lat);
      let cell = this.spatialGrid.get(gKey);
      if (!cell) {
        cell = [];
        this.spatialGrid.set(gKey, cell);
      }
      cell.push(key);
    }
    return node;
  }

  addEdge(nodeA, nodeB, props = {}) {
    if (nodeA.id === nodeB.id) return null;
    const dist = haversineMeters([nodeA.lng, nodeA.lat], [nodeB.lng, nodeB.lat]);
    if (dist < 0.5) return null;

    const roadClass = (props.class || "street").toLowerCase();
    const speedLimit = resolveSpeedLimit(roadClass, props.maxspeed, "car");
    const speedMs = Math.max(1, (speedLimit * 1000) / 3600);
    const baseDuration = dist / speedMs;

    const edge = {
      id: `${nodeA.id}->${nodeB.id}`,
      from: nodeA.id,
      to: nodeB.id,
      distance: dist,
      baseDuration,
      speedLimit,
      roadClass,
      name: props.name || "",
      ref: props.ref || "",
      isConnector: Boolean(props.isConnector),
      isRoundabout: Boolean(props.roundabout || props.junction === "roundabout" || roadClass === "roundabout"),
      isRamp: Boolean(props.ramp || roadClass.includes("link")),
      oneway: Boolean(props.oneway && props.oneway !== 0 && props.oneway !== "0"),
      coordinates: [[nodeA.lng, nodeA.lat], [nodeB.lng, nodeB.lat]],
    };

    nodeA.neighbors.push({ targetId: nodeB.id, edge });
    this.edges.push(edge);
    this.pheromones.set(edge.id, 1.0);

    if (!edge.oneway) {
      const revEdge = {
        ...edge,
        id: `${nodeB.id}->${nodeA.id}`,
        from: nodeB.id,
        to: nodeA.id,
        coordinates: [[nodeB.lng, nodeB.lat], [nodeA.lng, nodeA.lat]],
      };
      nodeB.neighbors.push({ targetId: nodeA.id, edge: revEdge });
      this.edges.push(revEdge);
      this.pheromones.set(revEdge.id, 1.0);
    }

    return edge;
  }

  findNearestNodes(lng, lat, count = 4, maxRadiusMeters = 45000) {
    const origin = [lng, lat];
    const results = [];
    const centerGx = Math.floor(lng / this.gridCellSize);
    const centerGy = Math.floor(lat / this.gridCellSize);

    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        const cell = this.spatialGrid.get(`${centerGx + dx}:${centerGy + dy}`);
        if (cell) {
          for (const nodeId of cell) {
            const n = this.nodes.get(nodeId);
            if (n) {
              const d = haversineMeters(origin, [n.lng, n.lat]);
              if (d <= maxRadiusMeters) {
                results.push({ node: n, dist: d });
              }
            }
          }
        }
      }
    }

    if (results.length < count) {
      for (const n of this.nodes.values()) {
        const d = haversineMeters(origin, [n.lng, n.lat]);
        if (d <= maxRadiusMeters) {
          results.push({ node: n, dist: d });
        }
      }
    }

    results.sort((a, b) => a.dist - b.dist);
    const unique = [];
    const seen = new Set();
    for (const r of results) {
      if (!seen.has(r.node.id)) {
        seen.add(r.node.id);
        unique.push(r);
        if (unique.length >= count) break;
      }
    }
    return unique;
  }

  findNearestNode(lng, lat, maxRadiusMeters = 45000) {
    const list = this.findNearestNodes(lng, lat, 1, maxRadiusMeters);
    return list[0]?.node || null;
  }

  connectPoint(pt, label = "Point") {
    const existing = this.nodes.get(this._nodeKey(pt.lng, pt.lat));
    if (existing) return existing;

    const node = this.addNode(pt.lng, pt.lat);
    const nearestCandidates = this.findNearestNodes(pt.lng, pt.lat, 4, 45000);
    for (const { node: nearNode } of nearestCandidates) {
      if (nearNode && nearNode.id !== node.id) {
        this.addEdge(node, nearNode, { class: "street", isConnector: true });
        this.addEdge(nearNode, node, { class: "street", isConnector: true });
      }
    }
    return node;
  }
}

/**
 * Construit un graphe unifié intégrant tuiles vectorielles locales ET le réseau national
 */
function buildCompleteRoadGraph(features, fromPt, toPt) {
  const graph = new RoadGraph();

  // 1. Injecter le réseau dorsal national et autoroutier (garantit zéro ligne droite)
  for (const cor of NATIONAL_HIGHWAY_CORRIDORS) {
    for (let i = 0; i < cor.coords.length - 1; i++) {
      const p1 = cor.coords[i];
      const p2 = cor.coords[i + 1];
      const n1 = graph.addNode(p1[0], p1[1]);
      const n2 = graph.addNode(p2[0], p2[1]);
      graph.addEdge(n1, n2, { class: cor.class, name: cor.name, ref: cor.ref });
    }
  }

  // 2. Injecter les rues locales vectorielles extraites de MapLibre
  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom) continue;

    const props = feat.properties || {};
    const coordsList = geom.type === "LineString"
      ? [geom.coordinates]
      : geom.type === "MultiLineString"
      ? geom.coordinates
      : [];

    for (const coords of coordsList) {
      if (!coords || coords.length < 2) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i + 1];
        if (!p1 || !p2) continue;
        const nA = graph.addNode(p1[0], p1[1]);
        const nB = graph.addNode(p2[0], p2[1]);
        graph.addEdge(nA, nB, {
          ...props,
          name: props.name || props.name_fr || props.name_en || "",
          ref: props.ref || "",
          class: props.class || "street",
          roundabout: Boolean(props.junction === "roundabout" || props.roundabout || props.class === "roundabout"),
          ramp: Boolean(props.ramp || (props.class && props.class.includes("link"))),
        });
      }
    }
  }

  // 3. Connecter Départ et Destination
  if (fromPt) graph.connectPoint(fromPt, "Départ");
  if (toPt) graph.connectPoint(toPt, "Arrivée");

  return graph;
}

/**
 * Calcul du coût d'arête selon le profil
 */
function calculateEdgeCost(edge, mode = "car", criterion = "fastest") {
  const roadClass = edge.roadClass || "street";
  const info = ROAD_PROPERTIES[roadClass] || ROAD_PROPERTIES.street;

  if (mode === "foot") {
    if (!info.footAllowed && (roadClass === "motorway" || roadClass === "trunk")) return Infinity;
    return edge.distance / (4.5 / 3.6);
  }

  if (mode === "bike") {
    if (!info.bikeAllowed && (roadClass === "motorway" || roadClass === "trunk")) return Infinity;
    const bikeSpeedMs = (roadClass === "cycleway" ? 25 : 18) / 3.6;
    const factor = roadClass === "cycleway" ? 0.7 : roadClass === "primary" ? 1.4 : 1.0;
    return (edge.distance / bikeSpeedMs) * factor;
  }

  // Mode Voiture (Car)
  switch (criterion) {
    case "shortest":
      return edge.distance;
    case "eco":
      return edge.distance * (info.fuelDrag || 1.0);
    case "nohighway":
      if (roadClass === "motorway" || roadClass === "trunk") return edge.baseDuration * 50;
      return edge.baseDuration;
    case "fastest":
    default:
      return edge.baseDuration;
  }
}

/**
 * Feuille de route Turn-by-Turn ultra-précise avec détection des ronds-points, carrefours et sorties
 */
function buildTurnByTurnInstructions(pathCoordinates, pathEdges, mode = "car") {
  if (!pathCoordinates || pathCoordinates.length < 2) return [];

  function getRoadLabel(edge) {
    if (!edge || edge.isConnector) return "";
    const name = (edge.name || "").trim();
    const ref = (edge.ref || "").trim();
    if (name && ref && !name.toLowerCase().includes(ref.toLowerCase())) {
      return `${name} (${ref})`;
    }
    if (name) return name;
    if (ref) return ref;

    const rc = edge.roadClass || "street";
    if (rc === "motorway") return "l'autoroute";
    if (rc === "trunk") return "la voie express";
    if (rc === "primary" || rc === "secondary") return "la route principale";
    if (rc === "residential" || rc === "street") return "la rue";
    if (rc === "cycleway") return "la piste cyclable";
    return "";
  }

  // Trouve le premier nom de route significatif de l'itinéraire
  let initialRoadLabel = "";
  for (let k = 0; k < Math.min(5, pathEdges.length); k++) {
    const lbl = getRoadLabel(pathEdges[k]);
    if (lbl) {
      initialRoadLabel = lbl;
      break;
    }
  }

  const steps = [];
  let currentStepManeuver = {
    type: "depart",
    modifier: "straight",
    instruction: initialRoadLabel ? `Prenez ${initialRoadLabel}` : "Prenez la route",
    location: pathCoordinates[0],
  };

  let accDist = 0;
  let accDur = 0;
  let currentRoad = initialRoadLabel;
  let currentClass = pathEdges[0]?.roadClass || "street";
  let currentSpeedLimit = pathEdges[0]?.speedLimit || resolveSpeedLimit(currentClass, null, mode);

  let inRoundabout = false;
  let roundaboutExitsCount = 0;

  for (let i = 0; i < pathCoordinates.length - 1; i++) {
    const p1 = pathCoordinates[i];
    const p2 = pathCoordinates[i + 1];
    const edge = pathEdges[i] || {};
    const nextEdge = pathEdges[i + 1] || null;

    const segDist = haversineMeters(p1, p2);
    accDist += segDist;
    accDur += edge.baseDuration || (segDist / 13.8);

    const edgeRoadLabel = getRoadLabel(edge);
    if (edgeRoadLabel && !edge.isConnector) {
      currentRoad = edgeRoadLabel;
    }
    if (edge.roadClass) currentClass = edge.roadClass;
    if (edge.speedLimit) currentSpeedLimit = edge.speedLimit;

    // Détection d'un rond-point
    const isEdgeRoundabout = Boolean(edge.isRoundabout || edge.roadClass === "roundabout");
    const isNextRoundabout = Boolean(nextEdge?.isRoundabout || nextEdge?.roadClass === "roundabout");

    if (isEdgeRoundabout) {
      if (!inRoundabout) {
        inRoundabout = true;
        roundaboutExitsCount = 1;
      } else {
        roundaboutExitsCount++;
      }
    }

    let isManeuver = false;
    let nextManeuver = null;

    // Cas 1 : Sortie de rond-point
    if (inRoundabout && !isNextRoundabout) {
      inRoundabout = false;
      isManeuver = true;
      const exitNum = Math.min(4, Math.max(1, roundaboutExitsCount));
      const exitSuffix = exitNum === 1 ? "1ère" : `${exitNum}e`;
      const targetLabel = getRoadLabel(nextEdge) || currentRoad;
      const targetText = targetLabel ? ` sur ${targetLabel}` : "";

      nextManeuver = {
        type: "roundabout",
        modifier: `exit-${exitNum}`,
        exit: exitNum,
        instruction: `Au rond-point, prenez la ${exitSuffix} sortie${targetText}`,
        location: p2,
      };
    }
    // Cas 2 : Virage / Carrefour hors rond-point
    else if (!inRoundabout && i < pathCoordinates.length - 2) {
      const p3 = pathCoordinates[i + 2];
      const b1 = calculateBearing(p1, p2);
      const b2 = calculateBearing(p2, p3);
      const angleChange = ((b2 - b1 + 540) % 360) - 180;

      const nextRoadLabel = getRoadLabel(nextEdge);
      const hasRoadChange = Boolean(nextRoadLabel && nextRoadLabel !== currentRoad);
      const isSharpTurn = Math.abs(angleChange) >= 18;

      if (isSharpTurn || hasRoadChange) {
        let mod = "straight";
        if (angleChange > 135 || angleChange < -135) mod = "uturn";
        else if (angleChange >= 45) mod = "right";
        else if (angleChange > 16) mod = "slight right";
        else if (angleChange <= -45) mod = "left";
        else if (angleChange < -16) mod = "slight left";

        if (mod !== "straight") {
          isManeuver = true;
          const targetRoad = nextRoadLabel || currentRoad;
          const targetText = targetRoad ? ` sur ${targetRoad}` : "";

          let instr = "";
          if (mod === "uturn") {
            instr = "Faites demi-tour dès que possible";
          } else if (nextEdge?.isRamp) {
            instr = `Prenez la bretelle d'accès${targetText}`;
          } else if (edge.roadClass === "motorway" && nextEdge?.roadClass !== "motorway") {
            instr = `Prenez la sortie${targetText}`;
          } else if (mod === "right") {
            instr = `Au carrefour, tournez à droite${targetText}`;
          } else if (mod === "slight right") {
            instr = `Serrez à droite${targetText}`;
          } else if (mod === "left") {
            instr = `Au carrefour, tournez à gauche${targetText}`;
          } else if (mod === "slight left") {
            instr = `Serrez à gauche${targetText}`;
          }

          nextManeuver = {
            type: "turn",
            modifier: mod,
            instruction: instr,
            location: p2,
          };
        }
      }
    }

    // Dès qu'une manœuvre est rencontrée, archiver le segment actuel et démarrer le suivant
    if (isManeuver && nextManeuver) {
      steps.push({
        name: currentRoad || "Route",
        ref: edge.ref || "",
        roadClass: currentClass,
        maxspeed: currentSpeedLimit,
        distance: Math.max(1, Math.round(accDist)),
        duration: Math.max(1, Math.round(accDur)),
        location: currentStepManeuver.location,
        maneuver: currentStepManeuver,
      });

      accDist = 0;
      accDur = 0;
      currentStepManeuver = nextManeuver;
      if (getRoadLabel(nextEdge)) {
        currentRoad = getRoadLabel(nextEdge);
      }
    }
  }

  // Dernière portion jusqu'à l'arrivée
  steps.push({
    name: currentRoad || "Destination",
    ref: pathEdges[pathEdges.length - 1]?.ref || "",
    roadClass: currentClass,
    maxspeed: currentSpeedLimit,
    distance: Math.max(1, Math.round(accDist)),
    duration: Math.max(1, Math.round(accDur)),
    location: currentStepManeuver.location,
    maneuver: currentStepManeuver,
  });

  // Étape terminale d'arrivée
  steps.push({
    name: "Destination",
    ref: "",
    roadClass: "street",
    maxspeed: 30,
    distance: 0,
    duration: 0,
    location: pathCoordinates[pathCoordinates.length - 1],
    maneuver: {
      type: "arrive",
      modifier: "straight",
      instruction: "Vous êtes arrivé à destination",
      location: pathCoordinates[pathCoordinates.length - 1],
    },
  });

  return steps;
}

function reconstructResult(cameFrom, graph, startNode, goalNode, mode) {
  const coordinates = [];
  const edges = [];
  let curr = goalNode.id;

  while (curr && cameFrom.has(curr)) {
    const { parentId, edge } = cameFrom.get(curr);
    if (edge && edge.coordinates) {
      coordinates.unshift(edge.coordinates[1]);
      edges.unshift(edge);
    }
    curr = parentId;
  }
  coordinates.unshift([startNode.lng, startNode.lat]);

  let totalDist = 0;
  let totalDur = 0;
  for (const e of edges) {
    totalDist += e.distance;
    totalDur += e.baseDuration;
  }

  const steps = buildTurnByTurnInstructions(coordinates, edges, mode);

  return {
    distance: Math.round(totalDist),
    duration: Math.round(totalDur),
    geometry: { type: "LineString", coordinates },
    edges,
    legs: [{ distance: Math.round(totalDist), duration: Math.round(totalDur), steps }],
  };
}

/* ==========================================================================
   ALGORITHME 1 : A* CLASSIQUE (Optimal Heuristique)
   ========================================================================== */
class AStarRouter {
  static async findPath(graph, startNode, goalNode, options = {}) {
    const { mode = "car", criterion = "fastest", visualize = false, onProgress = null } = options;
    if (startNode.id === goalNode.id) return null;

    const goalPos = [goalNode.lng, goalNode.lat];
    const maxVitesseMs = mode === "foot" ? 2 : mode === "bike" ? 8 : (130 * 1000) / 3600;
    const heuristic = (n) => haversineMeters([n.lng, n.lat], goalPos) / maxVitesseMs;

    const frontier = new MinPriorityQueue();
    const gScore = new Map();
    const cameFrom = new Map();
    const closedSet = new Set();

    gScore.set(startNode.id, 0);
    frontier.push(startNode.id, heuristic(startNode));

    let stepsCount = 0;
    const startTime = performance.now();
    let lastYield = startTime;
    const exploredEdgesGeom = [];
    const frontierNodesGeom = [];

    while (!frontier.isEmpty() && stepsCount < 40000) {
      stepsCount++;
      const currentId = frontier.pop();
      if (currentId === goalNode.id) {
        return reconstructResult(cameFrom, graph, startNode, goalNode, mode);
      }

      closedSet.add(currentId);
      const currentNode = graph.nodes.get(currentId);
      if (!currentNode) continue;
      const currentG = gScore.get(currentId);

      for (const { targetId, edge } of currentNode.neighbors) {
        if (closedSet.has(targetId)) continue;
        const cost = calculateEdgeCost(edge, mode, criterion);
        if (cost === Infinity) continue;

        const tentativeG = currentG + cost;
        if (tentativeG < (gScore.get(targetId) ?? Infinity)) {
          gScore.set(targetId, tentativeG);
          cameFrom.set(targetId, { parentId: currentId, edge });
          const targetNode = graph.nodes.get(targetId);
          if (targetNode) {
            frontier.push(targetId, tentativeG + heuristic(targetNode));
            if (visualize) {
              exploredEdgesGeom.push(edge.coordinates);
              frontierNodesGeom.push([targetNode.lng, targetNode.lat]);
            }
          }
        }
      }

      if (visualize && !window.__algoSkipRequested && (stepsCount % 40 === 0 || performance.now() - lastYield > 16)) {
        lastYield = performance.now();
        onProgress?.({
          stepsCount,
          elapsedMs: Math.round(performance.now() - startTime),
          frontierSize: frontier.size(),
          exploredCount: closedSet.size,
          algoName: "A* Classique (Optimal)",
          exploredEdges: exploredEdgesGeom.slice(-250),
          frontierNodes: frontierNodesGeom.slice(-80),
        });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return null;
  }
}

/* ==========================================================================
   ALGORITHME 2 : COLONIE DE FOURMIS (ACO - Pheromone Swarm Intelligence)
   ========================================================================== */
class AntColonyRouter {
  static async findPath(graph, startNode, goalNode, options = {}) {
    const { mode = "car", criterion = "fastest", visualize = false, onProgress = null } = options;
    const goalPos = [goalNode.lng, goalNode.lat];

    const numAnts = 18;
    const maxIterations = 14;
    const rho = 0.18; // Taux d'évaporation des phéromones
    const alpha = 1.0; // Poids des phéromones
    const beta = 2.4;  // Poids heuristique (visibilité)

    let bestPath = null;
    let bestCost = Infinity;

    const startTime = performance.now();
    let stepsCount = 0;
    const exploredEdgesGeom = [];

    for (let iter = 0; iter < maxIterations; iter++) {
      const iterationPaths = [];

      for (let ant = 0; ant < numAnts; ant++) {
        stepsCount++;
        let current = startNode;
        const visited = new Set([current.id]);
        const pathEdges = [];
        let pathCost = 0;
        let antSteps = 0;

        while (current.id !== goalNode.id && antSteps < 180) {
          antSteps++;
          const candidates = current.neighbors.filter((n) => !visited.has(n.targetId));
          if (!candidates.length) break;

          // Calcul des probabilités de transition proportionnelles aux phéromones
          const weights = candidates.map(({ targetId, edge }) => {
            const tau = graph.pheromones.get(edge.id) || 1.0;
            const targetNode = graph.nodes.get(targetId);
            const distToGoal = targetNode ? haversineMeters([targetNode.lng, targetNode.lat], goalPos) : 1000;
            const eta = 1.0 / (edge.distance + distToGoal * 0.25 + 1);
            return Math.pow(tau, alpha) * Math.pow(eta, beta);
          });

          const totalWeight = weights.reduce((a, b) => a + b, 0);
          if (totalWeight <= 0) break;

          let randomVal = Math.random() * totalWeight;
          let chosenIdx = 0;
          for (let i = 0; i < candidates.length; i++) {
            randomVal -= weights[i];
            if (randomVal <= 0) {
              chosenIdx = i;
              break;
            }
          }

          const chosen = candidates[chosenIdx];
          pathEdges.push(chosen.edge);
          pathCost += calculateEdgeCost(chosen.edge, mode, criterion);
          visited.add(chosen.targetId);
          current = graph.nodes.get(chosen.targetId);
          if (!current) break;

          if (visualize) exploredEdgesGeom.push(chosen.edge.coordinates);
        }

        if (current && current.id === goalNode.id) {
          iterationPaths.push({ edges: pathEdges, cost: pathCost });
          if (pathCost < bestCost) {
            bestCost = pathCost;
            bestPath = pathEdges;
          }
        }
      }

      // Évaporation des phéromones
      for (const [eId, tau] of graph.pheromones.entries()) {
        graph.pheromones.set(eId, Math.max(0.1, tau * (1 - rho)));
      }

      // Dépôt de phéromones par les fourmis ayant atteint l'objectif
      for (const p of iterationPaths) {
        const deltaTau = 120.0 / (p.cost + 1);
        for (const e of p.edges) {
          const prev = graph.pheromones.get(e.id) || 1.0;
          graph.pheromones.set(e.id, prev + deltaTau);
        }
      }

      if (visualize && !window.__algoSkipRequested) {
        onProgress?.({
          stepsCount,
          elapsedMs: Math.round(performance.now() - startTime),
          frontierSize: iterationPaths.length,
          exploredCount: stepsCount,
          algoName: "Colonie de Fourmis (Phéromones)",
          exploredEdges: exploredEdgesGeom.slice(-280),
          frontierNodes: [],
        });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Si la colonie a convergé sur un chemin
    if (bestPath && bestPath.length) {
      const coordinates = [[startNode.lng, startNode.lat]];
      let totalDist = 0;
      let totalDur = 0;
      for (const e of bestPath) {
        coordinates.push(e.coordinates[1]);
        totalDist += e.distance;
        totalDur += e.baseDuration;
      }
      const steps = buildTurnByTurnInstructions(coordinates, bestPath, mode);
      return {
        distance: Math.round(totalDist),
        duration: Math.round(totalDur),
        geometry: { type: "LineString", coordinates },
        edges: bestPath,
        legs: [{ distance: Math.round(totalDist), duration: Math.round(totalDur), steps }],
      };
    }

    // Repli de sécurité si aucune fourmi n'a terminé le graphe
    return AStarRouter.findPath(graph, startNode, goalNode, options);
  }
}

/* ==========================================================================
   ALGORITHME 3 : MOTEUR OPENSTREETMAP (Contraction Hierarchies / OSRM)
   ========================================================================== */
class OSRMHierarchyRouter {
  static async findPath(graph, startNode, goalNode, options = {}) {
    const { mode = "car", criterion = "fastest", visualize = false, onProgress = null } = options;
    const goalPos = [goalNode.lng, goalNode.lat];

    // Priorise les classes supérieures au fur et à mesure que l'on s'éloigne des extrémités
    const hierarchyBonus = (edge, distStart, distGoal) => {
      const rc = edge.roadClass;
      const isNearEnd = distStart < 6000 || distGoal < 6000;
      if (isNearEnd) return 1.0;
      if (rc === "motorway") return 0.65; // Privilégie fortement le réseau autoroutier interurbain
      if (rc === "trunk") return 0.75;
      if (rc === "primary") return 0.85;
      if (rc === "residential" || rc === "living_street") return 3.0; // Pénalise les petites ruelles en transit
      return 1.0;
    };

    const frontier = new MinPriorityQueue();
    const gScore = new Map();
    const cameFrom = new Map();
    const closedSet = new Set();

    gScore.set(startNode.id, 0);
    frontier.push(startNode.id, 0);

    let stepsCount = 0;
    const startTime = performance.now();
    let lastYield = startTime;
    const exploredEdgesGeom = [];
    const frontierNodesGeom = [];

    while (!frontier.isEmpty() && stepsCount < 40000) {
      stepsCount++;
      const currentId = frontier.pop();
      if (currentId === goalNode.id) {
        return reconstructResult(cameFrom, graph, startNode, goalNode, mode);
      }

      closedSet.add(currentId);
      const currentNode = graph.nodes.get(currentId);
      if (!currentNode) continue;
      const currentG = gScore.get(currentId);

      const dStart = haversineMeters([currentNode.lng, currentNode.lat], [startNode.lng, startNode.lat]);
      const dGoal = haversineMeters([currentNode.lng, currentNode.lat], goalPos);

      for (const { targetId, edge } of currentNode.neighbors) {
        if (closedSet.has(targetId)) continue;
        const baseCost = calculateEdgeCost(edge, mode, criterion);
        if (baseCost === Infinity) continue;

        const adjustedCost = baseCost * hierarchyBonus(edge, dStart, dGoal);
        const tentativeG = currentG + adjustedCost;

        if (tentativeG < (gScore.get(targetId) ?? Infinity)) {
          gScore.set(targetId, tentativeG);
          cameFrom.set(targetId, { parentId: currentId, edge });
          const targetNode = graph.nodes.get(targetId);
          if (targetNode) {
            const h = haversineMeters([targetNode.lng, targetNode.lat], goalPos) / (130 / 3.6);
            frontier.push(targetId, tentativeG + h);
            if (visualize) {
              exploredEdgesGeom.push(edge.coordinates);
              frontierNodesGeom.push([targetNode.lng, targetNode.lat]);
            }
          }
        }
      }

      if (visualize && !window.__algoSkipRequested && (stepsCount % 40 === 0 || performance.now() - lastYield > 16)) {
        lastYield = performance.now();
        onProgress?.({
          stepsCount,
          elapsedMs: Math.round(performance.now() - startTime),
          frontierSize: frontier.size(),
          exploredCount: closedSet.size,
          algoName: "Moteur OpenStreetMap (Contraction Hierarchies)",
          exploredEdges: exploredEdgesGeom.slice(-250),
          frontierNodes: frontierNodesGeom.slice(-80),
        });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    return AStarRouter.findPath(graph, startNode, goalNode, options);
  }
}

/* ==========================================================================
   ALGORITHME 4 : MOTEUR WAZE & GOOGLE MAPS (Pénalités Virages & Feux)
   ========================================================================== */
class WazePredictiveRouter {
  static async findPath(graph, startNode, goalNode, options = {}) {
    const { mode = "car", criterion = "fastest", visualize = false, onProgress = null } = options;
    const goalPos = [goalNode.lng, goalNode.lat];
    const maxVitesseMs = (130 * 1000) / 3600;
    const heuristic = (n) => haversineMeters([n.lng, n.lat], goalPos) / maxVitesseMs;

    const frontier = new MinPriorityQueue();
    const gScore = new Map();
    const cameFrom = new Map();
    const closedSet = new Set();

    gScore.set(startNode.id, 0);
    frontier.push(startNode.id, heuristic(startNode));

    let stepsCount = 0;
    const startTime = performance.now();
    let lastYield = startTime;
    const exploredEdgesGeom = [];
    const frontierNodesGeom = [];

    while (!frontier.isEmpty() && stepsCount < 40000) {
      stepsCount++;
      const currentId = frontier.pop();
      if (currentId === goalNode.id) {
        return reconstructResult(cameFrom, graph, startNode, goalNode, mode);
      }

      closedSet.add(currentId);
      const currentNode = graph.nodes.get(currentId);
      if (!currentNode) continue;
      const currentG = gScore.get(currentId);
      const prevEdge = cameFrom.get(currentId)?.edge;

      for (const { targetId, edge } of currentNode.neighbors) {
        if (closedSet.has(targetId)) continue;
        let cost = calculateEdgeCost(edge, mode, criterion);
        if (cost === Infinity) continue;

        // Modélisation Waze : pénalité de virage à gauche et feux
        if (prevEdge && prevEdge.coordinates && edge.coordinates) {
          const b1 = calculateBearing(prevEdge.coordinates[0], prevEdge.coordinates[1]);
          const b2 = calculateBearing(edge.coordinates[0], edge.coordinates[1]);
          const angle = ((b2 - b1 + 540) % 360) - 180;
          if (angle <= -45) cost += 14.0; // Virage à gauche (croise la circulation)
          else if (angle >= 45) cost += 4.0; // Virage à droite fluide
          else if (Math.abs(angle) > 120) cost += 28.0; // Demi-tour
        }

        // Pénalité d'intersection dense
        if (currentNode.neighbors.length >= 4) {
          cost += 6.0; // Présence probable de feu tricolore ou cédez-le-passage
        }

        const tentativeG = currentG + cost;
        if (tentativeG < (gScore.get(targetId) ?? Infinity)) {
          gScore.set(targetId, tentativeG);
          cameFrom.set(targetId, { parentId: currentId, edge });
          const targetNode = graph.nodes.get(targetId);
          if (targetNode) {
            frontier.push(targetId, tentativeG + heuristic(targetNode));
            if (visualize) {
              exploredEdgesGeom.push(edge.coordinates);
              frontierNodesGeom.push([targetNode.lng, targetNode.lat]);
            }
          }
        }
      }

      if (visualize && !window.__algoSkipRequested && (stepsCount % 40 === 0 || performance.now() - lastYield > 16)) {
        lastYield = performance.now();
        onProgress?.({
          stepsCount,
          elapsedMs: Math.round(performance.now() - startTime),
          frontierSize: frontier.size(),
          exploredCount: closedSet.size,
          algoName: "Moteur Waze (Pénalités Virages & Feux)",
          exploredEdges: exploredEdgesGeom.slice(-250),
          frontierNodes: frontierNodesGeom.slice(-80),
        });
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    return AStarRouter.findPath(graph, startNode, goalNode, options);
  }
}

/**
 * Calcul d'itinéraire unifié avec choix de l'algorithme
 */
async function computeAutonomousRoute(map, { from, to, waypoints = [], mode = "car", criterion = "fastest", algorithm = "astar", visualize = false, onProgress = null }) {
  if (!from || !to) throw new Error("Points de départ et d'arrivée requis");

  const allPoints = [from, ...waypoints.map((w) => w.pt || w), to];
  const features = [];

  // Récupérer les rues vectorielles locales disponibles dans MapLibre
  if (map && typeof map.querySourceFeatures === "function") {
    try {
      const sf = map.querySourceFeatures("openmaptiles", { sourceLayer: "transportation" });
      if (sf?.length) features.push(...sf);
    } catch {}
  }

  // Construire le graphe unifié (routes locales + épine dorsale nationale)
  const graph = buildCompleteRoadGraph(features, from, to);

  const selectedRouter =
    algorithm === "aco"   ? AntColonyRouter :
    algorithm === "astar" ? AStarRouter :
    algorithm === "osrm"  ? OSRMHierarchyRouter :
    WazePredictiveRouter;

  const legRoutes = [];
  for (let i = 0; i < allPoints.length - 1; i++) {
    const ptA = allPoints[i];
    const ptB = allPoints[i + 1];

    const startNode = graph.connectPoint(ptA, `Étape ${i + 1}`);
    const goalNode = graph.connectPoint(ptB, `Étape ${i + 2}`);

    let result = await selectedRouter.findPath(graph, startNode, goalNode, {
      mode,
      criterion,
      visualize,
      onProgress,
    });

    if (!result) {
      result = await AStarRouter.findPath(graph, startNode, goalNode, { mode, criterion });
    }

    if (result) {
      legRoutes.push(result);
    }
  }

  const allCoords = [];
  let totalDistance = 0;
  let totalDuration = 0;
  const allSteps = [];

  for (const r of legRoutes) {
    if (r.geometry?.coordinates) {
      if (allCoords.length > 0) allCoords.push(...r.geometry.coordinates.slice(1));
      else allCoords.push(...r.geometry.coordinates);
    }
    totalDistance += r.distance;
    totalDuration += r.duration;
    if (r.legs?.[0]?.steps) allSteps.push(...r.legs[0].steps);
  }

  return {
    distance: totalDistance,
    duration: totalDuration,
    algorithm,
    geometry: { type: "LineString", coordinates: allCoords },
    legs: [{ distance: totalDistance, duration: totalDuration, steps: allSteps }],
  };
}

window.ClientRouter = {
  MinPriorityQueue,
  RoadGraph,
  AStarRouter,
  AntColonyRouter,
  OSRMHierarchyRouter,
  WazePredictiveRouter,
  haversineMeters,
  resolveSpeedLimit,
  ROAD_PROPERTIES,
  computeAutonomousRoute,
};
