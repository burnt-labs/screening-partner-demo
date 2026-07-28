# Partner Integration Models

Reference for conversations with organizations that want to embed Burnt Verify screening
into **their own platform** and send screenings to their users — potentially without those
users creating a Burnt account, and with the partner collecting payment from their own
customers.

> Status: discovery / options. Model A (headless partner API), Model B (no-login applicant flow), and
> **per-lister / aggregator support (managed listers, SCR-450: SCR-451–456)** are now **built** — see
> [`PARTNER_API.md`](./PARTNER_API.md); the rest remain options. "Exists" = shippable today; "Net-new" =
> needs a build. The previously-open aggregator, FCRA-responsibility, and Experian-certification
> questions are now **resolved** (see §5).

---

## 1. Context: how the platform works today

- **Stack:** single Cloudflare Worker (Hono) + React SPA + D1, WorkOS AuthKit for auth.
- **Operators** (property managers) authenticate via interactive WorkOS AuthKit login. One
  WorkOS org ↔ one `companies` row (1:1), and every domain table is scoped by `company_id`.
- **Applicants** (renters) reach a `/verify/:linkId` link. The invite _preview_ is
  unauthenticated, but claiming/filling/submitting a screening **requires a WorkOS AuthKit
  login today** — the applicant becomes a WorkOS user and their PII/consent binds to that
  `workos_user_id`.
- **Results delivery already exists:** per-organization **outbound, HMAC-signed webhooks**
  (`verification.completed` / `verification.failed` / `application_group.completed`) —
  `src/worker/routes/webhooks.ts`, `src/worker/services/webhook.ts`.
- **No machine-to-machine API credential exists.** `companies.api_key_hash` /
  `api_key_prefix` columns and the `DASHBOARD_API_KEY` env var are reserved but **dead code**
  — nothing issues or validates them. An external system cannot authenticate to our API today.
- **No white-label / per-tenant branding** (schema has only `display_name`; branding is a
  noted "future" item).
- **Screening providers:** credit/background/eviction via **Intellirent (Experian)**;
  income via **Argyle / Truv**; payments via **Stripe**.
- **SSN posture:** Burnt does **not** store applicant SSN (PRO-402). Intellirent's hosted
  SDK collects it; Argyle/Truv don't need it.

---

## 2. Integration models we can offer

### Model A — Headless API + webhooks (partner's platform drives everything)

The partner's backend creates screenings programmatically and receives results by webhook;
the screening lives inside **their** UI.

- **Exists:** `POST /api/links` creates a screening; outbound signed webhooks push results.
- **Net-new:** a **machine-to-machine credential** (API key or OAuth client-credentials) so
  the partner can call our API without an interactive WorkOS login. The DB slots
  (`api_key_hash` / `api_key_prefix`) are already reserved, so this is a bounded build, not a
  rearchitecture.
- Best when the partner wants full control of the UX and only needs Burnt as a screening
  engine behind the scenes.
- **Aggregators (built, SCR-450).** A partner that screens for **many** landlords manages them all
  with one API key via **managed listers**: `POST /api/v1/listers` provisions a login-less lister,
  `POST /api/v1/listers/{id}/enrollment-session` returns a tokenized no-login link the lister uses to
  complete its own Experian `END_USER` enrollment, and `lister_id` on **Create a unit** runs that
  landlord's screenings under it. Each lister is Experian's party of record (its report shares to its
  own `END_USER`); the **partner stays the payer and webhook recipient**. Cross-tenant access 404s. See
  [`PARTNER_API.md`](./PARTNER_API.md) → **Managed listers**.

### Model B — Embedded / no-login applicant flow (our verify flow, no Burnt account)

The partner hands their user a link (or embeds our flow) and the user completes screening
without creating a Burnt account.

- **Shipped (PRO-538):** `POST /api/v1/units/{unitId}/screenings` mints a per-applicant,
  hashed, TTL'd **apply token** (the same primitive family as the results token in
  `src/worker/services/request-access.ts`) and returns a tokenized `apply_url`. The applicant
  opens it and completes the whole flow with no Burnt account. See
  [`PARTNER_API.md`](./PARTNER_API.md) for the endpoint + flow.
