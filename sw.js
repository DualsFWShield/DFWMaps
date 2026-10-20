const VERSION = "mon-maps-v21";
const TILE_CACHE = "mon-maps-tiles-v21";
const SHELL_CACHE = VERSION;
const MAX_TILES = 950;

const SHELL = [
  "./",
  "index.html",
  "style.css",
  "piper-tts.js",
  "client-router.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

const LIB_HOSTS = ["unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const TILE_HOSTS = [
  "openstreetmap.org",
  "openstreetmap.fr",
  "opentopomap.org",
  "arcgisonline.com",
  "openfreemap.org",
];

function isTileHost(hostname){
  if(!hostname) return false;
  return TILE_HOSTS.some(h=>hostname===h||hostname.endsWith("."+h)) || hostname.includes("amazonaws.com");
}

self.addEventListener("install", (e)=>{
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c=>c.addAll(SHELL))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate", (e)=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==SHELL_CACHE&&k!==TILE_CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch", (e)=>{
  const req = e.request;
  if(req.method!=="GET") return;
  const url = new URL(req.url);
  if(isTileHost(url.hostname)){
    e.respondWith(staleWhileRevalidateTiles(req));
    return;
  }
  if(url.pathname.startsWith("/api/")){
    e.respondWith(fetch(req));
    return;
  }
  if(url.origin===location.origin || LIB_HOSTS.includes(url.hostname)){
    e.respondWith(staleWhileRevalidate(req));
    return;
  }
});

async function staleWhileRevalidate(req){
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, {ignoreSearch:true});
  const fetchPromise = fetch(req).then(res=>{
    if(res && (res.ok || res.type==="opaque")){
      cache.put(req, res.clone());
    }
    return res;
  }).catch(()=>cached);
  return cached || fetchPromise;
}

async function staleWhileRevalidateTiles(req){
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then(res=>{
    if(res && res.ok){
      cache.put(req, res.clone());
      trimTiles(cache);
    }
    return res;
  }).catch(()=>cached);
  return cached || fetchPromise;
}

async function trimTiles(cache){
  const keys = await cache.keys();
  if(keys.length>MAX_TILES){
    const toDelete = keys.slice(0, keys.length - MAX_TILES);
    await Promise.all(toDelete.map(k=>cache.delete(k)));
  }
}
