# Online Pickup SMS — Plan

Workstream: customer text messages for online pickup orders.
Separate from the Clover Mini / Flex workstream in `plan.md` / `task.md` in this folder.
Checklist: `online-pickup-sms-task.md`.

**Current slice: 3 done locally (not pushed); slices 2 and 3 both local only.** Slice 1 SQL is applied on local Docker only; Render still needs `database/online_order_sms.sql` and `Schema OK` before any of this is pushed. **Do not set `ONLINE_SMS_ENABLED=true` on Render yet.**

---

## A. Goal

Online ordering already works end to end:

1. narcostacos.ca `/order` (behind the shop code, `ORDER_ENABLED=false`) takes payment in the Clover ecommerce iframe.
2. A Netlify function POSTs the paid ticket to POS `POST /api/online-orders`.
3. POS inserts it as `orders.source = 'online'`, pickup; the kitchen sees it on the KDS.

This plan adds **customer SMS** on top of that backend. POS is the system of record, and all texts are sent from the POS API (Render). Three texts, online tickets only:

| # | Event    | Trigger                                                                 |
|---|----------|-------------------------------------------------------------------------|
| 1 | placed   | New ingest INSERT in `POST /api/online-orders` (not an idempotent replay) |
| 2 | started  | KDS tap `open → preparing` (`PATCH /api/orders/:id/status`)             |
| 3 | ready    | KDS tap `preparing → ready` — ready is the pass; do not wait for any later status |

Email is optional and later. Twilio is the intended provider.

---

## B. Locked product rules

- `ORDER_ENABLED` stays `false`. Do not merge `ui/menu-refresh`. Do not merge website `slice1-clover-checkout` to `main`.
- Pickup only, Lawrence location, 2072 Lawrence Ave E. Pay online in the iframe. Not pay-on-arrival. Not delivery.
- Do not mix `CLOVER_ECOMM_*` with `CLOVER_APP_*` / `CLOVER_RAID` / `CLOVER_DEVICE_ID`.
- Do not change `PAYMENTS_PROVIDER`.
- Send only when `orders.source = 'online'` and a usable `customer_phone` exists.
- Missing Twilio env or `ONLINE_SMS_ENABLED=false` → log and skip; never 500 ingest or a KDS tap.
- Ingest retry and a unique `(order_id, event)` must prevent double texts.
- The revert route does not send SMS. Revert-then-ready does not send ready again.
- Never commit secrets. Env names only: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ONLINE_SMS_ENABLED`.
  `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` are shared with the Back Office SMS 2FA plan (root `task.md`, Twilio Verify). This workstream adds only `TWILIO_FROM_NUMBER` and `ONLINE_SMS_ENABLED`.
- Catering EmailJS on the website stays untouched.
- Texts are never sent from the browser and never from Flex / Cloud Pay Display.

---

## C. How status moves

Order status on the KDS: `open → preparing → ready`.

- **Placed** = the INSERT inside `POST /api/online-orders` (`backend/server.js`, ~L2759). The route first checks idempotency (`clover_ecomm_charge_id` or `online_order_ref` already present). If found it returns `200 { idempotent: true }` — **that path must not text**. Only the `201` path after `COMMIT` is a new placed event. A `23505` race returns 409 and also must not text.
- **Started / ready** = `PATCH /api/orders/:id/status` with body `{ status: "preparing" | "ready" }` (~L3301). Forward only, one step at a time, row locked `FOR UPDATE`. `ready` also stamps `completed_at` — ready is the terminal "pass" state for this purpose.
- **Revert** is a separate route: `PATCH /api/orders/:id/status/revert` (~L3369). It steps back one state (clearing `completed_at` when leaving ready). It never sends SMS. If the kitchen reverts `ready → preparing` and taps ready again, the unique `(order_id, 'ready')` row already exists, so no second text.

---

## D. Where phone lives

- `orders.customer_phone` — written by ingest from the website payload `customer.phone`. Currently free text from the checkout form; no normalization guaranteed.
- The KDS order payload (`fetchKdsOrders`) carries the customer **name**, not the phone. The PATCH route does not need the phone in its response; the SMS helper reads it from `orders` by id.
- Order recall / lookup (~L4728 / ~L4849) already selects and returns `customer_phone`.
- Slice 1 adds a phone normalizer (target E.164, `+1` NANP for Canadian numbers). A number that does not normalize is "not usable" → log and skip.
- Slice 4 tightens website-side validation and consent copy so most numbers arrive usable.

---

## E. Architecture

```
POST /api/online-orders ──COMMIT (201 new insert)──▶ notifyOnlineOrder(orderId, 'placed')
PATCH /api/orders/:id/status ──COMMIT (preparing)──▶ notifyOnlineOrder(orderId, 'started')
PATCH /api/orders/:id/status ──COMMIT (ready)──────▶ notifyOnlineOrder(orderId, 'ready')
PATCH .../status/revert ─────────────────────────── (no call)
```

- **POS helper, after COMMIT.** One helper (e.g. `notifyOnlineOrder`) called only after the route's transaction commits, fire-and-forget from the route's point of view. It never throws into the route; any failure is caught and logged. The HTTP response to ingest / the KDS does not depend on Twilio.
- **Gate checks inside the helper, in order:**
  1. `ONLINE_SMS_ENABLED` is exactly `true` — otherwise log `skip:disabled`.
  2. All three Twilio env vars present — otherwise log `skip:not_configured`.
  3. Order row has `source = 'online'` — otherwise return silently (in-store orders are the common case).
  4. `customer_phone` normalizes — otherwise log `skip:no_phone`.
  5. Claim the event: `INSERT INTO order_notifications (order_id, event, …) ON CONFLICT (order_id, event) DO NOTHING`. Zero rows inserted → already sent/claimed → skip.
  6. Send via Twilio REST; update the row with `status` (`sent` / `failed`), provider message SID, error text.
- **As built (slice 2):** `backend/lib/onlineSms.js` → `notifyOnlineOrderPlaced(pool, …)`, called un-awaited right after the ingest COMMIT on the 201 path. Flag not exactly `"true"` → no row. Invalid phone → `skipped` / `invalid_phone`. Flag on but Twilio env missing → `skipped` / `twilio_not_configured`. Claim uses `ON CONFLICT (order_id, event) DO NOTHING`; no row returned → no send. Twilio via `fetch` (no SDK), 8 s timeout; errors stored as short codes (`twilio_http_400_code_21211`, `twilio_timeout`, `twilio_network_error`), never the token or Twilio's message text.
- **As built (slice 3):** the same helper, generalized to `notifyOnlineOrder(pool, event, …)` (`notifyOnlineOrderPlaced` is a thin wrapper). `PATCH /api/orders/:id/status` now reads `status, source, customer_phone, order_number` on the `FOR UPDATE` row and, after COMMIT, calls it un-awaited with `started` (→ preparing) or `ready` (→ ready) only when `source = 'online'`. `/status/revert` has no call. Skip logs print only when a row was actually claimed, so a repeat after revert is silent.
- **Table `order_notifications`** (slice 1, `database/online_order_sms.sql`): `id`, `order_id` FK `ON DELETE CASCADE`, `event` (`placed` | `started` | `ready`), `to_phone` (normalized, nullable), `status` (`queued` | `sent` | `failed` | `skipped`), `provider_sid`, `error`, `created_at`. `UNIQUE (order_id, event)`. SMS is the only channel, so there is no `channel` column.
- **Phone normalizer** (slice 1): `normalizePhone()` in `backend/lib/phone.js` returns `+1XXXXXXXXXX` or null; tests in `tests/phone_normalize_acceptance.mjs`. Not called from any route yet. The unique claim is the double-text guarantee across ingest retries, KDS double taps, and revert-then-advance.
- **Dark flag.** `ONLINE_SMS_ENABLED` defaults to off. Code can ship to Render dark; texting starts only when the flag is flipped.
- **Failure policy.** A failed send leaves a `failed` row; no automatic retry in v1 (a retry could arrive after the customer has already picked up). Locked.
- **Logging.** Never log the full phone or message body with secrets; log order number, event, outcome, last 4 digits at most.

---

## F. Draft SMS copy

Short, single segment where possible, no links in v1.

- **placed (shipped in `SMS_COPY`):** `Narcos Tacos: order #{order_number} received. Pickup at 2072 Lawrence Ave E.`
- **started (shipped):** `Narcos Tacos: we started order #{order_number}.`
- **ready (shipped):** `Narcos Tacos: order #{order_number} is ready for pickup at 2072 Lawrence Ave E.`

