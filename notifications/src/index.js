import { buildPushPayload } from "@block65/webcrypto-web-push";

const corsHeaders = (origin, env) => ({
  "Access-Control-Allow-Origin": origin === env.APP_ORIGIN ? origin : env.APP_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin"
});

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  return origin === env.APP_ORIGIN;
}

function vapidConfig(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error("Push service keys are not configured yet.");
  }
  return {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  };
}

function validSubscription(s) {
  return s && typeof s.endpoint === "string" &&
    s.endpoint.startsWith("https://") &&
    s.keys && typeof s.keys.p256dh === "string" &&
    typeof s.keys.auth === "string";
}

async function sendPush(row, message, env) {
  const subscription = {
    endpoint: row.endpoint,
    expirationTime: null,
    keys: { p256dh: row.p256dh, auth: row.auth }
  };
  const payload = await buildPushPayload({ data: message, options: { ttl: 3600, urgency: "high" } }, subscription, vapidConfig(env));
  const response = await fetch(row.endpoint, payload);
  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(row.id).run();
    return false;
  }
  if (!response.ok) throw new Error("Push provider returned " + response.status);
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "Northstar Weather Notifications" }, 200, headers);
    }

    if (!allowedOrigin(request, env)) {
      return json({ error: "Origin not allowed." }, 403, headers);
    }

    if (url.pathname === "/public-key" && request.method === "GET") {
      return env.VAPID_PUBLIC_KEY
        ? json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, headers)
        : json({ error: "Push service is not configured yet." }, 503, headers);
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400, headers); }
      if (!validSubscription(body.subscription)) return json({ error: "Invalid push subscription." }, 400, headers);
      const lat = Number(body.latitude);
      const lon = Number(body.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return json({ error: "A valid location is required for local weather alerts." }, 400, headers);
      }
      const id = crypto.randomUUID();
      const s = body.subscription;
      const prefs = body.alerts && typeof body.alerts === "object" ? body.alerts : {};
      await env.DB.prepare(`
        INSERT INTO subscriptions (id, endpoint, p256dh, auth, latitude, longitude, location_name, alerts_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          p256dh=excluded.p256dh, auth=excluded.auth,
          latitude=excluded.latitude, longitude=excluded.longitude,
          location_name=excluded.location_name, alerts_json=excluded.alerts_json
      `).bind(id, s.endpoint, s.keys.p256dh, s.keys.auth, lat, lon,
        String(body.locationName || "Your location").slice(0, 100), JSON.stringify(prefs)).run();
      return json({ ok: true }, 201, headers);
    }

    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400, headers); }
      const endpoint = body && body.endpoint;
      if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return json({ error: "Invalid endpoint." }, 400, headers);
      await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(endpoint).run();
      return json({ ok: true }, 200, headers);
    }

    if (url.pathname === "/test" && request.method === "POST") {
      if (!env.ADMIN_KEY || request.headers.get("Authorization") !== "Bearer " + env.ADMIN_KEY) {
        return json({ error: "Not authorized." }, 401, headers);
      }
      const rows = await env.DB.prepare("SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT 100").all();
      let sent = 0;
      for (const row of rows.results || []) {
        try {
          if (await sendPush(row, {
            title: "Northstar Weather test",
            body: "Great news — phone notifications are connected.",
            url: "/"
          }, env)) sent++;
        } catch (error) {
          console.error("Test push failed", error);
        }
      }
      return json({ ok: true, sent }, 200, headers);
    }

    return json({ error: "Not found." }, 404, headers);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkWeather(env));
  }
};

async function checkWeather(env) {
  const { results = [] } = await env.DB.prepare("SELECT * FROM subscriptions LIMIT 500").all();
  for (const row of results) {
    try {
      const prefs = JSON.parse(row.alerts_json || "{}");
      const params = new URLSearchParams({
        latitude: String(row.latitude),
        longitude: String(row.longitude),
        hourly: "precipitation_probability,wind_speed_10m,snowfall,temperature_2m",
        forecast_days: "1",
        timezone: "auto"
      });
      const weatherResponse = await fetch("https://api.open-meteo.com/v1/forecast?" + params);
      if (!weatherResponse.ok) continue;
      const forecast = await weatherResponse.json();
      const times = forecast.hourly?.time || [];
      const now = Date.now();
      const next = times.map((time, i) => ({ time, i, ms: new Date(time).getTime() }))
        .filter(x => x.ms >= now && x.ms <= now + 6 * 60 * 60 * 1000);
      if (!next.length) continue;

      const alerts = [];
      for (const item of next) {
        const i = item.i;
        const rain = Number(forecast.hourly.precipitation_probability?.[i] || 0);
        const wind = Number(forecast.hourly.wind_speed_10m?.[i] || 0);
        const snow = Number(forecast.hourly.snowfall?.[i] || 0);
        const temp = Number(forecast.hourly.temperature_2m?.[i] ?? 99);
        if (prefs.heavyRain !== false && rain >= 80) alerts.push({ key: "rain", title: "Heavy rain possible", body: "There is a high chance of rain near " + row.location_name + " in the next few hours." });
        if (prefs.strongWind !== false && wind >= 55) alerts.push({ key: "wind", title: "Strong winds forecast", body: "Wind gust conditions may become hazardous near " + row.location_name + "." });
        if (prefs.snow !== false && snow >= 0.5) alerts.push({ key: "snow", title: "Snow forecast", body: "Snow is forecast near " + row.location_name + "." });
        if (prefs.freezing !== false && temp <= 0) alerts.push({ key: "freeze", title: "Freezing temperatures", body: "Temperatures may reach 0°C or below near " + row.location_name + "." });
      }
      const unique = [...new Map(alerts.map(a => [a.key, a])).values()];
      const previous = JSON.parse(row.last_alerts_json || "{}");
      const fresh = unique.filter(a => !previous[a.key] || now - previous[a.key] > 6 * 60 * 60 * 1000);
      for (const alert of fresh) {
        await sendPush(row, { title: alert.title, body: alert.body, url: "/" }, env);
        previous[alert.key] = now;
      }
      if (fresh.length) {
        await env.DB.prepare("UPDATE subscriptions SET last_alerts_json = ? WHERE id = ?")
          .bind(JSON.stringify(previous), row.id).run();
      }
    } catch (error) {
      console.error("Weather check failed for subscription", row.id, error);
    }
  }
}
