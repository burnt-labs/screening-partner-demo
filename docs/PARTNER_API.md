# Screening by Burnt — Partner API

The Partner API lets your backend drive Screening by Burnt screenings headlessly: provision units, start a
screening for a specific applicant, hand out the application link, and read results — authenticated
with a company-scoped API key instead of an interactive login.

> Scope (v1): a partner can **provision units + screening rule sets, start a no-login screening for a
> specific applicant, hand out the application link, and read results**. Partner-controlled payment /
> merchant-of-record and API access to the underlying consumer-report data are on the roadmap (the
> report data is not exposed over the API today).

## Authentication

Every request carries a company-scoped API key as a bearer token:

```
Authorization: Bearer bvk_<handle>_<secret>
```

**Getting a key.** In the Burnt dashboard, go to **Settings → Developers → API keys** and generate one. The full
key is shown **once** at creation — store it securely; it cannot be retrieved again. Only a SHA-256
hash is kept server-side.

**Rotation & revocation.** Generating a new key immediately invalidates the previous one (hard
cutover — there is no overlap window). Revoking removes API access entirely until a new key is made.

**Scope.** An API key can only call the `/api/v1/*` endpoints below. It cannot access the interactive
dashboard API; those routes return `403 { "code": "API_KEY_SCOPE" }` for a key.

## Base URL & versioning

All partner endpoints live under `/api/v1` on your Burnt host, e.g.
`https://app.screening.burnt.com/api/v1/...`. Use the demo environment for integration testing before
going live.

## Endpoints

### Create a unit

```
POST /api/v1/units
```

`property_label` and `monthly_rent_cents` are required; everything else is optional. Include a
`screening` package to configure the rule set (and mint the application link) in the same call.

```json
{
  "property_label": "123 Main St",
  "unit_label": "Apt 2",
  "monthly_rent_cents": 300000,
  "address_line1": "123 Main St",
  "city": "Austin",
  "state": "TX",
  "postal_code": "78701",
  "country": "US",
  "bedrooms": 2,
  "screening": { "component_ids": ["credit", "evictions", "income"], "applicant_pays_cents": 2000 }
}
```

Provide the structured address fields (`address_line1`, `city`, `state`, `postal_code`, `country`) —
the duplicate-address guard keys off them, so `city`/`state`/`postal_code` alone can false-positive
against other units in the same zip.

**Payment.** The screening package has a single total (**currently $20**). Who pays is controlled by `fee_payer` in the `screening`
object:

- `"fee_payer": "applicant"` (default) — the applicant pays `applicant_pays_cents` in Burnt's flow and
  the landlord covers the remainder. If the landlord owes anything (`applicant_pays_cents` below the package total),
  include a `payment_method_id` for a card already saved on the company so it can be auto-charged.
- `"fee_payer": "operator"` — **you cover the whole fee and the applicant is never charged.** The
  applicant payment step is hidden; the company's card on file (`payment_method_id`) is charged the
  full package total **up front**, before the applicant runs the screening / identity / income steps. Requires a
  saved `payment_method_id`. Use this when you collect payment from your own applicants in your own
  checkout and settle with Burnt.

(There is no per-package minimum — `applicant_pays_cents` can be any value ≥ 0.)

To get a `payment_method_id`, save a card in the dashboard (**Settings → Payments**), then look it up with
[`GET /api/v1/payment-methods`](#list-saved-payment-methods) — the API can't add cards, only list them.

**201**

```json
{
  "unit": {
    "id": "unit_abc123",
    "property_label": "123 Main St",
    "monthly_rent_cents": 300000,
    "screening_configured": true,
    "created_at": "2026-07-13T00:00:00.000Z"
  },
  "application": {
    "application_link_id": "lnk_abc123",
    "application_url": "https://app.screening.burnt.com/verify/lnk_abc123"
  }
}
```

`application` is `null` when no `screening` package is supplied. `400` on invalid input; `409` if the
address duplicates an existing live unit.

### List / get units

```
GET /api/v1/units            → { "data": [ { unit }, … ] }
GET /api/v1/units/{unitId}   → a single unit (404 if it isn't yours)
```

### List saved payment methods

```
GET /api/v1/payment-methods
```

Returns the company's active saved cards so you can resolve a `payment_method_id` to attach to an
operator-paid (or landlord-split) unit. **Read-only** — cards are added and removed in the dashboard
(**Settings → Payments**); the API never returns raw Stripe identifiers.

**200**

```json
{
  "data": [
    {
      "id": "pm_abc123",
      "brand": "visa",
      "last4": "4242",
      "exp_month": 12,
      "exp_year": 2027,
      "is_default": true,
      "linked_unit_count": 2,
      "created_at": "2026-07-13T00:00:00.000Z"
    }
  ]
}
```

Pass a method's `id` as the top-level `payment_method_id` when you **Create a unit**. The Partner API sets a
unit's card only at create-time (there's no unit-update endpoint), but you can **add or change a unit's card
in the dashboard** — open the unit → **Unit rules set → Payment method → Save payment method** — so you never
need to create a new unit just to swap the card. This
`id` is Burnt's own payment-method id: it shares the `pm_` prefix with Stripe's PaymentMethod ids but is
**not** a Stripe identifier — use it only as Burnt's `payment_method_id`.

