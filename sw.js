const CACHE = "northstar-weather-v106";
const CORE = ["./", "./index.html", "./manifest.json", "./icon.svg", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png", "./uk-map.html", "./uk-map-radar.html", "./Northstar-UK-Map-Fixed.html", "./Northstar-UK-Map-Fixed%202.html", "./premium-storm-analysis.html"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE.map(path => new Request(new URL(path, self.registration.scope), {cache:"reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Northstar Weather", body: event.data ? event.data.text() : "A new weather update is available." }; }
  const title = String(data.title || "Northstar Weather");
  const options = {
    body: String(data.body || "There is a new weather update for your location."),
    icon: new URL("./icon.svg", self.registration.scope).href,
    badge: new URL("./icon.svg", self.registration.scope).href,
    tag: String(data.tag || "northstar-weather-alert"),
    renotify: false,
    data: { url: data.url || "./" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
    for (const client of clients) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  }));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const isMapPage = /Northstar-UK-Map-Fixed(?:%20| )2?\.html$/i.test(url.pathname);
  if (isMapPage) {
    event.respondWith(fetch(new Request(event.request, {cache:"no-store"})));
    return;
  }
  event.respondWith(fetch(event.request.mode === "navigate" ? new Request(event.request, {cache:"no-store"}) : event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match("./index.html"))));
});
