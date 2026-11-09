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
    const u = new URL(s.endpoint);
    return u.protocol === "https:" && typeof s.keys?.p256dh === "string" &&
      typeof s.keys?.auth === "string" && s.keys.p256dh.length < 200 &&
      s.keys.auth.length < 100;
  } catch { return false; }
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
      const cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("access-control-allow-origin", "*");
        headers.set("vary", "Origin");
        headers.set("x-northstar-cache", "HIT");
        return new Response(cached.body, { status: cached.status, headers });
      }
      try {
        const upstreamResponse = await fetch(upstream.toString(), {
          headers: { "accept": "application/json" }
        });
        if (!upstreamResponse.ok) {
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
        // Cache writes run in the background so a slow cache store cannot
        // hold the user's live forecast response open.
        ctx.waitUntil(cache.put(cacheKey, new Response(response.clone().body, {
          status: response.status,
          headers: storedHeaders
        })).catch(error => console.error("Weather cache write failed", error)));
        return response;
      } catch (error) {
        console.error("Weather proxy failed", error);
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
      let body;
      try { body = await request.json(); } catch { return fail("Invalid JSON."); }
      const { subscription, latitude, longitude, locationName, preferences } = body || {};
      if (!validSubscription(subscription)) return fail("Invalid push subscription.");
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
          !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return fail("A valid location is required.");
      }
      const prefs = {
        rain: preferences?.rain !== false,
        wind: preferences?.wind !== false,
        snow: preferences?.snow !== false,
        thunder: preferences?.thunder !== false,
        fog: preferences?.fog !== false
      };
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO subscriptions (id, endpoint, p256dh, auth, latitude, longitude, location_name, preferences, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(endpoint) DO UPDATE SET
          p256dh=excluded.p256dh, auth=excluded.auth, latitude=excluded.latitude,
          longitude=excluded.longitude, location_name=excluded.location_name,
          preferences=excluded.preferences, updated_at=datetime('now')
      `).bind(id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
        latitude, longitude, String(locationName || "Saved location").slice(0, 80),
        JSON.stringify(prefs)).run();
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/unsubscribe") {
      let body;
      try { body = await request.json(); } catch { return fail("Invalid JSON."); }
      if (typeof body?.endpoint !== "string") return fail("Subscription endpoint is required.");
      await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(body.endpoint).run();
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/test") {
      let body;
      try { body = await request.json(); } catch { return fail("Invalid JSON."); }
      if (!validSubscription(body?.subscription)) return fail("Valid subscription required.");
      try {
        vapid(env);
        await webpush.sendNotification(body.subscription, JSON.stringify({
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
        forecastUrl.searchParams.set("daily", "weather_code,precipitation_sum,precipitation_probability_max,snowfall_sum,wind_speed_10m_max");
        forecastUrl.searchParams.set("hourly", "visibility,weather_code,temperature_2m");
        forecastUrl.searchParams.set("forecast_hours", "36");
        forecastUrl.searchParams.set("forecast_days", "2");
        forecastUrl.searchParams.set("timezone", "auto");
        const response = await fetch(forecastUrl);
        if (!response.ok) continue;
        const forecast = await response.json();
        const prefs = JSON.parse(sub.preferences || "{}");
        const previous = JSON.parse(sub.alert_state || "{}");
        const alerts = [];
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
          if (prefs.thunder !== false && [95,96,99].includes(code)) {
            alerts.push({ key: "thunder-" + day, title: "Thunderstorms possible", body: dayLabel + " near " + sub.location_name + ": thunderstorms appear in the forecast." });
          }
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