### Configure a unit's screening

```
POST /api/v1/units/{unitId}/rule-set
```

Body: `{ "component_ids": [...], "applicant_pays_cents": 2000, "fee_payer": "applicant", "replace_active": false }`.
`fee_payer` works exactly as in **Create a unit** above (`"operator"` = you cover the whole fee up front
from the unit's saved card, applicant not charged). Currency is always USD and is set by Burnt — you do
not send it (any `currency` you pass is ignored). Returns the rule set plus the application link. If the
unit already has an operator-configured active rule set, pass `replace_active: true` to overwrite it
(otherwise `409 { "code": "rule_set_exists" }`).

**200** (replaced) / **201** (created)

```json
{
  "unit_id": "unit_abc123",
  "status": "active",
  "component_ids": ["credit", "evictions", "income"],
  "applicant_pays_cents": 2000,
  "currency": "usd",
  "monthly_rent_cents": 300000,
  "threshold_multiplier": 40,
  "application_link_id": "lnk_abc123",
  "application_url": "https://app.screening.burnt.com/verify/lnk_abc123"
}
```

### Get a unit's application link

```
GET /api/v1/units/{unitId}/application-link
```

Returns the reusable application link for a unit's active rule set. `application_url` is the URL you
hand to (or embed for) your applicant.

**200**

```json
{
  "unit_id": "unit_abc123",
  "application_link_id": "lnk_abc123",
  "application_url": "https://app.screening.burnt.com/verify/lnk_abc123",
  "rule_set": {
    "status": "active",
    "component_ids": ["credit", "evictions", "income"],
    "applicant_pays_cents": 3500,
    "currency": "usd",
    "monthly_rent_cents": 300000
  }
}
```

**404** — the unit doesn't belong to your company, or has no active rule set (the operator hasn't
configured/enabled one). Errors never reveal whether a resource exists in another tenant.

### Start a no-login screening for an applicant

```
POST /api/v1/units/{unitId}/screenings
```

For partners whose users are already signed in to your app, this mints an **individual screening** for
one applicant under the unit's active rule set and returns a tokenized **apply URL** the applicant
opens to complete it — **no Burnt account required**. (Contrast with the reusable application link
above, which asks each applicant to sign in first.)

```json
{
  "applicant_email": "jane@example.com",
  "applicant_name": "Jane Doe",
  "external_id": "your-stable-user-id"
}
```

`applicant_email` is required. `external_id` — your own stable identifier for the user — is optional
but recommended: it is the **dedupe key**, so calling again with the same `external_id` returns the
same screening with a fresh token instead of creating a duplicate. Without it, the email is the dedupe
key.

**201** (created) / **200** (idempotent re-issue for an applicant who already has an open screening)

```json
{
  "application_id": "rapp_abc123",
  "application_group_id": "grp_abc123",
  "application_link_id": "lnk_def456",
  "apply_url": "https://app.screening.burnt.com/verify/lnk_def456#token=<token>&application=rapp_abc123"
}
```

Deliver `apply_url` to the applicant as-is (email, SMS, or an in-app redirect). The `#token=…`
fragment authorizes that one application; because it is a URL fragment it is never sent to the Burnt
server in the request line. Poll `GET /api/v1/application-groups/{application_group_id}` for status.

