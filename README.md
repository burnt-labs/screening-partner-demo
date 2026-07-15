# Screening by Burnt — Partner API demo

A tiny local app to walk the **Screening by Burnt** Partner API (Model A/B) end to end: provision a unit +
screening, start a **no-login** screening for an applicant, get a tokenized apply URL, then poll the
household (application-group) status and decision.

- **`server.js`** — an Express **proxy**. The browser talks only to this server; this server holds the
  `bvk_` API key and makes the real Burnt calls with it.
- **`public/index.html`** — a single vanilla-JS page (three sections + raw-JSON viewers).
- **[`docs/PARTNER_API.md`](docs/PARTNER_API.md)** — the full Partner API reference (endpoints,
  request/response shapes, webhook signatures, error codes) that this harness exercises.

## Security model (the one rule that matters)

**The API key never reaches the browser.** The page calls this local proxy (`/api/*`); the proxy adds
`Authorization: Bearer $BURNT_API_KEY` and forwards to `${BURNT_BASE_URL}/api/v1/...`, returning Burnt's
status + body verbatim. The key lives only in `.env` (gitignored) and only in the Node process.

## Setup

1. **`.env`** (already created; gitignored). The important knob:

   ```
   BURNT_API_KEY=bvk_…                     # your partner key (a real secret)
   BURNT_BASE_URL=http://localhost:5173    # MUST match the env where the key was minted
   PORT=4000
   BURNT_WEBHOOK_SECRET=                   # optional; only to verify inbound webhooks
   ```

   > ⚠️ **`BURNT_BASE_URL` must be the same environment that minted the key.** A key from a different
   > environment just returns **401**. Options: local `http://localhost:5173`, staging
   > `https://app.staging.screening.burnt.com`, demo `https://app.demo.screening.burnt.com`, live
   > `https://app.screening.burnt.com`. This key is a **staging** key, so `BURNT_BASE_URL` points at
   > staging.

2. **The Burnt app must be reachable at `BURNT_BASE_URL`.** For **staging/demo/live** it's already hosted —
   nothing to run locally. Only for **local** do you start it yourself: `pnpm dev` in the
   `burnt-verify-real-estate` repo serves the app and `/api/v1` on `http://localhost:5173` (if 5173 is busy,
   Vite picks the next port — update `BURNT_BASE_URL` to match).

3. **Install & run:**

   ```bash
   npm install
   npm start
   # → open http://localhost:4000
   ```

**Quick key sanity check** (should return `{"data":[…]}`, not 401):

```bash
# from partner_app/, load .env then hit the configured environment:
set -a; . ./.env; set +a
curl -s "$BURNT_BASE_URL/api/v1/units" -H "Authorization: Bearer $BURNT_API_KEY"
```

## The flow

1. **Create unit + screening** (section 1) → note the `unit_…` id and `application_url`.
2. **Start no-login screening** (section 2) → returns an `apply_url` with a `#token=…` fragment. The unit
   id is prefilled from step 1.
3. **Open the `apply_url`** (it opens in a new tab) and complete the screening **as the applicant** in the
   Burnt app.
4. **Poll** (section 3, prefilled with the `application_group_id`; toggle 5s auto-poll) until `status`
   reaches a terminal value (`pass` / `fail`) and `decision` populates.

Every call shows the raw JSON response in a collapsible block, and errors surface the status code + body.

## Fee modes (section 1)

Package total is a flat **$20 (2000 cents)**.

- **`fee_payer: applicant`** with **`applicant_pays_cents: 2000`** → landlord owes $0 → **no saved card
  needed.** This is the simplest end-to-end path.
- **`fee_payer: operator`** (operator prepays the whole $20; applicant is never charged) **or** any
  `applicant` split where `applicant_pays_cents < 2000` → the landlord owes > $0, which **requires a
  `payment_method_id`** (a top-level field, sibling of `screening`).

The Partner API **cannot add cards.** To get a `payment_method_id`, save a card in the **Burnt dashboard**
first (Settings → Billing), then paste its id into the `payment_method_id` field. There is no unit-update
endpoint, so the card must be attached **at unit-create time** for a later landlord-paid rule set to work.

