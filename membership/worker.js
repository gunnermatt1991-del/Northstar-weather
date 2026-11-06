const ALLOWED_ORIGIN = "*";
const OWNER_EMAIL = "gunnermatt1991@icloud.com";
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_"); }
function unb64url(value) { const raw=value.replace(/-/g,"+").replace(/_/g,"/"); return Uint8Array.from(atob(raw+"=".repeat((4-raw.length%4)%4)),c=>c.charCodeAt(0)); }
async function ownerKey(secret, usages) { return crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,usages); }
async function signOwnerSession(secret) {
  const payload=b64url(new TextEncoder().encode(JSON.stringify({email:OWNER_EMAIL,exp:Date.now()+12*60*60*1000,scope:"northstar-owner-test"})));
  const sig=await crypto.subtle.sign("HMAC",await ownerKey(secret,["sign"]),new TextEncoder().encode(payload));
  return payload+"."+b64url(sig);
}
async function verifyOwnerSession(token,secret) {
  if(typeof token!=="string"||token.length>2048)return false;
  const parts=token.split(".");
  if(parts.length!==2)return false;
  try {
    const valid=await crypto.subtle.verify("HMAC",await ownerKey(secret,["verify"]),unb64url(parts[1]),new TextEncoder().encode(parts[0]));
    if(!valid)return false;
    const payload=JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    return payload.email===OWNER_EMAIL&&payload.scope==="northstar-owner-test"&&Number(payload.exp)>Date.now();
  } catch { return false; }
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
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400"
      }});
    }
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    if (url.pathname === "/owner/login") {
      if (!env.OWNER_ACCESS_CODE) return json({error:"Owner access is not configured yet"},503);
      let submittedCode = "";
      const contentType = request.headers.get("content-type") || "";
      try {
        if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
          const form = await request.formData();
          submittedCode = String(form.get("code") || "");
        } else {
          const loginBody = await request.json();
          submittedCode = typeof loginBody?.code === "string" ? loginBody.code : "";
        }
      } catch { return json({error:"Invalid request"},400); }
      const isForm = contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");
      const html = (message, success) => new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Northstar Owner</title><style>body{margin:0;padding:28px;background:#081225;color:#f5f8ff;font:17px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}.card{max-width:640px;margin:8vh auto;padding:28px;background:#142440;border:1px solid #ffffff24;border-radius:22px}h1{font-size:30px}a{display:block;padding:13px 0;color:#9ed0ff;border-bottom:1px solid #ffffff20}.error{color:#ffd58a}</style><main class="card"><div style="color:#78e0df;font-weight:800;letter-spacing:.15em">NORTHSTAR WEATHER · PRIVATE</div><h1>'+(success?'Welcome to your owner area':'Owner access')+'</h1><p class="'+(success?'':'error')+'">'+message+'</p>'+(success?'<a href="https://gunnermatt1991-del.github.io/Northstar-weather/">Open Northstar Weather</a><a href="https://gunnermatt1991-del.github.io/Northstar-weather/premium.html">Open Premium features</a><a href="https://gunnermatt1991-del.github.io/Northstar-weather/Northstar-UK-Map-Fixed%202.html">Open UK & Europe weather map</a><a href="https://www.paypal.com/myaccount/autopay/">Manage PayPal subscriptions</a><a href="https://dash.cloudflare.com/">Open Cloudflare controls</a>':'<a href="https://gunnermatt1991-del.github.io/Northstar-weather/owner.html">Return to owner login</a>')+'</main></html>',{status:success?200:401,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
      if (submittedCode.length > 256 || submittedCode !== env.OWNER_ACCESS_CODE) {
        if (isForm) return html("That owner code wasn't recognised.",false);
        return json({error:"That owner code wasn't recognised."},401);
      }
      if (isForm) return html("Owner access confirmed.",true);
      return json({token:await signOwnerSession(env.OWNER_ACCESS_CODE),email:OWNER_EMAIL,expiresIn:43200});
    }
    if (url.pathname === "/owner/verify") {
      if (!env.OWNER_ACCESS_CODE) return json({active:false,error:"Owner access is not configured"},503);
      let body; try { body=await request.json(); } catch { return json({active:false,error:"Invalid request"},400); }
      const active=await verifyOwnerSession(body?.token,env.OWNER_ACCESS_CODE);
      return json({active,mode:active?"owner-test":null});
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
