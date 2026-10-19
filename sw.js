"use strict";

const VERSION = "mon-maps-v19";
const TILE_CACHE = "mon-maps-tiles";
const MAX_TILES = 850;
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "piper-tts.js",
  "client-router.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png"
];
const LIB_HOSTS = ["unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

function isTileHost(hostname) {
  return (
    hostname.endsWith("openstreetmap.org") ||
    hostname.endsWith("openstreetmap.fr") ||
    hostname.endsWith("opentopomap.org") ||
    hostname.endsWith("arcgisonline.com") ||
    hostname.endsWith("openfreemap.org") ||
    hostname.includes("amazonaws.com")
  );
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (isTileHost(url.hostname)) {
    e.respondWith(tile(req));
  } else if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(req));
  } else if (url.origin === location.origin || LIB_HOSTS.includes(url.hostname)) {
    e.respondWith(networkFirstApp(req));
  }
});

async function networkFirstApp(req) {
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") {
      const cache = await caches.open(VERSION);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || Response.error();
  }
}

async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch {
    return Response.error();
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
  }
}