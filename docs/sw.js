/* MonsterBox service worker — caches the app shell for offline use.
 * Bump CACHE when you change any cached asset to force an update. */
const CACHE = "monsterbox-v157";
const ASSETS = [
  "./", "index.html", "engine.js", "pdfimport.js", "cloud.js", "sync.js", "report.js", "manifest.webmanifest",
  "spells.json",
  "vendor/pdf.min.js", "vendor/pdf.worker.min.js",
  "bg-light.jpg", "bg-dark.jpg", "MonsterBox.ico", "monsterbox-logo.png",
  "logo-line.png", "Mississauga.otf",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
  "icons/favicon-16.png", "icons/favicon-32.png", "icons/favicon-48.png",
  "icons/favicon-64.png", "icons/favicon-128.png", "icons/favicon-256.png",
];

self.addEventListener("install", (e) => {
  // NOTE: deliberately NO skipWaiting() here. A freshly-installed worker WAITS
  // until the user accepts the update via the in-app "new version" banner (which
  // posts SKIP_WAITING below). Auto-activating mid-session was what left a page
  // running a half-updated mix of old and new assets (imports silently breaking).
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

// The page posts this when the user clicks "Reload" on the update banner.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.indexOf("/api/") !== -1) return;          // local API shim handles these in-page
  if (e.request.method !== "GET") return;

  // App shell (our own origin): NETWORK-FIRST so a normal refresh always shows
  // the latest deploy. We update the cache on every successful fetch and fall
  // back to it only when offline. (Cache-first used to serve stale code until
  // the SW itself swapped in — which needed extra reloads to take effect.)
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Anything cross-origin stays cache-first.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
