# Northstar Premium membership verifier

This Worker checks a subscription directly against PayPal's live API. PayPal credentials stay in Cloudflare Worker secrets; they are never sent to the browser or committed to this repository.

## GitHub repository configuration

Add these repository Actions secrets:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with permission to edit/deploy Workers.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.
- `PAYPAL_CLIENT_ID` — PayPal REST app client ID (live).
- `PAYPAL_CLIENT_SECRET` — PayPal REST app secret (live).

Add this Actions variable:

- `PAYPAL_PLAN_ID` — the live PayPal subscription plan ID.

The workflow deploys the Worker and writes the PayPal credentials into Worker secrets. It runs when files under `membership/` change on main, or manually from the Actions tab.

## Endpoint

POST `/verify` with JSON:

```json
{ "subscriptionId": "I-..." }
```

The Worker obtains a server-side PayPal OAuth token, retrieves the subscription from PayPal, and returns active only when its status is ACTIVE and its plan ID matches the configured Northstar plan.

## Important

- The PayPal plan must be activated in PayPal before customers can subscribe.
- Use the live PayPal app credentials and live plan ID. Sandbox credentials will not work with the live API.
- The browser must send the subscription ID to this endpoint after checkout and re-check it before unlocking paid features.
- A subscription ID is a bearer reference, not a full user identity system. For stronger account-level protection, add customer sign-in and bind the PayPal subscription to that account.
- This deployment workflow cannot run until the four GitHub secrets and one Actions variable above are configured.


The Premium page now uses the deployed `/verify` endpoint to check PayPal subscription status after checkout and on later visits.