- **Scope:** the token authorizes the **primary** applicant the partner creates. Co-applicants,
  co-signers, and guarantors the primary adds still use the Burnt login (they're third parties
  whose identity the partner can't assert). A follow-up can tokenize participant invitations too.
- **Gate before go-live (not code):** applicants log in today partly for FCRA consent + durable
  identity binding. This flow uses **partner-asserted identity** + the standard consent record
  (IP/UA/version); legal sign-off that this is sufficient "who-consented" evidence is still
  required before enabling it in production.

### Model C — Federated SSO handoff (seamless, still technically authenticated)

The partner's users authenticate through their own IdP, federated into WorkOS AuthKit, so
they never see a Burnt login screen. Preserves the current architecture (applicant is still a
WorkOS user, consent binding intact) while removing friction. Often the lowest-risk answer if
"no login" really means "don't make my users create a _Burnt_ account."

### Model D — White-label branding

Make the applicant experience look like the partner's product. **Does not exist** today;
net-new. Independent of the no-login question — can be layered onto B or C.

---

## 3. Money-flow model the partner wants

The partner wants to be the **merchant of record** to their own customers:

```
Partner's customer ──pays──▶ Partner ──pays──▶ Burnt ──pays──▶ Stripe / Argyle / Intellirent
```

Implications:

- **Burnt becomes the aggregator/payer** to the underlying providers; the partner is billed
  by Burnt (prepaid balance or invoicing). This requires **per-transaction cost accounting**
  (which screening consumed which provider) so we can reconcile what to charge the partner.
- **Argyle / Truv:** already server-side and paid by Burnt — fits this model directly.
- **Stripe:** today we use Stripe for applicant-facing fees. In this model the partner charges
  their own customer via _their_ Stripe. Our Stripe use may reduce to billing the partner
  (or a Stripe Connect arrangement). Decide which.
- **Intellirent (Experian):** the current blocker — see below.

---

## 4. The Intellirent payment blocker — RESOLVED (PRO-539), headless path kept as history

> **Update — PRO-539 (shipped).** Intellirent **removed the mandatory in-SDK payment step**;
> billing is now metered credits Burnt pre-funds on their side. Burnt therefore collects the
> applicant fee itself through its own Stripe rail, driven by a per-rule-set `fee_payer`
> (`applicant` default | `operator`). In `operator` mode the partner's card on file is charged
> the full total up front and the applicant is never charged — this is what unblocked the Snag
> integration. See `docs/PARTNER_API.md` (`fee_payer`) and PR #371. **This closes the blocker
> below without the headless re-architecture**, and does **not** reverse PRO-402 (the SDK still
> collects SSN). The headless-API discussion in the rest of this section is retained as
> historical context / the PRO-528 fallback we no longer need to ship.

### The problem (historical)

Previously Intellirent was **SDK-mounted**. Each landlord enrolls (END*USER) and gets their own
publishable key; the applicant (CONSUMER) authorizes that landlord and the **SDK ran a
mandatory payment step (min ~$15) that could not be removed**. That inline,
consumer-facing charge was incompatible with the partner controlling payment themselves.
Server-side we only do the report \_fetch* (`/auth/token/exchange` → `/reports/{id}` with
`X-Publishable-Key`; `src/worker/services/intellirent.ts`) — the SDK owns registration, KBA,
and sharing.

### What the Intellirent API (https://docs.ir.app/api/getting-started) offers

The docs describe a **fully headless HTTP flow with no inline payment step**:

- **Auth:** `X-API-KEY` header (SSO token) — e.g. `GET /api/experian/agents/{agentId}/auth/status`.
- **Flow:** register consumer `POST /api/experian/renters/{renterId}` → submit KBA answers
  `POST /api/experian/renters/{renterId}/kba` → retrieve report
  `GET /api/experian/renters/{renterId}/report`.
- **Payment is decoupled via a PREPAID ACCOUNT BALANCE.** There is no per-report payment UI in
  the API; instead report retrieval fails with **HTTP 402 / error 285 — "Account's prepaid
  balance is exhausted. Resolve billing before retrying."**

### Why this is promising

A prepaid-balance model is **exactly** what the money-flow in §3 needs:

- Burnt pre-funds a balance with Intellirent.
- Screenings are ordered headlessly and drawn down against that balance — **no $15 consumer-
  facing SDK charge**.
- The partner charges their own customer whatever they want, pays Burnt, and Burnt's prepaid
  balance covers the Intellirent cost.

This lets us stop waiting on Intellirent to separate the SDK's payment step — we bypass the SDK
for screening entirely.

### Cost / caveats to weigh (significant)

- **Re-architecture, not a config flip.** We'd own consumer registration, **KBA (the identity
  quiz)**, and report retrieval that the SDK handles today — including the applicant-facing KBA
  UX and error handling.
- **PII/SSN posture changes.** Headless ordering means **Burnt collects SSN + DOB** and passes
  them to Intellirent, reversing PRO-402 (we deliberately removed SSN because the hosted SDK
  collected it). This is a real compliance decision, not just an engineering one.
