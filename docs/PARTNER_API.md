# Burnt Verify — Partner API (Model A)

The Partner API lets your backend drive Burnt Verify screenings headlessly: provision units, start a
screening for a specific applicant, hand out the application link, and read results — authenticated
with a company-scoped API key instead of an interactive login.

> Scope (v1): a partner can **provision units + screening rule sets, start a no-login screening for a
> specific applicant, hand out the application link, and read results**. Partner-controlled payment /
> merchant-of-record is PRO-528; and the underlying consumer-report data is not exposed over the API
> (PRO-535).

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
`https://app.burntverify.com/api/v1/...`. Use the demo environment for integration testing before
going live.

## Managed listers (aggregators)

If you screen on behalf of **many landlords** (you're an aggregator or marketplace, not a single
property manager), each landlord must be the party of record for their own applicants' Experian
reports — an FCRA requirement. Burnt models each as a **managed lister**: a lightweight, login-less
company you provision and address with your **one** API key.

- You **provision** a lister once (`POST /api/v1/listers`), then reference it by id on the calls that
  create resources for it.
- Each lister completes a **one-time Experian enrollment**
  (`POST /api/v1/listers/{listerId}/enrollment-session`) so it becomes the certified END_USER its
  reports share to. Screening under a lister is blocked until its `enrollment_status` is `verified`.
- Your key acts on **any lister you manage, and only those** — a lister id you don't manage returns
  `404` (the same "never reveal another tenant" rule as every other resource).
