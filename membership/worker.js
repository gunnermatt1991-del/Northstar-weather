const ALLOWED_ORIGIN = "*";
const OWNER_EMAIL = "gunnermatt1991@icloud.com";
async function signOwnerSession(secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const payload = btoa(JSON.stringify({email:OWNER_EMAIL,exp:Date.now()+12*60*60*1000})).replace(/=/g,"").replace(/\\+/g,"-").replace(/\\//g,"_");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const encoded = btoa(String.fromCharCode(...sig)).replace(/=/g,"").replace(/\\+/g,"-").replace(/\\//g,"_");
  return payload+"."+encoded;
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    "vary": "Origin"
  }
});

async function paypalAccessToken(env) {
  const credentials = btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET);
  const response = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + credentials,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) throw new Error("PayPal authentication failed");
  const data = await response.json();
  if (!data.access_token) throw new Error("PayPal did not return an access token");
  return data.access_token;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": ALLOWED_ORIGIN,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "vary": "Origin"
      }});
    }
    if (origin !== ALLOWED_ORIGIN) return json({ active: false, error: "Origin not allowed" }, 403);
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    if (url.pathname === "/owner/login") {
      if (!env.OWNER_ACCESS_CODE) return json({error:"Owner access is not configured yet"},503);
      let loginBody;
      try { loginBody = await request.json(); } catch { return json({error:"Invalid request"},400); }
      if (typeof loginBody?.code !== "string" || loginBody.code.length > 256 || loginBody.code !== env.OWNER_ACCESS_CODE) {
        return json({error:"That owner code wasn't recognised."},401);
      }
      return json({token:await signOwnerSession(env.OWNER_ACCESS_CODE),email:OWNER_EMAIL,expiresIn:43200});
    }
    if (url.pathname !== "/verify") return json({ error: "Not found" }, 404);
    let body;
    try { body = await request.json(); } catch {
      return json({ active: false, error: "Invalid request" }, 400);
    }
    const subscriptionId = typeof body?.subscriptionId === "string" ? body.subscriptionId.trim() : "";
    if (!/^I-[A-Z0-9]{10,}$/i.test(subscriptionId)) {
      return json({ active: false, error: "A valid PayPal subscription ID is required" }, 400);
    }
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !env.PAYPAL_PLAN_ID) {
      return json({ active: false, error: "Membership verification is not configured" }, 503);
    }
    try {
      const token = await paypalAccessToken(env);
      const response = await fetch("https://api-m.paypal.com/v1/billing/subscriptions/" + encodeURIComponent(subscriptionId), {
        headers: { authorization: "Bearer " + token, accept: "application/json" }
      });
      if (response.status === 404) return json({ active: false });
      if (!response.ok) throw new Error("PayPal subscription lookup failed");
      const subscription = await response.json();
      const active = subscription.status === "ACTIVE" &&
        subscription.plan_id === env.PAYPAL_PLAN_ID;
      return json({
        active,
        status: subscription.status || "UNKNOWN",
        planMatches: subscription.plan_id === env.PAYPAL_PLAN_ID
      });
    } catch (error) {
      console.error("Membership verification failed", error);
      return json({ active: false, error: "Unable to verify membership right now" }, 502);
    }
  }
};
