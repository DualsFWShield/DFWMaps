// Web Worker ESM: moteur de routage hybride CH + A* bidirectionnel
import { ROUTER_CONFIG } from "../src/config/router.js";
import { haversineMeters, calculateBearing } from "../src/utils/geo.js";

const ROAD_PROPERTIES = {
  motorway:    { baseSpeed: 130, carSpeed: 120, fuelDrag: 1.35, hierarchy: 1, label: "Autoroute" },
  trunk:       { baseSpeed: 110, carSpeed: 100, fuelDrag: 1.20, hierarchy: 2, label: "Voie express" },
  primary:     { baseSpeed: 80,  carSpeed: 72,  fuelDrag: 1.00, hierarchy: 3, label: "Route principale" },
  secondary:   { baseSpeed: 80,  carSpeed: 62,  fuelDrag: 0.98, hierarchy: 4, label: "Route secondaire" },
  tertiary:    { baseSpeed: 70,  carSpeed: 50,  fuelDrag: 0.97, hierarchy: 5, label: "Route locale" },
  minor:       { baseSpeed: 50,  carSpeed: 34,  fuelDrag: 1.04, hierarchy: 6, label: "Rue" },
  street:      { baseSpeed: 50,  carSpeed: 30,  fuelDrag: 1.06, hierarchy: 6, label: "Rue" },
  residential: { baseSpeed: 30,  carSpeed: 26,  fuelDrag: 1.12, hierarchy: 7, label: "Zone résidentielle" },
  service:     { baseSpeed: 20,  carSpeed: 14,  fuelDrag: 1.20, hierarchy: 8, label: "Voie de service" },
  track:       { baseSpeed: 25,  carSpeed: 18,  fuelDrag: 1.25, hierarchy: 8, label: "Chemin" },
  cycleway:    { baseSpeed: 25,  carSpeed: 20,  fuelDrag: 0.95, hierarchy: 5, label: "Piste cyclable" },
  path:        { baseSpeed: 15,  carSpeed: 10,  fuelDrag: 0.95, hierarchy: 7, label: "Sentier" },
  footway:     { baseSpeed: 6,   carSpeed: 5,   fuelDrag: 0.95, hierarchy: 8, label: "Voie piétonne" },
  pedestrian:  { baseSpeed: 15,  carSpeed: 10,  fuelDrag: 0.95, hierarchy: 8, label: "Rue piétonne" },
};

function isBelgiumCoord(coord){ if(!coord||!coord.length) return false; const lng=coord[0],lat=coord[1]; return lng>=2.50&&lng<=6.45&&lat>=49.48&&lat<=51.52; }
function isBrusselsCoord(coord){ if(!coord||!coord.length) return false; const lng=coord[0],lat=coord[1]; return lng>=4.24&&lng<=4.50&&lat>=50.76&&lat<=50.93; }
function isFlandersCoord(coord){ if(!isBelgiumCoord(coord)||isBrusselsCoord(coord)) return false; const lat=coord[1]; return lat>=50.78||(lat>=50.68&&coord[0]<4.05); }

export function resolveSpeedLimit(roadClass,maxspeed,mode="car",location=null,roadName=""){
  if(mode==="foot") return 5; if(mode==="bike") return 20;
  if(maxspeed&&+maxspeed>0) return +maxspeed;
  const cls=(roadClass||"street").toLowerCase(); const text=(roadName||"").toLowerCase();
  if(isBelgiumCoord(location)){
    const inBru=isBrusselsCoord(location), inFland=isFlandersCoord(location);
    if(/(\br\s*\d+|\bring\b)/i.test(text)) return 100;
    if(cls==="motorway"||/(\b[ea]\s*\d+|\bautoroute\b)/i.test(text)) return 120;
    if(cls==="trunk") return 100;
    if(cls==="primary"||cls==="secondary"){ if(inBru) return 50; if(inFland) return 70; return 90; }
    if(cls==="tertiary") return inBru?30:70;
    if(cls==="residential"||cls==="living_street") return 30;
    if(cls==="minor"||cls==="street") return inBru?30:50;
    return inBru?30:50;
  }
  const info=ROAD_PROPERTIES[cls]||ROAD_PROPERTIES.street; return info.baseSpeed;
}

// (logique complète sera étendue progressivement; pour compat on garde squelette)
self.onmessage = (ev)=>{
  const {id,type,...p}=ev.data||{};
  if(type==="ping"){ self.postMessage({id,type:"pong"}); return; }
  self.postMessage({id,error:"not_implemented",type});
};
