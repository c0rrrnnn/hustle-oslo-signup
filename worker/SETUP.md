# Hustle Oslo payments — test mode setup

This worker is **configured for test payments**. `ALLOW_LIVE_PAYMENTS` is `"false"` in `wrangler.toml`. In that mode it refuses a Stripe live secret (`sk_live_`) or live publishable key (`pk_live_`), and it calls Vipps at `https://apitest.vipps.no` even if `VIPPS_API_BASE` is set. Going live later is a config change Claire reviews, not a code change: set `ALLOW_LIVE_PAYMENTS` to `"true"`, use a live Stripe key pair, and set `VIPPS_API_BASE` to `https://api.vipps.no`. Register a separate production webhook and replace `VIPPS_WEBHOOK_SECRET`. The signup page accepts `pk_test_` or `pk_live_`; the worker only returns a live publishable key when live mode is on. Do not do that in this pass. Nothing in this setup moves real money.

The public site stays on `PAYMENTS_ENABLED: false` until you decide otherwise. Dancers keep the current path: the sheet stores `payment-pending`, and they Vipps **Hustle Oslo #48782**.

Do not paste keys into the repo, into chat, or into `wrangler.toml`. `worker/.dev.vars` is gitignored. `worker/.dev.vars.example` lists the names with empty values.

Account id already in `wrangler.toml`: `5564680c05464d959eaafd052eb97998`.

## 0. What you will create

| Secret | Where it comes from |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe test secret, starts with `sk_test_` |
| `STRIPE_PUBLISHABLE_KEY` | Stripe test publishable key, starts with `pk_test_` |
| `STRIPE_WEBHOOK_SECRET` | Stripe test webhook signing secret, starts with `whsec_` |
| `VIPPS_CLIENT_ID` | Vipps **test** sales unit |
| `VIPPS_CLIENT_SECRET` | Vipps **test** sales unit |
| `VIPPS_SUBSCRIPTION_KEY` | Vipps test primary `Ocp-Apim-Subscription-Key` |
| `VIPPS_MSN` | Vipps test merchant serial number |
| `VIPPS_WEBHOOK_SECRET` | The `secret` returned once when you register the Vipps webhook |
| `APPS_SCRIPT_SHARED_SECRET` | You generate it. Same value in Apps Script. |
| `ADMIN_SECRET` | You generate it. Protects `POST /order/:id/capture`. |

`CAPTURE_MODE` is not a secret. It is `immediate` in `wrangler.toml`. Change it to `reserve` only if you want Vipps to authorize and wait for the capture endpoint.

## 1. Cloudflare login and the orders namespace

From the repo, in `worker/`:

```bash
cd worker
npx wrangler login
npx wrangler whoami
```

`whoami` must show account `5564680c05464d959eaafd052eb97998`. If it shows a different account, stop. Do not deploy into another account.

Create the KV namespace the worker uses for orders:

```bash
npx wrangler kv namespace create ORDERS
```

The command prints an id (32 hex characters). Open `wrangler.toml` and replace the placeholder:

```toml
[[kv_namespaces]]
binding = "ORDERS"
id = "PASTE_THE_ID_HERE"
```

That id is not a secret. The placeholder `00000000000000000000000000000000` is not a real namespace. Deploy fails until you replace it.

## 2. Stripe test keys and the webhook

Use **test mode** the whole time. In the Stripe Dashboard the test-mode switch is on, and the keys start with `sk_test_` and `pk_test_`.