**Re-issuing rotates the token.** Each call issues a **new** apply token for the same screening and
**invalidates the `apply_url` from the previous call** — `application_id` / `application_group_id` stay
the same, but any link you already handed out stops working. Opening the newest `apply_url` resumes the
*same* screening exactly where the applicant left off; nothing is reset. So treat this endpoint as
**create-or-rotate**, not a read: store the `apply_url` you get back and re-call only when you
deliberately want to issue a fresh link.

**404** — the unit isn't yours, or has no active rule set. **410 `{ "code": "unit_unavailable" }`** —
the unit already has an accepted application, so no new applicant can apply.

**Identity & compliance (partner-asserted identity).** In this flow **you vouch for the applicant's
identity**: the apply token binds the screening to the applicant you named, standing in for a Burnt
login. The applicant still gives FCRA consent inside the Burnt flow, recorded against this application
(consent text version + timestamp + IP/UA) and linked to the identity you supplied (`external_id` /
email, stored as `partner_external_ref`).

### Co-applicants, co-signers & guarantors (the household)

Inside the flow, the primary applicant can add **co-applicants, co-signers, and guarantors**. Each
becomes a **separate screening** that person completes individually, and together they roll up into the
same **application group** (the household) you poll via `GET /api/v1/application-groups/{id}`.

**These additional people are not tokenized.** The no-login apply URL you receive authorizes exactly
one application — the primary applicant you created. When the primary submits, Burnt emails each
co-applicant / co-signer / guarantor a standard invitation link, and **they complete their screening
with the registered (Burnt) login**, signing in with the email address the primary invited. This is
deliberate:

- You vouch for **your own registered user** (the primary). You generally can't assert the identity of
  a third party the primary names by email (a roommate, or a parent acting as guarantor), so those
  people authenticate themselves.
- Only the invited email address may claim each invitation — verified at sign-in — so a screening can
  never bind to the wrong person.

What this means for your integration:

- You only ever call `POST …/screenings` for the **primary** applicant. You do **not** create
  participant screenings through the API; the primary adds them from inside the flow.
- The whole household's progress and the operator's final decision still surface through the single
  `application_group_id` you already hold (each participant appears in the `applicants` array). You
  don't need a separate handle per participant.
- A participant without a Burnt account is asked to create one (or sign in) when they open their
  invitation.

### Read application-group status & decision

```
GET /api/v1/application-groups/{id}
```

An **application group** is the household for one applicant's screening — a group forms when you start
a no-login screening (`POST …/screenings`) or when an applicant claims your unit's reusable link. This
returns its status, the operator's decision, and per-applicant screening status, **including any
co-applicants / co-signers / guarantors the primary added**. It deliberately returns **no regulated
data** — no applicant names, income figures, provider claims, or report payloads.

**200**

```json
{
  "id": "grp_abc123",
  "unit_id": "unit_abc123",
  "application_link_id": "lnk_abc123",
  "status": "pass",
  "decision": {
    "decision": "accepted",
    "reason_codes": [],
    "decided_at": "2026-07-12T15:04:05.000Z",
    "adverse_action_required": false,
    "adverse_action_notice_sent_at": null,
    "reversible_until": "2026-07-19T15:04:05.000Z"
  },
  "passes_threshold": true,
  "applicants": [
    {
      "id": "lnk_def456",
      "status": "completed",
      "verification_status": "completed",
      "verification_method": "source",
      "role": "applicant"
    }
  ],
  "created_at": "2026-07-10T00:00:00.000Z",
  "latest_activity_at": "2026-07-12T15:04:05.000Z"
}
```

`status` is one of `pending | partial | error | pass | fail | archived`. `decision` is `null` until
the operator decides, then `decision.decision` is `"accepted"` or `"rejected"`. `verification_status`
is one of `pending | in_progress | completed | failed | expired` (or `null`).

The `applicants` array has **one entry per household member** — the primary plus every co-applicant /
co-signer / guarantor — so its length is the household size, and each entry carries that person's own
`status` and `verification_status`. Each entry's `role` is currently `"applicant"` for all members
(the partner view does not yet break out participant kind). `id` is that member's screening (link) id,
not a person id, and carries no PII.

**404** — unknown group, or a group belonging to another company.

## Paying for your applicants (you collect payment in your own app)

