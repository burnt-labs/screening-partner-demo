// Screening by Burnt Partner API — demo backend.
//
// This Express server is a thin PROXY. The browser talks only to this server; this server holds the
// `bvk_` API key (from .env) and makes the real Burnt Partner API calls with it. The key NEVER reaches
// the browser. Every /api/* route below forwards to `${BURNT_BASE_URL}/api/v1/...` with the Bearer
// header attached, and returns Burnt's status + JSON verbatim so you can inspect the real payloads.

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BURNT_API_KEY = process.env.BURNT_API_KEY || '';
const BURNT_BASE_URL = (process.env.BURNT_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
const BURNT_WEBHOOK_SECRET = process.env.BURNT_WEBHOOK_SECRET || '';
const PORT = Number(process.env.PORT) || 4000;

if (!BURNT_API_KEY) {
  console.warn('⚠  BURNT_API_KEY is not set in .env — every Partner API call will 401.');
}

// ── In-memory state (last ids), for form prefill after reload ─────────────────
// DEMO SHORTCUT: this state is per-process and lost on restart. A real integration doesn't keep ids in
// memory — persist unit_id / application_group_id on your own records (lease, applicant, user) so you can
// correlate results later, and back `seenDeliveries` with a durable store (DB/Redis) so webhook dedupe
// survives restarts and works across instances. See README → "Going to production".
let lastUnitId = null;
let lastGroupId = null;
const recentWebhooks = []; // most-recent-first; capped
const seenDeliveries = new Set(); // webhook idempotency (demo-only — see note above)

// ── Burnt Partner API proxy helper ────────────────────────────────────────────
/**
 * Call the Burnt Partner API server-side with the Bearer key attached. Returns the upstream status
 * and parsed body (or `{ raw }` for non-JSON). Throws only on a transport failure (server unreachable).
 */
async function burntFetch(method, apiPath, body) {
  const res = await fetch(`${BURNT_BASE_URL}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${BURNT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text }; // upstream returned non-JSON (unusual) — surface it rather than crash
  }
  return { status: res.status, json };
}

/** Wrap a proxy handler so a transport failure (main app down / wrong BURNT_BASE_URL) becomes a clear 502. */
function proxy(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[proxy] ${req.method} ${req.originalUrl} failed:`, err?.message || err);
      res.status(502).json({
        error: `Could not reach BURNT_BASE_URL (${BURNT_BASE_URL}). Is the main Burnt app running there?`,
        detail: String(err?.message || err),
      });
    }
  };
}

/** Drop empty-string / null values so we never send e.g. applicant_name:"" (fails the API's min(1)). */
function pruneEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== '' && v != null) out[k] = v;
  }
  return out;
}

// ── App wiring ────────────────────────────────────────────────────────────────
const app = express();

// Webhook route FIRST, with a raw body parser scoped to it (signature is over the RAW bytes).
// Registering it before express.json() keeps the raw Buffer intact for HMAC verification.
app.post('/webhooks/burnt', express.raw({ type: '*/*' }), handleWebhook);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1) Create a unit (optionally configuring screening + minting the link in one call).
app.post(
  '/api/create-unit',
  proxy(async (req, res) => {
    const { status, json } = await burntFetch('POST', '/api/v1/units', req.body);
    if (status < 400 && json?.unit?.id) lastUnitId = json.unit.id;
    res.status(status).json(json);
  }),
);

// 2) List / get units.
app.get(
  '/api/units',
  proxy(async (_req, res) => {
    const { status, json } = await burntFetch('GET', '/api/v1/units');
    res.status(status).json(json);
  }),
);
app.get(
  '/api/units/:id',
  proxy(async (req, res) => {
    const { status, json } = await burntFetch('GET', `/api/v1/units/${encodeURIComponent(req.params.id)}`);
    res.status(status).json(json);
  }),
);

// 3) (Re)configure a unit's screening rule set (pass replace_active:true to overwrite an active one).
app.post(
  '/api/units/:id/rule-set',
  proxy(async (req, res) => {
    const { status, json } = await burntFetch(
      'POST',
      `/api/v1/units/${encodeURIComponent(req.params.id)}/rule-set`,
      req.body,
    );
    res.status(status).json(json);
  }),
);

// 4) Get a unit's reusable application link.
app.get(
  '/api/units/:id/application-link',
  proxy(async (req, res) => {
    const { status, json } = await burntFetch(
      'GET',
      `/api/v1/units/${encodeURIComponent(req.params.id)}/application-link`,
    );
    res.status(status).json(json);
  }),
);

// 5) Start a NO-LOGIN screening for one applicant (Model B). unit_id comes from the body or the
//    last-created unit. Only applicant_email is required; name/external_id are optional.
app.post(
  '/api/start-screening',
  proxy(async (req, res) => {
    const { unit_id, ...rest } = req.body || {};
    const unitId = (unit_id && String(unit_id).trim()) || lastUnitId;
    if (!unitId) {
      return res.status(400).json({ error: 'No unit_id provided and none stored yet. Create a unit first.' });
    }
    const { status, json } = await burntFetch(
      'POST',
      `/api/v1/units/${encodeURIComponent(unitId)}/screenings`,
      pruneEmpty(rest),
    );
    if (status < 400 && json?.application_group_id) lastGroupId = json.application_group_id;
    res.status(status).json(json);
  }),
);