1. Open [API keys (test mode)](https://dashboard.stripe.com/test/apikeys).
2. Copy the **Publishable key** (`pk_test_…`). This is `STRIPE_PUBLISHABLE_KEY`. The worker returns it to the browser so Stripe.js can mount the Payment Element. It is still not committed.
3. Reveal the **Secret key** (`sk_test_…`). This is `STRIPE_SECRET_KEY`. Never copy a key that starts with `sk_live_`.
4. Open [Payment method domains (test)](https://dashboard.stripe.com/test/settings/payment_method_domains) and add `hustleoslo.com` and `www.hustleoslo.com` when you want Apple Pay or Google Pay on the public site. Card number `4242` works without that. Localhost will not show Apple Pay.
5. After the worker is deployed (step 6), add the webhook. You need the worker URL first. Come back to this step then:
   - Open [Webhooks (test)](https://dashboard.stripe.com/test/workbench/webhooks) (older dashboards: Developers → Webhooks). Stay in test mode.
   - Add an endpoint:
     - URL: `https://hustle-oslo-payments.<your-subdomain>.workers.dev/webhooks/stripe`
     - Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`
   - Open the endpoint and reveal the **Signing secret** (`whsec_…`). This is `STRIPE_WEBHOOK_SECRET`.
   - Set the secret with wrangler (step 5), then deploy once more so the worker has it.

The worker verifies the `Stripe-Signature` header, then retrieves the PaymentIntent from Stripe. The amount on the webhook body is not what gets marked paid. The retrieved PaymentIntent must be `succeeded`, in `nok`, and equal to the catalogue total.

The webhook answers as soon as that order is marked paid in KV. It does not wait for the spreadsheet. The Apps Script write starts in the background (`waitUntil`). A write counts only when Apps Script returns HTTP 2xx and `{ "ok": true }`. Anything else leaves `appsScriptPosted` false. A Cron Trigger in `wrangler.toml` runs every 5 minutes and retries those orders. After each failure the next try waits longer: 5 minutes, 15, 30, 60, then 3 hours, then 6 hours. Nights that already posted are not sent again, and Apps Script still ignores a duplicate payment id and event id. Stripe and Vipps do not need to retry just because the sheet was slow.

Test card: `4242 4242 4242 4242`, any future expiry, any CVC, any name. Declined card: `4000 0000 0000 0002`.

## 3. Vipps test sales unit

Use the **test** environment only. Do not open the production keys.

1. Log in to the Vipps MobilePay business portal: [https://portal.vipps.no](https://portal.vipps.no).
2. Sidebar → **For developers**.
3. Open the **API keys** tab and select **Test**.
4. If you need a new unit: **Add test sales unit**. Name it something like `Hustle Oslo test`. Leave **Direct capture** unchecked. The worker captures when `CAPTURE_MODE=immediate` (the default). If Direct capture is on, Vipps captures by itself and the reserve mode flag cannot hold the money.
5. Wait a minute and refresh. The new unit appears at the bottom of the list.
6. Copy the **Merchant Serial Number** next to the name. This is `VIPPS_MSN`.
7. **Show keys**. Copy:
   - `client_id` → `VIPPS_CLIENT_ID`
   - `client_secret` → `VIPPS_CLIENT_SECRET`
   - `Ocp-Apim-Subscription-Key` (primary) → `VIPPS_SUBSCRIPTION_KEY`
8. Create a **test user** in the same developer section (the portal’s test-user screen). Install the Vipps test app and log in as that user. The production Vipps app will not approve these payments.

Docs if the portal labels differ: [API keys](https://developer.vippsmobilepay.com/docs/knowledge-base/api-keys/), [test environment](https://developer.vippsmobilepay.com/docs/knowledge-base/test-environment/).

### Register the Vipps webhook

Do this after the first deploy, when you know the worker URL. These calls hit **apitest** only.

Get a test access token (replace the three values; do not commit the command with real values):

```bash
curl -sS -X POST https://apitest.vipps.no/accesstoken/get \
  -H "client_id: YOUR-CLIENT-ID" \
  -H "client_secret: YOUR-CLIENT-SECRET" \
  -H "Ocp-Apim-Subscription-Key: YOUR-SUBSCRIPTION-KEY" \
  -H "Merchant-Serial-Number: YOUR-MSN"
```

Copy `access_token` from the JSON. Then register the callback:

```bash
curl -sS -X POST https://apitest.vipps.no/webhooks/v1/webhooks \
  -H "Authorization: Bearer ACCESS-TOKEN" \
  -H "Ocp-Apim-Subscription-Key: YOUR-SUBSCRIPTION-KEY" \
  -H "Merchant-Serial-Number: YOUR-MSN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hustle-oslo-payments.<your-subdomain>.workers.dev/webhooks/vipps",
    "events": [
      "epayments.payment.authorized.v1",
      "epayments.payment.captured.v1",
      "epayments.payment.aborted.v1",
      "epayments.payment.expired.v1",
      "epayments.payment.cancelled.v1",
      "epayments.payment.terminated.v1"
    ]
  }'
```

Vipps returns an `id` and a `secret`. The secret is shown once. Save it as `VIPPS_WEBHOOK_SECRET` (`npx wrangler secret put VIPPS_WEBHOOK_SECRET`) and in a password manager. The worker checks the Webhooks API HMAC (`x-ms-date`, `x-ms-content-sha256`, `Authorization`) and rejects a missing or bad signature. The date is part of that signature. A retry that reuses an older `x-ms-date` is still accepted; the worker does not treat the webhook as paid until `GET /epayment/v1/payments/{reference}` shows the real status. The webhook’s own amount and name are ignored.

Confirm the registration, still on apitest:

```bash
curl -sS https://apitest.vipps.no/webhooks/v1/webhooks \
  -H "Authorization: Bearer ACCESS-TOKEN" \
  -H "Ocp-Apim-Subscription-Key: YOUR-SUBSCRIPTION-KEY" \
  -H "Merchant-Serial-Number: YOUR-MSN"
```

The list should include your worker URL and the ePayment events above. If the secret is lost, delete that webhook and register it again. Production (`https://api.vipps.no`) is a separate registration with its own secret. Do that only when you deliberately turn `ALLOW_LIVE_PAYMENTS` on.

If a webhook never arrives, the order does not stay pending forever. The return page’s `GET /order/:id` asks Vipps and, in immediate mode, captures. The same 5-minute cron retries pending Vipps orders that are at least 2 minutes old. After 24 hours it reads Vipps one last time: an authorized payment is still captured, a payment that is still only created is marked `expired`, and a failed read stays on the cron for the next run. `GET /order/:id` returns status and whether the confirmation email was sent. It does not return the buyer’s name, email, or the night list.

With `CAPTURE_MODE=immediate`, an authorized payment is captured by the worker, then read again. The sheet is updated only when the captured amount equals the catalogue total.

## 4. Two secrets you generate

Run this twice. Use a different value for each secret.

```bash
openssl rand -hex 32
```

- First value → `APPS_SCRIPT_SHARED_SECRET` (worker **and** Apps Script, same string).
- Second value → `ADMIN_SECRET` (worker only).

Anyone who has `ADMIN_SECRET` can capture a reserved Vipps payment. Anyone who has the shared secret can ask Apps Script to store a row as paid. Do not put either in the website.

## 5. Put the secrets on the worker

From `worker/`, run each command and paste the value when prompted. Wrangler does not write these into git.

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_PUBLISHABLE_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put VIPPS_CLIENT_ID
npx wrangler secret put VIPPS_CLIENT_SECRET
npx wrangler secret put VIPPS_SUBSCRIPTION_KEY
npx wrangler secret put VIPPS_MSN
npx wrangler secret put VIPPS_WEBHOOK_SECRET
npx wrangler secret put APPS_SCRIPT_SHARED_SECRET
npx wrangler secret put ADMIN_SECRET
```

For a local `wrangler dev` session, copy the example file and fill it on your machine only:

```bash
cp .dev.vars.example .dev.vars
```

## 6. Deploy the worker

From `worker/`, after the KV id is pasted into `wrangler.toml`:

```bash
npx wrangler deploy
```

Note the `*.workers.dev` URL. Check:

```bash
curl -sS https://hustle-oslo-payments.<your-subdomain>.workers.dev/health
```

Expected fields: `"ok": true`, `"mode": "test"`, `"allowLivePayments": false`, `"captureMode": "immediate"`, `"vippsApi": "https://apitest.vipps.no"`.

Then finish the Stripe webhook (step 2.5) and the Vipps webhook (step 3), set `STRIPE_WEBHOOK_SECRET` if you had not yet, and deploy once more:

```bash
npx wrangler deploy
```

Do not add a production custom domain in this pass.

## 7. Apps Script

The public site keeps posting `payment-pending` with no secret **until you launch payments**. A paid post is rejected unless `SHARED_SECRET` matches, whether or not the flag below is set.

### Rollout order — do not skip this

The browser cannot hold `APPS_SCRIPT_SHARED_SECRET`. Live https://hustleoslo.com/ still posts unpaid signups itself while `PAYMENTS_ENABLED` is false.

1. Deploy this Apps Script version with `REQUIRE_SHARED_SECRET` **unset** (or anything other than `true`). Unpaid signups keep working. Paid claims already need the secret. `confirmationOnly` from the website, which does not claim `paid`, still works.
2. Deploy the worker in test mode. `PAYMENTS_ENABLED` stays false on the public site.
3. When you are ready for real online payments, in this order: set the worker secrets, point a **non-public** preview at the worker with `PAYMENTS_ENABLED: true` (do not commit that), confirm a test payment writes one paid row and one confirmation email, then set script property `REQUIRE_SHARED_SECRET` to `true`. That locks every write and every `confirmationOnly`. Only the worker, which has the secret, can add rows or send mail.
4. Turn `PAYMENTS_ENABLED` on for the public site in the same change that stops the browser posting to Apps Script. If you set `REQUIRE_SHARED_SECRET` first, the live unpaid signup path starts failing.

Do not set `REQUIRE_SHARED_SECRET` while the live site is still posting from the browser.

1. Open the Hustle Oslo signups spreadsheet → **Extensions → Apps Script**.
2. Replace the script with `apps-script/Code.gs` from this repo.
3. Project settings → **Script properties** → add `APPS_SCRIPT_SHARED_SECRET` with the same value as the worker secret. Leave `SHEET_ID` as it is. Do **not** set `REQUIRE_SHARED_SECRET` yet.
4. **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy.** The web app URL does not change. Pasting the file without a new version does nothing to the live URL.
5. Do this **before** you send a test payment. Until this version is deployed, a paid post is handled by the old script, which does not check the secret and does not have the new columns.

New columns, added on the right when the header row still matches: **Payment provider**, **Payment id**, **Payment status**. A paid row looks like `stripe` / `pi_…` / `paid`, or `vipps` / the Vipps reference / `paid`. A payment-pending row has status `pending` and blank provider and id.

The worker writes one row per night after the payment is confirmed. That write can finish after the webhook has already returned. The browser does not write that booking. The append and the paid-row check run under Apps Script `LockService`, which is what makes one row and one confirmation email atomic. The worker’s KV lease is only a best-effort guard: two checkout requests for the same order wait and then share one PaymentIntent or Vipps redirect, and a provider error on the loser does not mark the winner failed. `/checkout` allows 30 new checkouts per 10 minutes per hashed IP. Replaying an order that already has a payment session does not count, and the rate-limit key expires with the window. A repeated webhook does not add a second row for the same payment id and event id. The attendee confirmation from hustleinoslo@gmail.com is sent once per payment id, on the paid post or on the confirmation follow-up if that first mail did not go out. If the first write fails or is too slow, the 5-minute cron tries again. The same cron also polls Vipps for pending Vipps orders.

## 8. Try it locally without changing main

Do not commit `PAYMENTS_ENABLED: true`. In a local checkout only, edit `app.js`:

```js
PAYMENTS_ENABLED: true,
PAYMENTS_WORKER_URL: "https://hustle-oslo-payments.<your-subdomain>.workers.dev",
```

The deployed allow-list is only `https://hustleoslo.com` and `https://www.hustleoslo.com`. For this local preview, put this in `worker/.dev.vars` (not in git):

```bash
ALLOWED_ORIGINS=https://hustleoslo.com,https://www.hustleoslo.com,http://localhost:8765,http://127.0.0.1:8765
```

```bash
python3 -m http.server 8765
```

Open http://localhost:8765/ and book one **future** night. Card, Apple Pay, and Google Pay mount Stripe’s Payment Element (test key only). Vipps redirects to the Vipps test page and returns to `/?order=…`.

Revert those two lines before you commit. `git diff app.js` should not show them.

To try reserve-then-capture, set `CAPTURE_MODE = "reserve"` in `wrangler.toml`, deploy, pay with Vipps, and confirm the order stays `reserved` and the sheet has no paid row. Then:

```bash
curl -sS -X POST \
  "https://hustle-oslo-payments.<your-subdomain>.workers.dev/order/ORDER-ID/capture" \
  -H "Authorization: Bearer YOUR-ADMIN-SECRET"
```

Put `CAPTURE_MODE` back to `immediate` and deploy again when you are done. The default pilot uses immediate.

## 9. Test-mode checklist

- [ ] `GET /health` returns `"mode":"test"` and `"captureMode":"immediate"`.
- [ ] `wrangler whoami` is account `5564680c05464d959eaafd052eb97998`.
- [ ] Stripe secret starts with `sk_test_`. Publishable key starts with `pk_test_`. No live keys in `.dev.vars` or the dashboard toggle.
- [ ] `ALLOW_LIVE_PAYMENTS` is still `"false"`. Vipps keys are from the **Test** sales unit. Direct capture is off. Calls go to `apitest.vipps.no`.
- [ ] `GET /webhooks/v1/webhooks` on apitest lists the worker URL. `VIPPS_WEBHOOK_SECRET` is the secret from that registration. An unsigned POST to `/webhooks/vipps` returns 401.
- [ ] Apps Script has a new deployment version and `APPS_SCRIPT_SHARED_SECRET` matches the worker. `REQUIRE_SHARED_SECRET` is not `true` yet.
- [ ] Local preview only: one Stripe payment with `4242 4242 4242 4242` for a future night. The sheet row is `paid`, provider `stripe`, payment id `pi_…`, amount equal to the catalogue (not a number you typed). The attendee email says payment received.
- [ ] Card `4000 0000 0000 0002` shows the existing Checkout failure screen (“Payment didn’t go through”). No paid row.
- [ ] One Vipps test-app payment. The browser goes to `apitest.vipps.no` and returns to the site. The row is `paid`, provider `vipps`. Captured amount in the Vipps test portal equals the catalogue total.
- [ ] Send the same Stripe webhook again from the Stripe dashboard (“Resend”). The sheet does not gain a second row. A slow sheet (the write plus the emails) still gets a fast webhook response; if the row is missing, wait for the 5-minute cron rather than expecting Stripe to time out and retry.
- [ ] Public https://hustleoslo.com/ still has payments off. View source or `app.js`: `PAYMENTS_ENABLED: false` and `PAYMENTS_WORKER_URL: ""`. A normal signup still stores `payment-pending` and does not call the worker.
- [ ] `git status` shows no `.dev.vars`, no keys, and no `PAYMENTS_ENABLED: true`.

## 10. One Monday pilot, with Vipps #48782 as the fallback

Do this on a Monday when there is a class, after the checklist is green. The public site does not change.

**That morning**

- Leave `PAYMENTS_ENABLED` false on main and on https://hustleoslo.com/.
- Tell dancers the usual thing: book on the site, then Vipps the total to **Hustle Oslo #48782**. The sheet will say payment pending. That is the fallback for the whole day, not a backup you switch on if something breaks. It is already the live path.
- On your own laptop, use the local preview from step 8 (flag on, worker URL set, file not committed).

**During the day, one test booking**

- Pick that Monday’s real class in the local preview.
- Pay once with Stripe test card `4242`.
- Pay once with the Vipps test app (a second local booking, or the same flow again).
- In the sheet, those two bookings show status `paid` and the test payment ids. Everyone else’s rows from hustleoslo.com still say `pending`.
- No real card is charged. The Vipps test app does not move real money. If a test payment appears in the Vipps **production** portal, stop and do not capture it.

**If the test misbehaves**

- Close the local preview. Do not edit the live site.
- Dancers are already on Vipps **#48782**. Nothing to roll back.
- Do not flip `PAYMENTS_ENABLED` to true “just for the evening”.
- Do not paste live Stripe or production Vipps keys to retry.

**After the Monday**

- Revert your local `app.js` edits.
- Leave the worker deployed in test mode, or delete the worker in the Cloudflare dashboard if you want it gone. Test orders in KV can stay.
- Going live (real cards, production Vipps, `api.vipps.no`, `sk_live_`) is a separate decision. This worker will refuse those keys until that code is deliberately changed.

## Endpoints

| Method | Path | Who calls it |
| --- | --- | --- |
| `POST` | `/checkout` | The site, only when payments are on. Price is looked up on the server. |
| `POST` | `/webhooks/stripe` | Stripe. Signature required, then a PaymentIntent retrieve. |
| `POST` | `/webhooks/vipps` | Vipps. Access token + `GET` payment. Webhook amount is ignored. |
| `GET` | `/order/:id` | The browser, to poll status. No client secret in the response. |
| `POST` | `/order/:id/capture` | You, with `Authorization: Bearer ADMIN_SECRET`, when a Vipps payment was left reserved. |
| `GET` | `/health` | You. Reports test mode and capture mode. |