Some partners charge their applicants **inside their own app** — their own checkout, their own
merchant-of-record — and don't want Burnt to charge the applicant at all. That's `fee_payer: "operator"`:
**you cover Burnt's per-screening fee (currently $20) from your company card on file, and the applicant never sees a
Burnt payment step.**

Burnt isn't involved in what you charge your user — that transaction happens entirely in your app. Burnt
only charges **you** its per-screening fee; what you collect from the applicant, and how, is up to you.

**1) Save a card (one-time).** The Partner API can't add cards, but it can list them. In the Burnt
dashboard go to **Settings → Payments** and save a company card, then read its `payment_method_id` from
[`GET /api/v1/payment-methods`](#list-saved-payment-methods). You pass that id when you
create units.

**2) Create units operator-paid.** Attach the card and set `fee_payer: "operator"` at unit-create time.
`payment_method_id` is a **top-level** field (a sibling of `screening`, not inside it). Via the API you set
the card at unit-create time (there's no unit-update endpoint); to add or change a unit's card afterward, use
the dashboard (unit → **Unit rules set → Payment method**). A landlord-paid rule set reads the card off the
unit:

```json
POST /api/v1/units
{
  "property_label": "123 Main St",
  "monthly_rent_cents": 300000,
  "address_line1": "123 Main St", "city": "Austin", "state": "TX", "postal_code": "78701", "country": "US",
  "payment_method_id": "pm_abc123",
  "screening": { "component_ids": ["credit", "evictions", "income"], "fee_payer": "operator" }
}
```

In `operator` mode `applicant_pays_cents` is forced to `0` (you can omit it). Omitting the card returns
`400 { "error": "payment_method_id is required when the landlord pays part of the package" }`. (You can
also switch an existing unit to operator with `POST /api/v1/units/{unitId}/rule-set` + `fee_payer:
"operator"`, as long as the unit has a saved card — add or change one in the dashboard if it doesn't.)

**3) Start the screening as usual.** Nothing changes for you here — call
`POST /api/v1/units/{unitId}/screenings` and hand the applicant the returned `apply_url`. Burnt charges
your saved card the package total **up front, the moment the applicant begins their screening**, before any
checks (identity / income / credit) run. The charge is **idempotent per application**, so re-issuing the
`apply_url` for the same applicant never double-charges.

**Keep a valid card on file.** If the card is missing, inactive, or the charge declines when the applicant
begins, their screening is **blocked** until it's resolved — the applicant's paid step returns `402` with
`OPERATOR_PAYMENT_METHOD_REQUIRED`, `OPERATOR_PAYMENT_METHOD_UNAVAILABLE`, or `OPERATOR_PAYMENT_FAILED`.
The Partner API can't change a unit's card, but the **dashboard can** — open the unit → **Unit rules set →
Payment method**, pick a different saved card, and **Save payment method** (add cards under **Settings →
Payments**). No need to create a new unit.

## Webhooks

Configure a webhook URL + signing secret per organization (dashboard/operator API). Burnt POSTs these
events so you don't have to poll:

| Event                         | Fires when                                                        |
| ----------------------------- | ----------------------------------------------------------------- |
| `screening.check.completed`   | A single check finished — `check` is one of `identity`, `credit`, `evictions`, `background`, `income`, `employment`. A real-time progress signal, fired mid-flow as each step completes (before submit) |
| `application.review_required` | An applicant's check was routed to manual review (completion is delayed, not broken) |
| `application.completed`       | One applicant's screening reached a terminal result (all their checks + reviews done) |
| `application_group.completed` | Every applicant screening in a group has reached a terminal state |
| `application_group.decided`   | An operator accepted or rejected the household — carries the same `decision` object as `GET /application-groups/{id}` |

New event types may be added over time — **ignore any `event` you don't recognize** rather than erroring on it.

**Correlating events to your applicant.** Every event payload carries the handles you got back when you created the screening, so you can map an event to your record without parsing the `apply_url`: `application_id` (the rental application), `group_id` (the household), and `external_id` (the id you passed on create). On group events these appear per applicant in the `applicants[]` array. All three are `null` for non-partner / reusable links.

**Progress vs. result.** `screening.check.completed` is a lightweight, PII-free **progress** signal fired the instant each check finishes, mid-flow. It does not carry the verified result — read the verified data from `GET /application-groups/{id}` (per-applicant income, decision, and status), which is also rolled into the terminal `application.completed` / `application_group.completed`, released when the applicant **submits**. So a check finishing early does not leak its result.

**Signature verification.** Every delivery carries three headers:

| Header                | Value                                                                                |
| --------------------- | ------------------------------------------------------------------------------------ |
| `X-Burnt-Signature`   | `sha256=<hex>` — HMAC-SHA256 of the signed string, using your webhook signing secret |
| `X-Burnt-Timestamp`   | ISO-8601 send time (e.g. `2026-07-13T15:04:05.000Z`)                                 |
| `X-Burnt-Delivery-Id` | Unique per delivery                                                                  |

The signed string is `` `${X-Burnt-Timestamp}.${X-Burnt-Delivery-Id}.${rawBody}` `` — using the **raw request body** exactly as received, before any JSON parsing. Recompute the HMAC with your secret, compare it to `X-Burnt-Signature` in constant time, and reject any delivery whose `X-Burnt-Timestamp` is more than ~5 minutes from now (replay protection).

```js
import crypto from 'node:crypto';

// `rawBody` must be the exact bytes of the request body (Buffer/string), not a re-serialized object.
function verifyBurntWebhook(headers, rawBody, secret) {
  const signature = headers['x-burnt-signature'];
  const timestamp = headers['x-burnt-timestamp'];
  const deliveryId = headers['x-burnt-delivery-id'];
  if (!signature || !timestamp || !deliveryId) return false;
  if (Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60 * 1000) return false; // replay window

  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${rawBody}`).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

