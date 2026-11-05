# Northstar Weather Notifications

This folder contains the separate Cloudflare Worker for Northstar Weather push notifications. It is intentionally isolated from the GitHub Pages website.

## Cloudflare setup

In Workers & Pages, connect this repository and set the root directory to `notifications`. Deploy command: `npx wrangler deploy`.

Before deployment:
1. Create a D1 database named `northstar-notifications`.
2. Run `schema.sql` against that database.
3. Replace the placeholder `database_id` in `wrangler.toml` with the actual D1 database ID.
4. Add Worker secrets named `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and `ADMIN_KEY`. Never commit private keys or the admin key.
5. Confirm the Pages origin in `APP_ORIGIN` matches the live Northstar Weather site exactly.
6. Test the health endpoint, subscription flow, and push delivery before enabling it in the live app.

The Worker exposes /health, /public-key, /subscribe, /unsubscribe, and an admin-protected /test endpoint. A scheduled check runs every 15 minutes and checks the next six hours of Open-Meteo forecast data for enabled rain, wind, snow and freezing alerts. Thresholds are conservative starting defaults and should be reviewed before production use.

Do not deploy until D1 is created, its ID is configured, secrets are set, and the front-end subscription controls are integrated and tested.
