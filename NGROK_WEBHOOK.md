# Local Webhook Testing with ngrok

Payment processors (PayPal, ConnectPay, Stripe) deliver webhooks as server-to-server POST requests over the public internet. They can't reach `localhost:4000`, so during development we expose the API through an ngrok tunnel.

This guide is WSL-first (Ubuntu-22.04). The API listens inside WSL, so we run ngrok there too — that way the tunnel and the API share a network namespace and `localhost:4000` resolves cleanly.

---

## 1. Install ngrok in WSL

From a WSL shell (`wsl.exe -d Ubuntu-22.04` or any Ubuntu terminal):

```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
  | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install -y ngrok
```

Verify:

```bash
ngrok version
```

## 2. Authenticate ngrok

One-time setup. Get your token from <https://dashboard.ngrok.com/get-started/your-authtoken> and run:

```bash
ngrok config add-authtoken <YOUR_AUTHTOKEN>
```

This writes `~/.config/ngrok/ngrok.yml`. You only do this once per WSL user.

## 3. Start the tunnel

The API binds to **port 4000** (not 5173 — that's the web dev server). With the free static domain ngrok assigned to your account, the URL stays the same across restarts:

```bash
ngrok http --url=YOUR-STATIC.ngrok-free.dev 4000
```

You'll see something like:

```
Forwarding   https://YOUR-STATIC.ngrok-free.dev -> http://localhost:4000
```

Leave that terminal running. The tunnel dies when you Ctrl-C.

> **No static domain?** Just run `ngrok http 4000`. You'll get a random `https://xxxx.ngrok-free.app` URL that changes every restart — workable, but you'll re-paste it into every processor's dashboard each time.

### Local inspector

ngrok's local inspector lives at <http://127.0.0.1:4040>. It logs every request the tunnel saw, with full headers + body, and has a **Replay** button — invaluable when a webhook 500s and you need to re-fire the exact same signed payload without re-doing the approve-a-subscription dance in the processor's UI.

## 4. Point the API at the tunnel

Edit `apps/api/.env` (create from `.env.example` if needed):

```env
API_BASE_URL=https://YOUR-STATIC.ngrok-free.dev
WEB_BASE_URL=http://127.0.0.1:5173
```

Leave `WEB_BASE_URL` as localhost — the API only uses it to redirect the user's browser, which is local. `API_BASE_URL` is what gets baked into PayPal/ConnectPay `return_url` values, so it needs to be publicly reachable.

Restart the API after editing `.env`:

```bash
pnpm --filter @mobileflow/api dev
```

## 5. Configure the processor's webhook

The API mounts each processor's webhook at:

```
https://YOUR-STATIC.ngrok-free.dev/api/billing/webhook/<provider>
```

Where `<provider>` is `stripe`, `paypal`, or `connectpay`. The admin panel (Settings → Payment Processors → expand a card) shows the exact URL with a copy button.

### PayPal

1. **Dashboard**: <https://developer.paypal.com/dashboard/applications/sandbox> → your app → **Add Webhook**.
2. **Webhook URL**: `https://YOUR-STATIC.ngrok-free.dev/api/billing/webhook/paypal`
3. **Event types** — subscribe to at minimum:
   - `BILLING.SUBSCRIPTION.CREATED`
   - `BILLING.SUBSCRIPTION.ACTIVATED`
   - `BILLING.SUBSCRIPTION.UPDATED`
   - `BILLING.SUBSCRIPTION.CANCELLED`
   - `BILLING.SUBSCRIPTION.EXPIRED`
   - `BILLING.SUBSCRIPTION.SUSPENDED`
   - `PAYMENT.SALE.COMPLETED`
   - `PAYMENT.SALE.REFUNDED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.CAPTURE.REFUNDED`
4. After saving, PayPal shows a **Webhook ID** (format `4UY…`). Copy it.
5. In the app: **Admin → Payment Processors → PayPal → Sandbox → Webhook ID** → paste → **Save**.

Without the Webhook ID, `paypal.ts:verifyWebhook` returns `null` and every event is rejected as unverified.

### ConnectPay

1. **Dashboard**: ConnectPay merchant portal → Settings → API & Webhooks.
2. **Webhook URL**: `https://YOUR-STATIC.ngrok-free.dev/api/billing/webhook/connectpay`
3. **HMAC secret**: copy the signing secret ConnectPay shows on the same page.
4. In the app: **Admin → Payment Processors → ConnectPay → Sandbox** → paste the HMAC secret into **HMAC signing secret** → **Save**.

ConnectPay signs each webhook with HMAC-SHA256 over `<timestamp>.<body>` using that secret; `connectpay.ts:verifyWebhook` checks it with `timingSafeEqual`.

### Stripe

If you want webhooks for Stripe locally, the standard tool is the Stripe CLI (`stripe listen --forward-to localhost:4000/api/billing/webhook/stripe`) — no tunnel needed because the CLI opens a long-poll connection to Stripe. The admin UI shows the exact command in the Stripe → Sandbox card.

You *can* use ngrok for Stripe too if you prefer (paste the tunnel URL into Stripe's dashboard the same way), but the CLI is friendlier because it prints each event to your terminal as it arrives.

## 6. Smoke test

1. Hit the tunnel URL in your browser — you should see the API's 404 page (no route at `/`). If you see the ngrok interstitial instead, click through it once to dismiss it for your IP.
2. In the processor's dashboard, look for a "Send test webhook" or "Resend" button. Fire one event.
3. Watch:
   - **ngrok inspector** (<http://127.0.0.1:4040>) — should show the incoming POST with a 200 response.
   - **API logs** — should log either a successful handler run or a verification failure (which means your secret/webhook-id is wrong).

If the inspector shows the request but the API doesn't log anything, the request hit ngrok but didn't reach your API — usually means the API isn't running, or it's bound to a different port.

## 7. Day-to-day workflow

Three terminals (split panes / tmux / Windows Terminal tabs all fine):

| Terminal | Command |
| --- | --- |
| 1. API | `pnpm --filter @mobileflow/api dev` |
| 2. Web | `pnpm --filter @mobileflow/web dev` |
| 3. ngrok | `ngrok http --url=YOUR-STATIC.ngrok-free.dev 4000` |

If you restart ngrok without a static domain, the URL changes and you need to:

1. Update `API_BASE_URL` in `apps/api/.env` and restart the API.
2. Update the webhook URL in each processor's dashboard.

The static domain skips both of those.

## 8. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| ngrok inspector shows the POST, API has no log entry | API not running, wrong port, or bound to a different host |
| API logs `webhook signature invalid` | Wrong Webhook ID (PayPal) / HMAC secret (ConnectPay) / signing secret (Stripe), or mode mismatch — sandbox creds being checked against a live-mode webhook (or vice versa) |
| PayPal dashboard rejects the webhook URL on save | URL isn't HTTPS, isn't reachable, or returned non-2xx to PayPal's validation ping. Make sure the API is up before saving. |
| Browser sees the ngrok interstitial when hitting the tunnel URL directly | First-visit warning — click through once. Webhooks (non-browser User-Agent) bypass it. |
| `ngrok: command not found` after install | `~/.local/bin` not on PATH or apt installed to `/usr/bin/ngrok` but you're in a stale shell — open a new terminal |
| Tunnel works for ~30 seconds then disconnects | Free tier without an authtoken caps sessions to 30s. Run `ngrok config add-authtoken …` and restart the tunnel |

## Reference

- **Webhook routes**: `apps/api/src/routes/billing.ts` — `billingWebhookRoutes` at the bottom of the file.
- **Verification per processor**: `apps/api/src/billing/adapters/{stripe,paypal,connectpay}.ts` — each has a `verifyWebhook` method.
- **Bounce-back routes** (vault approval): `GET /api/billing/{paypal,connectpay}-vault/return` in `billing.ts` — these don't need ngrok per se (they're browser redirects), but PayPal won't let you save a non-HTTPS `return_url` on production-mode credentials, so `API_BASE_URL` must be the tunnel URL there too.