**Any language.** The signature is a standard HMAC-SHA256 over the same signed string, so you can verify it
in whatever your backend runs. The same check in Python:

```python
import hashlib
import hmac
import time
from datetime import datetime


def verify_burnt_webhook(headers, raw_body, secret):
    """`raw_body` = the exact request body as received (str or bytes), not a re-serialized dict."""
    signature = headers.get("x-burnt-signature")
    timestamp = headers.get("x-burnt-timestamp")
    delivery_id = headers.get("x-burnt-delivery-id")
    if not (signature and timestamp and delivery_id):
        return False
    # X-Burnt-Timestamp is ISO-8601 — enforce the 5-minute replay window.
    sent = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
    if abs(time.time() - sent) > 5 * 60:
        return False
    body = raw_body.decode() if isinstance(raw_body, bytes) else raw_body
    signed = f"{timestamp}.{delivery_id}.{body}"
    expected = "sha256=" + hmac.new(secret.encode(), signed.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)
```

**Idempotency.** Deliveries may be retried. Deduplicate on the delivery id (and/or event id) so you
process each event once.

**Correlation.** Payloads carry `unit_id`, `application_group_id`, and `link_id` — use these to tie an
event back to the unit whose application link you provisioned.

## Errors

| Status                            | Meaning                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `401`                             | Missing, malformed, unknown, or revoked API key          |
| `403 { "code": "API_KEY_SCOPE" }` | A key was used on a non-`/api/v1` (dashboard) endpoint   |
| `403`                             | The company account is disabled                          |
| `404`                             | Unknown resource, or a resource owned by another company |

## Typical integration flow

1. Your backend creates the unit + screening in one call (`POST /api/v1/units` with a `screening`
   package) — or the operator configures it in the dashboard.
2. Get the applicant into the flow, one of two ways:
   - **No-login (recommended when your users are already signed in):** `POST
/api/v1/units/{unitId}/screenings` with the applicant's email → deliver the returned `apply_url`.
     The applicant completes the screening without a Burnt account.
   - **Reusable link:** show/embed the unit's `application_url` (from step 1 or `GET
/api/v1/units/{unitId}/application-link`); each applicant signs in to Burnt to claim it.
3. The applicant completes the screening in the Burnt flow. If they add co-applicants / co-signers /
   guarantors, each of those people gets an emailed invitation and completes their own screening via
   the Burnt login (see [the household section](#co-applicants-co-signers--guarantors-the-household));
   all of them roll into the same `application_group_id`.
4. You receive `application_group.completed` at your webhook once **every** member of the household has
   reached a terminal state (plus per-check `screening.check.completed` events along the way).
5. Your backend calls `GET /api/v1/application-groups/{id}` for the final status + decision.