Opt-out wording (`Reply STOP to opt out`) depends on Twilio / Canadian carrier requirements — see open questions.

---

## G. Slice guide

Matches `online-pickup-sms-task.md`.

- **Start — Docs only.** This plan and the checklist. No code.
- **0 — Read-only scan.** Confirm the line refs above, how `customer_phone` values look in production today, whether any existing notification table / Twilio code exists, and the migration + `schema-requirements.json` conventions. No edits.
- **1 — Schema + phone normalize.** SQL file for `order_notifications` with `UNIQUE (order_id, event)`; add to schema guard requirements; pure phone-normalize function with unit tests. No sending.
- **2 — Placed SMS on new ingest.** Helper + Twilio client behind the flag; call only on the 201 new-insert path after COMMIT. Tests: idempotent replay sends nothing; missing env / flag off still returns 201; unique claim blocks a second send.
- **3 — Started + ready on KDS PATCH.** Call after COMMIT for `preparing` and `ready`. Tests: in-store order sends nothing; revert route sends nothing; revert-then-ready does not resend; Twilio failure never 500s the tap.
- **4 — Website phone validation / copy.** In narcos-web (separate turn and branch rules): require a valid phone at checkout, add "we'll text you updates" copy. No change to `ORDER_ENABLED`.
- **5 — Render SQL + Twilio env + one test phone.** Apply the migration on Render, set the four env vars in the Render dashboard (never in git), flip `ONLINE_SMS_ENABLED=true`, run one shop-code order to a single staff test phone and watch all three texts.

---

## H. Out of scope

- Email notifications (optional, later).
- Catering EmailJS changes.
- SMS from the browser, Netlify, or Flex / Cloud Pay Display.
- Delivery, pay-on-arrival, other locations.
- Texts for in-store orders.
- Inbound SMS / two-way chat, marketing texts.
- Automatic retry of failed sends.
- Turning on `ORDER_ENABLED`, merging `ui/menu-refresh` or `slice1-clover-checkout`.
- Any change to Clover ecommerce, Clover app/device config, or `PAYMENTS_PROVIDER`.

---

## I. Open questions

1. Twilio number type for Canada: local long code vs toll-free, and registration requirements / lead time.
2. ~~Consent checkbox / Reply STOP?~~ Decided: CASL consent checkbox and Reply STOP wording are Slice 4, not schema.
3. Should the helper run inline after COMMIT (awaited but caught) or be deferred (`setImmediate`) so the response is never delayed by Twilio latency?
4. Should voided / refunded online orders ever send a "cancelled" text? (Not in v1.)
5. What does production `customer_phone` data look like today — formats, blanks?
6. ~~Retry policy for `failed` sends?~~ Decided: none in early slices; log `failed`.
7. Should a staff UI show notification status per order, or are logs + the table enough for v1?