- **You remain the payer and the results recipient.** Operator-covered charges for a managed lister's
  screening hit **your** card on file (not the lister's), and every webhook for it is delivered to
  **your** endpoint with **your** signature. The lister is Experian's party of record; you are Burnt's.

If you screen for a **single** company (yourself), you don't need listers — skip this section and
create units directly under your own company.

## Endpoints

### Provision a managed lister

```
POST /api/v1/listers
```

Create a login-less lister you manage (see [Managed listers](#managed-listers-aggregators)). `name` is
required; everything else is optional. The lister is always linked to **your** company (the caller) —
you can't provision a lister under another partner.

```json
{
  "name": "Oakwood Property Management",
  "external_ref": "your-stable-lister-id",
  "owner_email": "manager@oakwood.example",
  "operator_first_name": "Dana",
  "operator_last_name": "Reed",
  "operator_phone": "+15125550143"
}
```

`external_ref` is your own id for the lister (stored and echoed back on reads); the operator contact
fields prefill the lister's Experian enrollment.

**201**

```json
{
  "lister": {
    "id": "comp_lister_abc",
    "name": "Oakwood Property Management",
    "external_ref": "your-stable-lister-id",
    "enrollment_status": "not_started",
    "created_at": "2026-07-28T00:00:00.000Z"
  }
}
```

Use `lister.id` as the `lister_id` on **Create a unit**. `enrollment_status` is one of
`not_started | processing | verified | failed`. The response never includes the lister's Experian key
or WorkOS org.

### List managed listers

```
GET /api/v1/listers   → { "data": [ { lister }, … ] }
```

Every lister you manage, each with its current `enrollment_status`. Never returns a lister's Experian
key or PII.

### Mint a lister enrollment link

```
POST /api/v1/listers/{listerId}/enrollment-session
```

Returns a **tokenized, no-login URL** you surface to the lister in your app. The lister opens it and
completes their one-time Experian END_USER enrollment (identity verification / KBA) with **no Burnt
account**. On success the lister becomes `verified` and can be screened under; you can watch that
transition via `GET /api/v1/listers`.

**201**

```json
{ "enrollment_url": "https://app.burntverify.com/enroll/comp_lister_abc#token=<token>" }
```

The `#token=…` fragment authorizes that one lister's enrollment and, because it is a URL fragment, is
never sent to the Burnt server in the request line. The link is **single-use on success** and expires
after 30 days — re-call to mint a fresh one. **404** if the lister isn't one you manage.

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

**Screening on behalf of a lister.** If you manage listers (see
[Managed listers](#managed-listers-aggregators)), pass `"lister_id": "comp_lister_abc"` to create the
unit — and every screening under it — **owned by that lister**. The lister becomes Experian's party of
record for the applicants, while **you** remain the payer and the webhook recipient. Omit `lister_id`
to create the unit under your own company. A `lister_id` you don't manage returns `404`. The lister
must be `verified` before an applicant can run the Experian step.

**Payment.** The package total is a flat $20. Who pays is controlled by `fee_payer` in the `screening`
object:

- `"fee_payer": "applicant"` (default) — the applicant pays `applicant_pays_cents` in Burnt's flow and
  the landlord covers the remainder. If the landlord owes anything (`applicant_pays_cents` < $20),
  include a `payment_method_id` for a card already saved on the company so it can be auto-charged.
- `"fee_payer": "operator"` — **you cover the whole fee and the applicant is never charged.** The
  applicant payment step is hidden; the company's card on file (`payment_method_id`) is charged the
  full $20 **up front**, before the applicant runs the screening / identity / income steps. Requires a
  saved `payment_method_id`. Use this when you collect payment from your own applicants in your own
  checkout and settle with Burnt.

(The Intellirent SDK no longer collects the applicant fee — it's collected through Burnt's Stripe rail
now, so there is no per-package minimum and `applicant_pays_cents` can be any value ≥ 0.)

To get a `payment_method_id`, save a card in the dashboard (**Settings → Billing**), then look it up with
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
    "application_url": "https://app.burntverify.com/verify/lnk_abc123"
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
(**Settings → Billing**); the API never returns raw Stripe identifiers.

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

Pass a method's `id` as the top-level `payment_method_id` when you **Create a unit** — the card is attached
at unit-create time (there's no unit-update endpoint, and the rule-set call can't set or change it). This
`id` is Burnt's own payment-method id: it shares the `pm_` prefix with Stripe's PaymentMethod ids but is
**not** a Stripe identifier — use it only as Burnt's `payment_method_id`.

### Configure a unit's screening

```
POST /api/v1/units/{unitId}/rule-set
```

Body: `{ "component_ids": [...], "applicant_pays_cents": 2000, "currency": "usd", "fee_payer": "applicant", "replace_active": false }`.
`fee_payer` works exactly as in **Create a unit** above (`"operator"` = you cover the whole fee up front
from the unit's saved card, applicant not charged). Returns the rule set plus the application link. If the unit already has an operator-configured active
rule set, pass `replace_active: true` to overwrite it (otherwise `409 { "code": "rule_set_exists" }`).

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
  "application_url": "https://app.burntverify.com/verify/lnk_abc123"
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
  "application_url": "https://app.burntverify.com/verify/lnk_abc123",
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
  "apply_url": "https://app.burntverify.com/verify/lnk_def456#token=<token>&application=rapp_abc123"
}
```

Deliver `apply_url` to the applicant as-is (email, SMS, or an in-app redirect). The `#token=…`
fragment authorizes that one application; because it is a URL fragment it is never sent to the Burnt
server in the request line. Poll `GET /api/v1/application-groups/{application_group_id}` for status.

**Re-issuing rotates the token.** Each call issues a **new** apply token for the same screening and
**invalidates the `apply_url` from the previous call** — any link you already handed out stops working,
while `application_id` / `application_group_id` stay the same and the newest `apply_url` resumes the
_same_ screening exactly where the applicant left off (nothing is reset). Idempotency is scoped to the
unit's **current active rule set**: if the operator replaces the rule set, a later call legitimately
starts a **fresh** application with new ids. So treat this endpoint as **create-or-rotate**, not a read:
store the `apply_url` you get back and re-call only when you deliberately want to issue a fresh link.

**404** — the unit isn't yours, or has no active rule set. **410 `{ "code": "unit_unavailable" }`** —
the unit already has an accepted application, so no new applicant can apply.

**Identity & compliance (partner-asserted identity).** In this flow **you vouch for the applicant's
identity**: the apply token binds the screening to the applicant you named, standing in for a Burnt
login. The applicant still gives FCRA consent inside the Burnt flow, recorded against this application
(consent text version + timestamp + IP/UA) and linked to the identity you supplied (`external_id` /
email, stored as `partner_external_ref`). Before enabling this in production, obtain legal sign-off
that partner-asserted identity plus that consent record is sufficient "who-consented" evidence for
your use.

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
  invitation. If you need a fully login-free experience for participants too, tell us — an opt-in
  "tokenized participant invitations" mode is on the roadmap; it would email each participant a
  tokenized link that runs the same no-login flow.

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
the operator decides, then `decision.decision` is `"accepted"` or `"rejected"`. `verification_status` is one of `pending | in_progress | completed | failed |
expired` (or `null`).

The `applicants` array has **one entry per household member** — the primary plus every co-applicant /
co-signer / guarantor — so its length is the household size, and each entry carries that person's own
`status` and `verification_status`. Each entry's `role` is currently `"applicant"` for all members
(the partner view does not yet break out participant kind). `id` is that member's screening (link) id,
not a person id, and carries no PII.

**404** — unknown group, or a group belonging to another company.

## Webhooks

Configure a webhook URL + signing secret per organization (dashboard/operator API). Burnt POSTs these
events so you don't have to poll:

| Event                         | Fires when                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `verification.completed`      | An individual verification check completes                                                                            |
| `verification.failed`         | A verification check fails                                                                                            |
| `application.review_required` | An applicant's check was routed to manual review (completion is delayed, not broken)                                  |
| `application_group.completed` | Every applicant screening in a group has reached a terminal state                                                     |
| `application_group.decided`   | An operator accepted or rejected the household — carries the same `decision` object as `GET /application-groups/{id}` |

New event types may be added over time — **ignore any `event` you don't recognize** rather than erroring on it.

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

**Idempotency.** Deliveries may be retried. Deduplicate on the delivery id (and/or event id) so you
process each event once.

**Correlation.** Payloads carry `unit_id`, `application_group_id`, and `link_id` — use these to tie an
event back to the unit whose application link you provisioned.

**Managed listers.** Events for a managed lister's screening are delivered to **your** (the managing
partner's) URL + signing secret — a lister has no webhook of its own. Use the payload's `unit_id` /
`application_group_id` / `link_id` to attribute the event to the lister whose unit you created (map it
back via the `lister_id` you passed on **Create a unit**).

## Errors

| Status                            | Meaning                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `401`                             | Missing, malformed, unknown, or revoked API key          |
| `403 { "code": "API_KEY_SCOPE" }` | A key was used on a non-`/api/v1` (dashboard) endpoint   |
| `403`                             | The company account is disabled                          |
| `404`                             | Unknown resource, or a resource owned by another company |

## Typical integration flow

_Aggregators first: `POST /api/v1/listers` to provision each landlord, surface the
`enrollment-session` link so they complete Experian enrollment (`enrollment_status: verified`), then
create units with that `lister_id`. Single-company partners skip this and create units under
themselves._

1. Your backend creates the unit + screening in one call (`POST /api/v1/units` with a `screening`
   package — plus `lister_id` if screening for a managed lister) — or the operator configures it in
   the dashboard.
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
   reached a terminal state (plus per-check `verification.*` events along the way).
5. Your backend calls `GET /api/v1/application-groups/{id}` for the final status + decision.