## Webhooks (optional — polling is the reliable local path)

`server.js` includes a `POST /webhooks/burnt` receiver that verifies Burnt's signature
(`X-Burnt-Signature: sha256=<hex>` over `` `${timestamp}.${deliveryId}.${rawBody}` `` with
`BURNT_WEBHOOK_SECRET`, 5-min freshness window, constant-time compare, delivery-id dedupe) and logs
`verification.completed` / `verification.failed` / `application_group.completed`. Received events are also
visible in the "Webhooks received" panel.

**Locally, expect this to stay empty**, because:

- Burnt only sends to a **public HTTPS** URL — a `localhost` receiver **can't be registered** (you'd need
  an `ngrok`/`cloudflared` tunnel, and to point Burnt at the `https://…` tunnel URL).
- The webhook URL + secret are configured in the **Burnt dashboard** (Settings → Developers → Webhooks) —
  **not** via the partner key (that route is dashboard-only and 403s API keys).
- `application_group.completed` is delivered by an every-minute **cron** that does **not** fire under local
  `vite dev`.

So for **local** testing, **poll section 3**. Against **staging** (where the cron runs) webhooks work end
to end — set them up like this:

### Wiring webhooks up against staging

You need a public HTTPS URL that forwards to the harness's `/webhooks/burnt`. Use a quick tunnel:

```bash
# second terminal, with `npm start` already running on :4000
cloudflared tunnel --url http://localhost:4000      # prints https://<random>.trycloudflare.com
# or: ngrok http 4000
```

Then:

1. **Register the URL** in the staging dashboard → **Settings → Developers → Webhooks**. Set **Endpoint URL**
   to `https://<your-tunnel-host>/webhooks/burnt` and click **Save URL**. (Must be public HTTPS with no
   `#fragment` — a tunnel URL qualifies; `localhost` does not.)
2. **Copy the signing secret** from the one-time yellow banner, put it in `.env` as `BURNT_WEBHOOK_SECRET=…`,
   and **restart `npm start`** (the receiver only verifies once the secret is set). Lost it? **Rotate secret**
   → update `.env` again.
3. **Click “Send test”** in the dashboard → it should report `Test delivered (HTTP 200)`, and a `webhook.test`
   row appears (`✓ verified`) in the harness "Webhooks received" panel (hit **Refresh**).
4. **Run a real screening** (sections ①–③). `verification.completed` arrives immediately;
   `application_group.completed` within ~1 min (staging cron). Watch them land in the panel.

Debugging via the panel's **outcome** column: `✕ rejected: signature mismatch` → the `.env` secret ≠ the
dashboard secret (re-copy or rotate, then restart); `received (… not set …)` → `BURNT_WEBHOOK_SECRET` is
blank (set it + restart); nothing arrives at all → the dashboard's **Recent deliveries** list shows the
send-side error (tunnel down / wrong URL).

## Proxy routes (browser → this server → Burnt `/api/v1`)

| This server | → Burnt |
| --- | --- |
| `POST /api/create-unit` | `POST /units` |
| `GET /api/units`, `GET /api/units/:id` | `GET /units`, `GET /units/:id` |
| `POST /api/units/:id/rule-set` | `POST /units/:id/rule-set` |
| `GET /api/units/:id/application-link` | `GET /units/:id/application-link` |
| `POST /api/start-screening` | `POST /units/:unitId/screenings` |
| `GET /api/group/:id` | `GET /application-groups/:id` |

`GET /api/state` (last ids + base URL for prefill) and `GET /api/webhooks` are local-only helpers.

## Notes / gotchas

- **`apply_url` / `application_url` are opaque** — deliver them exactly as returned; never re-encode the
  `#token=…` fragment (it authorizes the applicant client-side).
- Error `code`s have mixed casing (`DUPLICATE_UNIT`, `API_KEY_SCOPE` vs `rule_set_exists`,
  `unit_unavailable`), and the 401 body varies — the harness displays whatever comes back, it doesn't
  assert on it.
- If a call returns **502** from this proxy, the main Burnt app isn't reachable at `BURNT_BASE_URL`.
