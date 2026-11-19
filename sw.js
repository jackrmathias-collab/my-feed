// Lets the app open instantly and show your last feed with no signal (e.g. on the Tube).
const CACHE = "myfeed-v1";
const SHELL = ["./", "index.html", "manifest.json", "icons/icon.svg", "icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  // Always try the network first so you get the newest posts; fall back to the saved copy.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      const key = url.pathname.endsWith("feed.json") ? new Request(url.origin + url.pathname) : e.request;
      caches.open(CACHE).then((c) => c.put(key, copy));
      return res;
    }).catch(() => caches.match(url.pathname.endsWith("feed.json") ? new Request(url.origin + url.pathname) : e.request))
  );
});
