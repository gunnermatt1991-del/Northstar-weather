// Northstar Weather push notification Worker + shared Open-Meteo edge cache
// Build trigger after correcting Cloudflare root directory
import webpush from "web-push";

const APP_ORIGINS = new Set([
  "https://gunnermatt1991-del.github.io",
  "https://northstar-weather.pages.dev"
]);
const json = (data, status = 200, origin = "*") => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin"
  }
});
const fail = (message, status = 400) => json({ error: message }, status);
const ctxWaitUntilSafe = promise => { try { /* cache write is awaited by the runtime */ return promise; } catch { return Promise.resolve(); } };
const allowed = request => APP_ORIGINS.has(request.headers.get("Origin"));
const b64url = value => btoa(String.fromCharCode(...new Uint8Array(value)))
  .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function vapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error("Push service is not configured yet.");
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

function validSubscription(s) {
  try {
    if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 2048) return false;
    const u = new URL(s.endpoint);
    const host = u.hostname.toLowerCase();
    const browserPushHost =
      host === "fcm.googleapis.com" ||
      host === "push.services.mozilla.com" ||
      host.endsWith(".push.services.mozilla.com") ||
      host.endsWith(".push.apple.com") ||
      host.endsWith(".notify.windows.com");
    return u.protocol === "https:" && u.username === "" && u.password === "" &&
      (u.port === "" || u.port === "443") && browserPushHost &&
      typeof s.keys?.p256dh === "string" && s.keys.p256dh.length >= 40 && s.keys.p256dh.length <= 200 &&
      typeof s.keys?.auth === "string" && s.keys.auth.length >= 16 && s.keys.auth.length <= 100;
  } catch { return false; }
}
async function limitedJson(request, maxBytes = 16384) {
  const raw = await request.text();
  if (raw.length > maxBytes) throw new Error("Request body is too large.");
  return JSON.parse(raw);
}
async function rateLimited(request, env, route, limit, windowSeconds = 600) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + route));
  const key = b64url(digest);
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  const row = await env.DB.prepare(`
    INSERT INTO api_rate_limits (bucket, window_start, hits)
    VALUES (?, ?, 1)
    ON CONFLICT(bucket) DO UPDATE SET
      hits = CASE WHEN api_rate_limits.window_start = excluded.window_start
        THEN api_rate_limits.hits + 1 ELSE 1 END,
      window_start = excluded.window_start
    RETURNING hits
  `).bind(key, window).first();
  return Number(row?.hits || 0) > limit;
}
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (!APP_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "vary": "Origin"
      }});
    }
    const url = new URL(request.url);
    // Permit direct navigation to read-only diagnostics/public-key endpoints.
    // Browser app mutations still require the exact Northstar GitHub Pages origin.
    // Health is a read-only diagnostic and is intentionally available by direct
    // browser navigation (some mobile browsers attach an Origin header even to
    // top-level navigations). All state-changing endpoints remain origin-locked.
    const readOnlyHealth = request.method === "GET" && url.pathname === "/health";
    const readOnlyPublicKey = request.method === "GET" && url.pathname === "/vapid-public-key" && !origin;
    if (!allowed(request) && !readOnlyHealth && !readOnlyPublicKey) return fail("Origin not allowed.", 403);

    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return json({
        service: "Northstar Weather Alerts",
        ok: true,
        vapidConfigured: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT),
        publicKeyConfigured: !!env.VAPID_PUBLIC_KEY,
        privateKeyConfigured: !!env.VAPID_PRIVATE_KEY,
        subjectConfigured: !!env.VAPID_SUBJECT,
        databaseConfigured: !!env.DB
      });
    }

    // CORS-safe MET Norway backup forecast. The browser must not call api.met.no
    // directly: its strict client policy can reject cross-origin requests.
    if (request.method === "GET" && url.pathname === "/weather/backup") {
      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return json({ error: "Valid latitude and longitude are required." }, 400);
      }
      try {
        const backupUrl = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
        backupUrl.searchParams.set("lat", lat.toFixed(4));
        backupUrl.searchParams.set("lon", lon.toFixed(4));
        const backup = await fetch(backupUrl.toString(), {
          headers: { "accept": "application/json", "user-agent": "NorthstarWeather/1.0 (https://github.com/gunnermatt1991-del/Northstar-weather)" }
        });
        if (!backup.ok) return json({ error: true, reason: "Backup weather provider returned " + backup.status + "." }, backup.status);
        return new Response(await backup.text(), { status: 200, headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=600",
          "access-control-allow-origin": "*",
          "vary": "Origin"
        }});
      } catch (error) {
        console.error("Backup forecast proxy failed", error);
        return json({ error: true, reason: "Backup weather provider is temporarily unavailable." }, 502);
      }
    }

    // Shared edge cache for Open-Meteo requests. Browser clients call this
    // same-origin Worker instead of hitting the upstream API independently.
    if (request.method === "GET" && (url.pathname === "/weather/forecast" || url.pathname === "/weather/geocoding")) {
      const forecast = url.pathname === "/weather/forecast";
      const upstream = new URL(forecast
        ? "https://api.open-meteo.com/v1/forecast"
        : "https://geocoding-api.open-meteo.com/v1/search");
      upstream.search = url.search;
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      // Keep a separate seven-day fallback copy. The short-lived fresh cache
      // protects Open-Meteo from repeated requests; the fallback keeps the app
      // usable if the provider temporarily responds with HTTP 429 or 5xx.
      const staleCacheKey = new Request("https://northstar-weather-stale.local" + url.pathname + url.search, { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("access-control-allow-origin", "*");
        headers.set("vary", "Origin");
        headers.set("x-northstar-cache", "HIT");
        return new Response(cached.body, { status: cached.status, headers });
      }
      const serveStale = async () => {
        const stale = await cache.match(staleCacheKey);
        if (!stale) return null;
        const headers = new Headers(stale.headers);
        headers.set("access-control-allow-origin", "*");
        headers.set("vary", "Origin");
        headers.set("x-northstar-cache", "STALE");
        headers.set("warning", '110 - "Response is stale"');
        return new Response(stale.body, { status: 200, headers });
      };
      try {
        const useMirror = forecast;
        let upstreamResponse;
        // Use the independent Open-Meteo-compatible mirror for every ordinary
        // forecast request, including batched map coordinates. This keeps the
        // map away from the shared free-tier Open-Meteo concurrency queue.
        if (useMirror) {
          const mirror = new URL("https://weather.tk.gg/v1/forecast");
          mirror.search = url.search;
          // The public mirror can occasionally stall. Bound its latency so the
          // browser never sits on the initial "Loading live weather" message.
          const mirrorController = new AbortController();
          const mirrorTimer = setTimeout(() => mirrorController.abort(), 5000);
          try {
            upstreamResponse = await fetch(mirror.toString(), {
              signal: mirrorController.signal,
              headers: { "accept": "application/json" }
            });
          } catch (mirrorError) {
            console.warn("Primary weather mirror request failed or timed out", mirrorError);
          } finally {
            clearTimeout(mirrorTimer);
          }
          if (!upstreamResponse || !upstreamResponse.ok) {
            const officialController = new AbortController();
            const officialTimer = setTimeout(() => officialController.abort(), 15000);
            try {
              upstreamResponse = await fetch(upstream.toString(), {
                signal: officialController.signal,
                headers: { "accept": "application/json" }
              });
            } finally {
              clearTimeout(officialTimer);
            }
          }
        } else {
          upstreamResponse = await fetch(upstream.toString(), {
            headers: { "accept": "application/json" }
          });
        }
        if (!upstreamResponse.ok) {
          if (forecast && (upstreamResponse.status === 429 || upstreamResponse.status >= 500)) {
            const staleResponse = await serveStale();
            if (staleResponse) return staleResponse;
          }
          return json({ error: true, reason: "Weather provider returned " + upstreamResponse.status + ". Please try again shortly." }, upstreamResponse.status);
        }
        const ttl = forecast
          ? (url.searchParams.has("models") ? 1800 : 900)
          : 86400;
        const headers = new Headers(upstreamResponse.headers);
        headers.set("content-type", "application/json; charset=utf-8");
        headers.set("cache-control", "public, max-age=" + ttl);
        headers.set("access-control-allow-origin", "*");
        headers.set("vary", "Origin");
        headers.set("x-northstar-cache", "MISS");
        const response = new Response(await upstreamResponse.arrayBuffer(), {
          status: 200,
          headers
        });
        const storedHeaders = new Headers(response.headers);
        storedHeaders.delete("access-control-allow-origin");
        storedHeaders.delete("x-northstar-cache");
        const staleHeaders = new Headers(storedHeaders);
        // Keep the last successful forecast available for a full week if the upstream provider rate-limits.
        staleHeaders.set("cache-control", "public, max-age=604800");
        // Fresh and fallback cache writes run in the background.
        ctx.waitUntil(Promise.all([
          cache.put(cacheKey, new Response(response.clone().body, {
            status: response.status,
            headers: storedHeaders
          })),
          ...(forecast ? [cache.put(staleCacheKey, new Response(response.clone().body, {
            status: response.status,
            headers: staleHeaders
          }))] : [])
        ]).catch(error => console.error("Weather cache write failed", error)));
        return response;
      } catch (error) {
        console.error("Weather proxy failed", error);
        if (forecast) {
          const staleResponse = await serveStale();
          if (staleResponse) return staleResponse;
        }
        return json({ error: true, reason: "Weather data is temporarily unavailable." }, 502);
      }
    }


    // Met Office Land Observations: resolve the nearest station, then retrieve
    // its hourly observations. Keep the subscription key on the Worker only.
    if (request.method === "GET" && url.pathname === "/observations/latest") {
      if (!env.METOFFICE_LANDOBS_API_KEY) return json({ error: "Met Office Land Observations are not configured. Add the METOFFICE_LANDOBS_API_KEY Worker secret." }, 503);
      const lat = Number(url.searchParams.get("latitude"));
      const lon = Number(url.searchParams.get("longitude"));
      if (!Number.isFinite(lat) || lat < 49 || lat > 61 || !Number.isFinite(lon) || lon < -8 || lon > 2) {
        return fail("A valid UK latitude and longitude are required.");
      }
      const roundedLat = Math.round(lat * 100) / 100;
      const roundedLon = Math.round(lon * 100) / 100;
      const cache = caches.default;
      const cacheKey = new Request("https://northstar-observation-cache.local/latest/" + roundedLat + "/" + roundedLon, { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("access-control-allow-origin", "*");
        headers.set("vary", "Origin");
        headers.set("x-northstar-cache", "HIT");
        return new Response(cached.body, { status: cached.status, headers });
      }
      try {
        const base = "https://data.hub.api.metoffice.gov.uk/observation-land/1";
        const headers = { "apikey": env.METOFFICE_LANDOBS_API_KEY, "accept": "application/json" };
        const nearestUrl = new URL(base + "/nearest");
        nearestUrl.searchParams.set("lat", roundedLat);
        nearestUrl.searchParams.set("lon", roundedLon);
        nearestUrl.searchParams.set("max", "1");
        const nearestResponse = await fetch(nearestUrl, { headers });
        if (!nearestResponse.ok) throw new Error("Met Office nearest-station lookup returned " + nearestResponse.status);
        const nearest = await nearestResponse.json();
        if (!Array.isArray(nearest) || !nearest.length || !nearest[0].geohash) {
          return json({ error: "No Met Office observation station was found for this location." }, 404);
        }
        const station = nearest[0];
        const observationsResponse = await fetch(base + "/" + encodeURIComponent(station.geohash), { headers });
        if (!observationsResponse.ok) throw new Error("Met Office station observations returned " + observationsResponse.status);
        const observations = await observationsResponse.json();
        if (!Array.isArray(observations) || !observations.length) {
          return json({ error: "The nearest Met Office station has no recent observations." }, 404);
        }
        const rows = observations.filter(row => row && Number.isFinite(Date.parse(row.datetime)))
          .sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime));
        if (!rows.length) return json({ error: "The Met Office station returned no timestamped observations." }, 502);
        const body = JSON.stringify({
          source: "Met Office Land Observations",
          station: { geohash: station.geohash, area: station.area || null, region: station.region || null, country: station.country || null, timeZone: station.olson_time_zone || "Europe/London" },
          latest: rows[0],
          observations: rows.slice(0, 24),
          fetchedAt: new Date().toISOString()
        });
        const response = new Response(body, { status: 200, headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=1800",
          "access-control-allow-origin": "*",
          "vary": "Origin"
        }});
        ctx.waitUntil(cache.put(cacheKey, new Response(body, { status: 200, headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=1800"
        }})).catch(error => console.error("Observation cache write failed", error)));
        return response;
      } catch (error) {
        console.error("Met Office observation fetch failed", error);
        return json({ error: "Met Office observations could not be loaded. " + error.message }, 502);
      }
    }

    // Official Met Office NSWWS warning polygons (GeoJSON).
    // Store METOFFICE_API_KEY as a Cloudflare Worker secret; never expose it to browsers.
    if (request.method === "GET" && url.pathname === "/warnings/geojson") {
      if (!env.METOFFICE_API_KEY) return json({ error: "Official warning polygons are not configured. Add the METOFFICE_API_KEY Worker secret." }, 503);
      const cache = caches.default;
      const cacheKey = new Request("https://northstar-warning-cache.local/uk-live-geojson", { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("access-control-allow-origin", "*");
        headers.set("vary", "Origin");
        headers.set("x-northstar-cache", "HIT");
        return new Response(cached.body, { status: cached.status, headers });
      }
      try {
        const base = "https://data.hub.api.metoffice.gov.uk/nswws/v1.1";
        const feedResponse = await fetch(base + "/objects/feed", {
          headers: { "apikey": env.METOFFICE_API_KEY, "accept": "application/atom+xml, application/xml" }
        });
        if (!feedResponse.ok) throw new Error("Met Office warning feed returned " + feedResponse.status);
        const xml = await feedResponse.text();

        // NSWWS v1.1 exposes the current all-warnings GeoJSON snapshot through
        // the Atom feed's rel="related" link. Follow that authoritative link
        // instead of constructing /objects/issued/{uuid} URLs from feed entries.
        const linkTags = xml.match(/<link\b[^>]*>/gi) || [];
        const relatedTag = linkTags.find(tag => {
          const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1] || "";
          return rel.toLowerCase() === "related";
        });
        const relatedHref = relatedTag?.match(/\bhref=["']([^"']+)["']/i)?.[1];
        if (!relatedHref) throw new Error("Met Office warning feed did not contain its related GeoJSON snapshot link.");
        const snapshotUrl = new URL(relatedHref, base).toString();
        const snapshotResponse = await fetch(snapshotUrl, {
          headers: { "apikey": env.METOFFICE_API_KEY, "accept": "application/geo+json, application/json" }
        });
        if (!snapshotResponse.ok) throw new Error("Met Office warning GeoJSON snapshot returned " + snapshotResponse.status);
        const snapshot = await snapshotResponse.json();
        if (!snapshot || snapshot.type !== "FeatureCollection" || !Array.isArray(snapshot.features)) {
          throw new Error("Met Office warning GeoJSON snapshot was not a FeatureCollection.");
        }
        const features = snapshot.features.filter(feature =>
          feature && feature.type === "Feature" && feature.geometry
        );
        const body = JSON.stringify({ type: "FeatureCollection", features, updatedAt: new Date().toISOString(), source: "Met Office NSWWS" });
        const response = new Response(body, { status: 200, headers: {
          "content-type": "application/geo+json; charset=utf-8",
          "cache-control": "public, max-age=300",
          "access-control-allow-origin": "*",
          "vary": "Origin"
        }});
        ctx.waitUntil(cache.put(cacheKey, new Response(body, { status: 200, headers: {
          "content-type": "application/geo+json; charset=utf-8",
          "cache-control": "public, max-age=300"
        }})).catch(error => console.error("Warning geometry cache write failed", error)));
        return response;
      } catch (error) {
        console.error("Official warning geometry fetch failed", error);
        return json({ error: "Official Met Office warning polygons could not be loaded. " + error.message }, 502);
      }
    }

    if (request.method === "GET" && url.pathname === "/vapid-public-key") {
      if (!env.VAPID_PUBLIC_KEY) return fail("Push service is not configured yet.", 503);
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    if (request.method === "POST" && url.pathname === "/subscribe") {
      try {
        if (await rateLimited(request, env, "/subscribe", 12)) return fail("Too many subscription changes. Please wait a few minutes and try again.", 429);
      } catch (error) { console.error("Subscription rate limit unavailable", error); return fail("Alert service is temporarily unavailable. Please try again shortly.", 503); }
      let body;
      try { body = await limitedJson(request); } catch (error) { return fail(error.message === "Request body is too large." ? error.message : "Invalid JSON."); }
      const { subscription, latitude, longitude, locationName, preferences } = body || {};
      if (!validSubscription(subscription)) return fail("Invalid push subscription.");
      const existing = await env.DB.prepare("SELECT p256dh, auth FROM subscriptions WHERE endpoint = ?").bind(subscription.endpoint).first();
      if (existing && (!sameSecret(existing.p256dh, subscription.keys.p256dh) || !sameSecret(existing.auth, subscription.keys.auth))) {
        return fail("This notification subscription could not be verified.", 403);
      }
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
          !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return fail("A valid location is required.");
      }
      const prefs = {
        rain: preferences?.rain !== false,
        rainStart: preferences?.rainStart !== false,
        wind: preferences?.wind !== false,
        snow: preferences?.snow !== false,
        thunder: preferences?.thunder !== false,
        fog: preferences?.fog !== false,
        frost: preferences?.frost !== false
      };
      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(`
          INSERT INTO subscriptions (id, endpoint, p256dh, auth, latitude, longitude, location_name, preferences, alert_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', datetime('now'), datetime('now'))
          ON CONFLICT(endpoint) DO UPDATE SET
            p256dh=excluded.p256dh, auth=excluded.auth, latitude=excluded.latitude,
            longitude=excluded.longitude, location_name=excluded.location_name,
            preferences=excluded.preferences, updated_at=datetime('now')
        `).bind(id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
          latitude, longitude, String(locationName || "Saved location").slice(0, 80),
          JSON.stringify(prefs)).run();
        return json({ ok: true, saved: true });
      } catch (error) {
        console.error("Push subscription save failed", error);
        return json({ error: "Could not save alert settings: " + String(error?.message || error).slice(0, 240) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/unsubscribe") {
      try {
        if (await rateLimited(request, env, "/unsubscribe", 20)) return fail("Too many requests. Please wait a few minutes and try again.", 429);
      } catch (error) { console.error("Unsubscribe rate limit unavailable", error); return fail("Alert service is temporarily unavailable. Please try again shortly.", 503); }
      let body;
      try { body = await limitedJson(request); } catch (error) { return fail(error.message === "Request body is too large." ? error.message : "Invalid JSON."); }
      const sub = body?.subscription;
      if (!validSubscription(sub)) return fail("A valid device subscription is required.");
      const existing = await env.DB.prepare("SELECT id, p256dh, auth FROM subscriptions WHERE endpoint = ?").bind(sub.endpoint).first();
      if (existing && sameSecret(existing.p256dh, sub.keys.p256dh) && sameSecret(existing.auth, sub.keys.auth)) {
        await env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(existing.id).run();
      }
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/test") {
      try {
        if (await rateLimited(request, env, "/test", 3)) return fail("Too many test alerts. Please wait a few minutes and try again.", 429);
      } catch (error) { console.error("Test alert rate limit unavailable", error); return fail("Alert service is temporarily unavailable. Please try again shortly.", 503); }
      let body;
      try { body = await limitedJson(request); } catch (error) { return fail(error.message === "Request body is too large." ? error.message : "Invalid JSON."); }
      const sub = body?.subscription;
      if (!validSubscription(sub)) return fail("Valid device subscription required.");
      const saved = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM subscriptions WHERE endpoint = ?").bind(sub.endpoint).first();
      if (!saved || !sameSecret(saved.p256dh, sub.keys.p256dh) || !sameSecret(saved.auth, sub.keys.auth)) {
        return fail("This device is not registered for Northstar alerts. Refresh alert settings first.", 403);
      }
      try {
        vapid(env);
        await webpush.sendNotification({ endpoint: saved.endpoint, keys: { p256dh: saved.p256dh, auth: saved.auth } }, JSON.stringify({
          title: "Northstar Weather",
          body: "Your weather notifications are switched on. This is a test alert.",
          tag: "northstar-test",
          url: "./"
        }), { TTL: 60, urgency: "normal" });
        return json({ ok: true });
      } catch (error) {
        console.error("Test push failed", error);
        return fail("The test notification could not be sent.", 502);
      }
    }

    return fail("Not found.", 404);
  },

  async scheduled(controller, env, ctx) {
    vapid(env);
    const { results = [] } = await env.DB.prepare(
      "SELECT id, endpoint, p256dh, auth, latitude, longitude, location_name, preferences, alert_state FROM subscriptions"
    ).all();

    for (const sub of results) {
      try {
        const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
        forecastUrl.searchParams.set("latitude", sub.latitude);
        forecastUrl.searchParams.set("longitude", sub.longitude);
        forecastUrl.searchParams.set("daily", "weather_code,precipitation_sum,precipitation_probability_max,snowfall_sum,wind_speed_10m_max,temperature_2m_min");
        forecastUrl.searchParams.set("current", "precipitation,rain,showers,weather_code");
        forecastUrl.searchParams.set("hourly", "visibility,weather_code,temperature_2m,precipitation,precipitation_probability");
        forecastUrl.searchParams.set("forecast_hours", "36");
        forecastUrl.searchParams.set("forecast_days", "7");
        forecastUrl.searchParams.set("timezone", "auto");
        const response = await fetch(forecastUrl);
        if (!response.ok) continue;
        const forecast = await response.json();
        const prefs = JSON.parse(sub.preferences || "{}");
        const previous = JSON.parse(sub.alert_state || "{}");
        const alerts = [];
        if (prefs.rainStart !== false && forecast.hourly?.time && forecast.hourly?.precipitation) {
          const timezone = forecast.timezone || "UTC";
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23"
          }).formatToParts(new Date());
          const part = key => parts.find(item => item.type === key)?.value || "00";
          const localNow = part("year") + "-" + part("month") + "-" + part("day") + "T" + part("hour") + ":" + part("minute");
          const hourly = forecast.hourly;
          const wetCodes = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82];
          // A 30-minute scheduler can run after rain has already started.
          // The old "dry hour -> wet hour" transition-only check then missed
          // the event completely. Also inspect current conditions and send one
          // daily "rain underway" heads-up when rain-start alerts are enabled.
          const current = forecast.current || {};
          const currentCode = Number(current.weather_code);
          const currentAmount = Math.max(
            Number(current.precipitation || 0),
            Number(current.rain || 0),
            Number(current.showers || 0)
          );
          const currentWet = currentAmount >= 0.1 || wetCodes.includes(currentCode);
          if (currentWet) {
            alerts.push({
              key: "rain-now-" + localNow.slice(0, 10),
              title: "Rain currently affecting your location",
              body: "Current weather data indicates precipitation near " + sub.location_name + " now."
            });
          }
          const wet = hourly.time.map((time, index) => {
            const amount = Number(hourly.precipitation?.[index] || 0);
            const probability = Number(hourly.precipitation_probability?.[index] || 0);
            const code = Number(hourly.weather_code?.[index] || 0);
            return { time, amount, probability, wet: amount >= 0.2 || (probability >= 60 && wetCodes.includes(code)) };
          });
          for (let i = 1; i < wet.length; i++) {
            const row = wet[i];
            if (row.time <= localNow || !row.wet || wet[i - 1].wet) continue;
            const leadMinutes = (Date.parse(row.time + ":00Z") - Date.parse(localNow + ":00Z")) / 60000;
            if (leadMinutes < 0 || leadMinutes > 180) continue;
            const startTime = row.time.slice(11, 16);
            const chanceText = row.probability ? " There is around a " + Math.round(row.probability) + "% chance of precipitation." : "";
            alerts.push({
              key: "rain-start-" + row.time,
              title: "Rain expected to start soon",
              body: "Rain is forecast to begin near " + sub.location_name + " around " + startTime + " local time." + chanceText
            });
            break;
          }
        }
        const frostOutlook = [];
        for (let i = 0; i < forecast.daily.time.length; i++) {
          const day = forecast.daily.time[i];
          const rain = Number(forecast.daily.precipitation_sum?.[i] || 0);
          const rainChance = Number(forecast.daily.precipitation_probability_max?.[i] || 0);
          const snow = Number(forecast.daily.snowfall_sum?.[i] || 0);
          const wind = Number(forecast.daily.wind_speed_10m_max?.[i] || 0);
          const code = Number(forecast.daily.weather_code?.[i] || 0);
          const dayLabel = i === 0 ? "Today" : "Tomorrow";
          if (prefs.rain !== false && (rain >= 15 || (rainChance >= 85 && rain >= 5))) {
            alerts.push({ key: "rain-" + day, title: "Heavy rain possible", body: dayLabel + " near " + sub.location_name + ": around " + Math.round(rain) + " mm of rain is forecast." });
          }
          if (prefs.snow !== false && (snow >= 1 || [71,73,75,77,85,86].includes(code))) {
            alerts.push({ key: "snow-" + day, title: "Snow or icy conditions possible", body: dayLabel + " near " + sub.location_name + ": snow is in the forecast. Take care on roads and paths." });
          }
          if (prefs.wind !== false && wind >= 55) {
            alerts.push({ key: "wind-" + day, title: "Strong winds possible", body: dayLabel + " near " + sub.location_name + ": gusty conditions are possible, with forecast wind around " + Math.round(wind) + " km/h." });
          }
          const overnightLow = Number(forecast.daily.temperature_2m_min?.[i]);
          if (prefs.frost !== false && Number.isFinite(overnightLow) && overnightLow <= 0) {
            const weekday = new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
            frostOutlook.push({ day: weekday, low: Math.round(overnightLow) });
          }
          if (prefs.thunder !== false && [95,96,99].includes(code)) {
            alerts.push({ key: "thunder-" + day, title: "Thunderstorms possible", body: dayLabel + " near " + sub.location_name + ": thunderstorms appear in the forecast." });
          }
        }

        if (frostOutlook.length) {
          const coldest = Math.min(...frostOutlook.map(item => item.low));
          const title = coldest <= -5 ? "Severe frost risk ahead" : coldest <= -2 ? "Hard frost possible" : "Frost and icy patches possible";
          const nights = frostOutlook.map(item => item.day + " " + item.low + "°C").join(", ");
          const advice = coldest <= -2
            ? "Protect plants and check exposed pipes; watch for icy surfaces."
            : "Take care on roads and paths, especially on exposed surfaces.";
          alerts.push({
            key: "frost-outlook",
            title,
            body: "Overnight lows near " + sub.location_name + ": " + nights + ". " + advice
          });
        }

        if (prefs.fog !== false && forecast.hourly?.time && forecast.hourly?.visibility) {
          const hours = forecast.hourly;
          const fogRows = hours.time.map((time, i) => ({
            time,
            visibility: Number(hours.visibility[i]),
            code: Number(hours.weather_code?.[i]),
            temperature: Number(hours.temperature_2m?.[i])
          })).filter(row => Number.isFinite(row.visibility) && row.visibility < 400);
          if (fogRows.length) {
            const worst = fogRows.reduce((a, b) => b.visibility < a.visibility ? b : a);
            const severe = worst.visibility < 200;
            const freezing = fogRows.some(row => row.temperature <= 0);
            const when = new Date(worst.time).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
            const visibilityText = Math.round(worst.visibility) + " m";
            alerts.push({
              key: "fog-" + worst.time.slice(0, 10),
              title: severe ? "Very poor visibility possible" : "Dense fog possible",
              body: (severe ? "Very poor visibility" : "Dense fog") + " near " + sub.location_name + " around " + when + " (modelled minimum " + visibilityText + ")." + (freezing ? " Freezing temperatures overlap; icy surfaces are possible." : "")
            });
          }
        }

        const fresh = alerts.filter(a => !previous[a.key] || Date.now() - previous[a.key] > 18 * 60 * 60 * 1000);
        const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
        for (const alert of fresh) {
          try {
            await webpush.sendNotification(subscription, JSON.stringify({
              title: alert.title,
              body: alert.body,
              tag: "northstar-" + alert.key,
              url: "./"
            }), { TTL: 60 * 60, urgency: "high" });
            previous[alert.key] = Date.now();
          } catch (error) {
            const status = error.statusCode || error.status;
            if (status === 404 || status === 410) {
              await env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(sub.id).run();
              break;
            }
            console.error("Push delivery failed", sub.id, status || error.message);
          }
        }
        await env.DB.prepare("UPDATE subscriptions SET alert_state = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(JSON.stringify(previous), sub.id).run();
      } catch (error) {
        console.error("Scheduled alert check failed", sub.id, error);
      }
    }
  }
};
