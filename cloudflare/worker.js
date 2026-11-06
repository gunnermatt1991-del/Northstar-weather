// Northstar Weather push notification Worker
// Build trigger after correcting Cloudflare root directory
import webpush from "web-push";

const APP_ORIGIN = "https://gunnermatt1991-del.github.io";
const json = (data, status = 200, origin = APP_ORIGIN) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin"
  }
});
const fail = (message, status = 400) => json({ error: message }, status);
const ctxWaitUntilSafe = promise => { try { /* cache write is awaited by the runtime */ return promise; } catch { return Promise.resolve(); } };
const allowed = request => request.headers.get("Origin") === APP_ORIGIN;
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
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (origin !== APP_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": APP_ORIGIN,
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "vary": "Origin"
      }});
    }
    if (!allowed(request)) return fail("Origin not allowed.", 403);
    const url = new URL(request.url);

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
        headers.set("access-control-allow-origin", APP_ORIGIN);
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
        headers.set("access-control-allow-origin", APP_ORIGIN);
        headers.set("vary", "Origin");
        headers.set("x-northstar-cache", "MISS");
        const response = new Response(await upstreamResponse.arrayBuffer(), {
          status: 200,
          headers
        });
        const storedHeaders = new Headers(response.headers);
        storedHeaders.delete("access-control-allow-origin");
        storedHeaders.delete("x-northstar-cache");
        await ctxWaitUntilSafe(cache.put(cacheKey, new Response(response.clone().body, {
          status: response.status,
          headers: storedHeaders
        })));
        return response;
      } catch (error) {
        console.error("Weather proxy failed", error);
        return json({ error: true, reason: "Weather data is temporarily unavailable." }, 502);
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
        thunder: preferences?.thunder !== false
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