// 6) Read application-group (household) status + decision — the poll target.
app.get(
  '/api/group/:id',
  proxy(async (req, res) => {
    const { status, json } = await burntFetch(
      'GET',
      `/api/v1/application-groups/${encodeURIComponent(req.params.id)}`,
    );
    if (status < 400 && json?.id) lastGroupId = json.id;
    res.status(status).json(json);
  }),
);

// Convenience: last-known ids + config for the UI to prefill (never returns the API key).
app.get('/api/state', (_req, res) => {
  res.json({ lastUnitId, lastGroupId, baseUrl: BURNT_BASE_URL, hasKey: Boolean(BURNT_API_KEY) });
});

// Convenience: webhooks this server has received + verified (rarely populated locally — see README).
app.get('/api/webhooks', (_req, res) => {
  res.json({ data: recentWebhooks, webhookSecretConfigured: Boolean(BURNT_WEBHOOK_SECRET) });
});

// ── Webhook receiver ──────────────────────────────────────────────────────────
/**
 * Verify a Burnt webhook. Signed string is `${timestamp}.${deliveryId}.${rawBody}`, HMAC-SHA256 hex,
 * prefixed `sha256=`. Rejects if the timestamp is >5 min old. Constant-time compare. (Mirrors the
 * main repo's src/shared/webhook.ts byte-for-byte.)
 */
function checkWebhookSignature(headers, rawBody, secret) {
  const sig = headers['x-burnt-signature'];
  const ts = headers['x-burnt-timestamp'];
  const id = headers['x-burnt-delivery-id'];
  if (!sig || !ts || !id) return { ok: false, reason: 'missing X-Burnt-Signature/Timestamp/Delivery-Id header' };
  if (Number.isNaN(Date.parse(ts))) return { ok: false, reason: 'unparseable X-Burnt-Timestamp' };
  if (Math.abs(Date.now() - Date.parse(ts)) > 5 * 60 * 1000) return { ok: false, reason: 'timestamp older than 5 min' };
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${id}.${rawBody}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, reason: ok ? 'verified' : 'signature mismatch — does BURNT_WEBHOOK_SECRET match the dashboard secret?' };
}

// Record EVERY inbound delivery (verified or not) so the UI panel is a real debugging tool.
function recordWebhook(outcome, deliveryId, event) {
  recentWebhooks.unshift({
    received_at: new Date().toISOString(),
    outcome,
    event_type: event?.event ?? null,
    delivery_id: deliveryId,
    event,
  });
  if (recentWebhooks.length > 50) recentWebhooks.length = 50;
  console.log(`[webhook] ${outcome} — event "${event?.event ?? 'unknown'}" (delivery ${deliveryId ?? '—'})`);
}

// DEMO: verifies then processes inline. In production, verify → enqueue → return 200 quickly and process
// the event asynchronously, so a slow handler can't cause Burnt to time out and retry.
function handleWebhook(req, res) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
  const deliveryId = req.get('x-burnt-delivery-id') || null;
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    event = { raw: rawBody };
  }

  if (!BURNT_WEBHOOK_SECRET) {
    recordWebhook('received (BURNT_WEBHOOK_SECRET not set — not verified)', deliveryId, event);
    return res.status(202).json({ ok: false, reason: 'webhook secret not configured' });
  }

  const { ok, reason } = checkWebhookSignature(
    {
      'x-burnt-signature': req.get('x-burnt-signature'),
      'x-burnt-timestamp': req.get('x-burnt-timestamp'),
      'x-burnt-delivery-id': deliveryId,
    },
    rawBody,
    BURNT_WEBHOOK_SECRET,
  );
  if (!ok) {
    recordWebhook(`rejected: ${reason}`, deliveryId, event);
    return res.status(400).json({ ok: false, reason });
  }

  // Dedupe on delivery id (Burnt may retry).
  if (deliveryId && seenDeliveries.has(deliveryId)) {
    recordWebhook('duplicate (deduped)', deliveryId, event);
    return res.status(200).json({ ok: true, deduped: true });
  }
  if (deliveryId) seenDeliveries.add(deliveryId);

  recordWebhook('verified', deliveryId, event);
  res.status(200).json({ ok: true });
}

// ── Start ─────────────────────────────────────────────────────────────────────
const maskedKey = BURNT_API_KEY ? `${BURNT_API_KEY.slice(0, 12)}…(${BURNT_API_KEY.length} chars)` : '(none)';
app.listen(PORT, () => {
  console.log(`\nBurnt Partner API harness → http://localhost:${PORT}`);
  console.log(`  proxying to  : ${BURNT_BASE_URL}/api/v1`);
  console.log(`  API key      : ${maskedKey} (server-side only)`);
  console.log(`  webhook check: ${BURNT_WEBHOOK_SECRET ? 'enabled' : 'disabled (BURNT_WEBHOOK_SECRET unset)'}\n`);
});