- **Report sharing model may change.** Today the landlord views the report via the CONSUMER→
  END_USER share the SDK sets up; a headless flow needs the equivalent worked out.
- **Endpoint/verb details are from a docs summary** and should be confirmed against a live
  Intellirent sandbox account before we commit (the paths above differ from our current
  `/auth/token/exchange` + `/reports/{id}` surface).

---

## 5. Open questions

### For the partner

1. Integration shape — headless API in _their_ UI (Model A), or embed/redirect to our flow
   (B/C/D)?
2. "No login" — no Burnt account at all (magic link), or just invisible via SSO (they're
   already signed into the partner app)?
3. ~~Are they a single company or an **aggregator/reseller** with many landlords underneath?
   (We're 1 company ↔ 1 org today; no sub-accounts.)~~ **Resolved (SCR-450):** aggregators are
   supported via **managed listers** — one partner API key manages many login-less lister companies
   (`managed_by_partner_company_id`), each addressed by `lister_id`. Sub-accounts now exist for this
   case. See [`PARTNER_API.md`](./PARTNER_API.md) → _Managed listers_.
4. ~~FCRA / consumer-report responsibility — who is the responsible party, and must consent be
   captured inside our flow?~~ **Resolved:** for aggregators, **each lister is the party of record** —
   screening runs under the lister and the report shares to that lister's Experian END_USER (not the
   aggregator's). Each lister completes its own one-time END_USER enrollment. Applicant consent is
   still captured inside the Burnt flow, bound to the application (partner-asserted identity, per
   Model B); legal sign-off on that consent record remains the go-live gate.
5. Which products — Intellirent credit/background, Argyle/Truv income, or all?
6. Result delivery — push webhook (exists) or a pull/redirect-with-results?
7. Branding — must it be their brand (white-label, net-new)?
8. Volume, pricing, and confirmation that **they** are merchant of record to their customers.
9. Timeline / pilot scope.

### For Intellirent

1. ~~Per-report **cost against the prepaid balance**, and whether any **minimum charge** still
   applies headlessly (i.e. does the $15 floor disappear or persist?).~~ **Answered (PRO-539):**
   the in-SDK payment step (and its ~$15 floor) was removed; billing is metered credits Burnt
   pre-funds, and Burnt sets the applicant-facing fee itself (no provider floor).
2. Do we have to run **KBA ourselves** via the API, or is there a hosted KBA option?
3. How is **report sharing to the landlord** handled in the headless API vs. the SDK's
   CONSUMER→END_USER model?
4. Sandbox vs production API keys, allowed-origin rules, and rate limits for headless use.
5. ~~Contractual/certification requirements for an aggregator ordering on behalf of many
   landlords (Experian resale/end-user certification).~~ **Answered:** Intellirent confirmed that
   **per-lister END_USER enrollment under Burnt's single platform key is FCRA-valid** — each lister is
   the certified end user. Enrollment is completed via a tokenized no-login link (SCR-452); Burnt
   stores no SSN (PRO-402 unchanged).

---

## 6. Rough recommendation

- **Results back to the partner:** basically ready (webhooks).
- **Partner creating screenings:** needs the API-key layer — bounded, slots already reserved.
- **Payment control + Intellirent $15 blocker:** **resolved (PRO-539).** Intellirent removed
  the in-SDK payment step, so Burnt now collects the applicant fee via its own Stripe rail
  with a per-rule-set `fee_payer` (applicant pays, or the operator/partner card is charged up
  front). No headless re-architecture and no SSN-posture change were needed.
- **No-login applicant experience:** doable on top of our existing link-token primitive;
  align on the consent model first, or use federated SSO (Model C) as the lower-risk interim.
- **Aggregator / per-lister:** **built (SCR-450).** One partner key manages many listers; each is
  Experian's party of record via its own tokenized no-login enrollment, while the partner stays the
  payer and webhook recipient.

---

### Key files

- Current Intellirent server integration: `src/worker/services/intellirent.ts`
- Intellirent setup / secrets / per-landlord model: `docs/EXPERIAN_INTELLIRENT_SETUP.md`
- Outbound webhooks: `src/worker/routes/webhooks.ts`, `src/worker/services/webhook.ts`,
  `src/shared/webhook.ts`
- Screening creation: `src/worker/routes/links.ts`
- Applicant flow + auth: `src/client/pages/verify/VerifyFlow.tsx`,
  `src/worker/services/request-access.ts`
- Org/company model + auth: `src/worker/db/schema.sql`, `src/worker/middleware/auth.ts`
