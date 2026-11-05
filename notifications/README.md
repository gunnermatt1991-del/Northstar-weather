# Northstar Weather Notifications

This folder contains the separate Cloudflare Worker for Northstar Weather push notifications. It is intentionally isolated from the GitHub Pages website.

## Deployment

In Cloudflare Workers & Pages, connect this repository and set the root directory to `notifications`. Use `npx wrangler deploy` as the deploy command.

Before deployment:
1. Create a D1 database named `northstar-notifications`.
2. Run `schema.sql` against that database.
3. Replace the placeholder `database_id` in `wrangler.toml` with the D1 database ID.
4. Add the VAPID public/private keys as Worker secrets/variables. Never commit the private key.
5. Complete the Worker implementation and test endpoints before enabling it in the live app.

Do not deploy until these setup steps and the Worker implementation are complete.
