# Stripe Terminal — Implementation Plan

Companion plan for real **card-present payments** via Stripe Terminal, written
for review before implementation, in the same spirit as `refunds-plan.md`,
`reports-plan.md` and `payroll-plan.md`. No code yet.

**Status**: Slices 0–8 implemented and verified on the simulated reader. Slice 9
is readiness-only — no physical hardware, `PAYMENTS_PROVIDER=mock` in
production. The operational runbook is `stripe-go-live.md`.
**Last updated**: 2026-08-06
**Target**: production-grade card payments matching Square/Clover in
reliability, security and cashier experience.

## Why this exists (and why now)
Payments are **mocked** today: `POST /api/orders` records the cashier's
Cash/Card choice and writes a `captured` payments row with no processor behind
it. Every other money surface — Reports, Refunds & Voids, Payroll — is already
built and reconciling; the processor is the last missing piece.

The Refunds & Voids work was deliberately built Stripe-shaped
(`payments.processor_txn_id`, `order_refunds.stripe_refund_id` /
`processor_status`, negative payments rows, one settled-payments predicate), and
`refunds-plan.md:205-213` sketched the webhook transition this plan now
implements. This plan is the single source of truth for that work. Any
deviation should be discussed and reflected here before coding.

## Goals
- Replace the mock Card path with real Stripe Terminal card-present payments.
- Support **on-reader tipping** (15 / 18 / 20 %).
- Keep the **Cash** path working, unchanged, and independent.
- Support **real card refunds** through the existing dual-control flow.
- Prepare the data path for **receipts** (print, later email).
- Stay **multi-location-ready** while launching one store.
- Preserve every existing money invariant and report reconciliation.

### Non-goals (this phase)
- Offline payments
- Tap to Pay on phone
- Running Order Entry on the reader itself (possible later with T600)
- Multi-location live at launch
- Split tender / partial payments (checkout still writes exactly one capture)
- Disputes and chargebacks (`refunds-plan.md` already sketches the extension)

---

## Decisions locked

Settled during review. These are not open for re-litigation during
implementation; changing one means changing this document first.

### D1 — Order lifecycle: hold the cart, not the order (Option B)
The priced, validated cart is held **server-side** in a new `pending_checkouts`
row. The real `orders` + `payments` rows are inserted **only** when the success
webhook arrives.

- The order is never visible to the KDS, pos-recall, Transaction Log or any
  report until payment has actually succeeded.
- Declined, cancelled and abandoned checkouts create **no order row**.
- No new `order_status` value is needed, so no existing status-filtered query
  changes. This is the main reason Option B was chosen over an
  `awaiting_payment` order state.
- Consequence accepted: money can be captured with no order row (see D8).

### D2 — The snapshot is authoritative; never re-price at insert time
Checkout prices and validates the cart **once**, when the PaymentIntent is
created. The webhook inserts that frozen snapshot verbatim.

Re-pricing at insert time would be wrong: a price edit in Manage Menu while a
payment is in flight would produce an order whose total differs from what
Stripe actually charged. The snapshot is what the customer paid for.

### D3 — Tip refund policy
- **Full refund** (and **void**) → returns the tip.
- **Partial** and **line-item** refunds → return **no** portion of the tip.
- The `$100` owner-approval threshold is measured on the **actual amount being
  refunded** (tip-inclusive on a full refund). No code change — the existing
  check already reads `refundAmount`.

Define once, server-side:
```
refundableBase = round2(orders.total − orders.tip)   // = subtotal − discount + tax
```
All partial/line-item math uses `refundableBase`; full refund and void use
`orders.total`.

### D4 — "Full remaining" disambiguation
`POST .../refund` with neither `items` nor `amount` is ambiguous once tips
exist. The rule:

- `alreadyRefunded === 0` → **full refund**. Returns `orders.total`, tip
  included, tax = `orders.tax`.
- `alreadyRefunded > 0` → **top-up partial**. Capped at
  `refundableBase − alreadyRefunded`, tax = `orders.tax − alreadyRefundedTax`,
  **no tip**.

Accepted consequence: once any partial refund exists, the tip becomes
permanently unrefundable — the full-refund path is gone and partials cap below
it. This is intended (staff keeps the tip), but it means a fully-reversed-by-
partials order leaves a small residual against the Stripe charge. Documented so
it is never rediscovered as a bug.

### D5 — Interac refunds are blocked from Back Office
`interac_present` refunds require the physical card at the reader. Therefore:

- The Back Office Transaction Log refund path **rejects** an Interac-funded
  order with a clear, specific error telling staff the customer must return to
  the counter with the card.
- Staff may instead choose an explicit **cash refund** path: the reversal is
  recorded normally in `order_refunds`, but the negative `payments` row is
  written with `method='cash'` and no Stripe call is made.
- A pending Interac refund the customer never returns to complete is left for
  **manual owner/admin cancellation**. No auto-expire in v1.

Credit `card_present` refunds are unaffected and can be issued remotely.

### D6 — Prefer TEXT + CHECK over new enum values
The schema guard explicitly does **not** check enum values
(`schema-guard.md`), so a missing `ALTER TYPE` ships with no backstop — exactly
the `is_upsell` failure class, third time. This plan therefore adds **zero** new
enum values. Interac vs. credit is recorded in a new TEXT + CHECK column, not a
new `payment_method` member.

### D7 — Failed attempts never create permanent `payments` rows
A decline, cancellation or timeout updates the `pending_checkouts` row only. The
`payments` table gets exactly one capture row per order, as today. This keeps
pos-recall's `LEFT JOIN payments` single-valued and keeps `applyRefund`'s method
lookup correct.

### D8 — Orphaned payments are a first-class recovery case
Option B's one genuine cost. If money is captured but the order insert fails
(FK violation, DB blip, crash between webhook and commit), the reconciliation
job must find it — "PaymentIntent succeeded, no order row" — mark the pending
checkout `orphaned`, and alert loudly. This is a required slice, not a
nice-to-have.

### D9 — Idempotency at two levels
- **Outbound**: every Stripe call (`PaymentIntent.create`,
  `process_payment_intent`, `Refund.create`) sends an `Idempotency-Key` derived
  from the pending-checkout or refund id. A timeout-plus-retry must never double
  charge.
- **Inbound**: `stripe_events` gives durable event dedup, **and** a partial
  UNIQUE index on `payments.processor_txn_id` gives a DB-level guarantee.
  Event-table dedup alone races when two deliveries arrive concurrently; the
  unique index is what actually makes double-insert impossible.

### D10 — Kill-switch
`PAYMENTS_PROVIDER=mock|stripe`. In `mock`, the Card button uses today's
synchronous path exactly as it does now. A dead terminal on a Friday night must
be recoverable without a deploy.

### D11 — Cash keeps the synchronous path
`POST /api/orders` becomes two behaviours: **cash** inserts immediately as it
does today; **card** creates a pending checkout. `PAYMENTS_PROVIDER=mock` sends
card down the synchronous path too. These are deliberately not unified.

### D12 — Pinned Stripe API version
The SDK client pins `apiVersion` explicitly. Terminal endpoints are
version-sensitive and must not drift under us on a redeploy.

---

## Architecture

Server-driven integration — Stripe's recommended path for smart readers.

```
[Order Entry tablet] → [Express backend] → [Stripe API] → [Smart reader]
                              ↑                                  ↓
                          Webhooks  ←──────────  customer pays / tips
```

- The backend is the only component that talks to Stripe.
- The frontend only shows status and triggers actions.
- **Webhooks are the primary source of truth.** The synchronous API response is
  a hint, never the settlement record.
- **Reconciliation is the safety net**, not the mechanism.

Works with BBPOS WisePOS E, Stripe Reader S700 / S710, and Stripe Reader T600.
It does **not** work with pure Bluetooth readers (M2, WisePad 3) — we are
deliberately staying on the smart-reader / server-driven path.

### Hardware

| Role | Device | Notes |
|---|---|---|
| Staff Order Entry | Any modern 10–11" Android tablet or iPad | Runs the existing React app. Galaxy Tab Active for durability. |
| Customer payment (preferred) | Stripe Reader T600 (8") | The tablet-like experience wanted long-term. Availability unconfirmed for Canadian accounts. |
| Customer payment (available now) | Stripe Reader S700 / BBPOS WisePOS E | Fully supported today. |
| Development | Simulated reader | No hardware required. Use this first. |

**Rule: do not block coding on physical hardware.** Build against the simulated
reader and test keys. Swapping to a physical device changes a reader id and
nothing else.

### Stripe account setup
1. Canadian Stripe account.
2. A **Location** for the Scarborough store (real Canadian address).
3. Test keys, later live keys, as Render environment variables.
4. Webhook endpoints registered for test and live.
5. A **Terminal Configuration** for on-reader tipping (15 / 18 / 20 %).
6. Reader registration (simulated first, physical later).

```
STRIPE_SECRET_KEY=sk_test_…      # or sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_API_VERSION=…             # pinned, see D12
PAYMENTS_PROVIDER=mock|stripe    # kill-switch, see D10
```

Secret keys never touch the frontend or git. `STRIPE_LOCATION_ID` is
**not** an env var — it lives on `locations.stripe_location_id` (see D-multi
below), with an env fallback only for first bootstrap.

---

## Schema

Every column is additive and nullable. **No new enum values** (D6). One
migration file, `database/stripe_terminal.sql`, following the Schema Change
Checklist in `CLAUDE.md` in full.

### New table: `pending_checkouts`
The priced cart held between PaymentIntent creation and webhook settlement.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `location_id` | UUID NOT NULL → `locations(id)` | |
| `staff_id` | UUID NOT NULL → `staff(id)` | the ringing cashier |
| `device_id` | TEXT | from the device-pairing cookie, for reader binding |
| `payload` | JSONB NOT NULL | the fully-priced snapshot (D2): lines, variants, modifiers, addons, unit prices |
| `subtotal`, `discount`, `tax`, `total` | NUMERIC(10,2) NOT NULL | frozen at creation |
| `discount_percent` | NUMERIC(5,2) | |
| `discount_reason` | TEXT | same CHECK set as `orders` |
| `stripe_payment_intent_id` | TEXT | UNIQUE |
| `stripe_reader_id` | TEXT | which reader was asked |
| `status` | TEXT NOT NULL DEFAULT `'awaiting_payment'` | CHECK in `awaiting_payment`, `succeeded`, `failed`, `cancelled`, `expired`, `orphaned` |
| `order_id` | UUID → `orders(id)` | set exactly once, on success |
| `error_message` | TEXT | last decline / failure reason |
| `created_at`, `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

### New table: `stripe_events`
Durable webhook dedup and audit (D9).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Stripe event id (`evt_…`) — the dedup key |
| `type` | TEXT NOT NULL | |
| `api_version` | TEXT | |
| `payload` | JSONB NOT NULL | full event, for replay and audit |
| `received_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `processed_at` | TIMESTAMPTZ | NULL = received but not yet handled |
| `process_error` | TEXT | |

### Added columns

| Table | Column | Notes |
|---|---|---|
| `payments` | `processor_payment_type` TEXT | CHECK in `card_present`, `interac_present`, `other`. **Drives the D5 Interac block.** |
| `payments` | `card_brand` TEXT | receipts |
| `payments` | `card_last4` TEXT | receipts |
| `device_pairings` | `stripe_reader_id` TEXT | binds a paired tablet to its reader |
| `locations` | `stripe_location_id` TEXT | multi-location readiness |

`payments.processor_txn_id` already exists and needs no migration — it takes the
PaymentIntent id. **No `payments.tip_amount`**: `orders.tip` is the single
source and every report already reads it; a second copy would be a second thing
to keep reconciled.

### Indexes / constraints
```sql
CREATE UNIQUE INDEX ... ON payments(processor_txn_id) WHERE processor_txn_id IS NOT NULL;  -- D9
CREATE UNIQUE INDEX ... ON pending_checkouts(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX ... ON pending_checkouts(status, created_at);   -- reconciliation sweep
CREATE INDEX ... ON stripe_events(type, received_at);
CREATE INDEX ... ON order_refunds(stripe_refund_id);
```

**Schema-guard note**: the guard covers tables and added columns, so everything
above is protected — but it does **not** cover the indexes or CHECK constraints
(`schema-guard.md`). The partial UNIQUE index on `processor_txn_id` is a
correctness guarantee the guard will not verify; confirm it manually against
production in step 4 of the checklist.

---

## Payment flow (happy path)

1. Cashier hits Pay → Card. Frontend posts the cart as today.
2. Backend prices and validates the cart with the **existing** logic, writes a
   `pending_checkouts` row with the frozen snapshot (D2). **No order row yet.**
3. Backend creates a PaymentIntent — amount in cents CAD,
   `payment_method_types: ['card_present', 'interac_present']`, automatic
   capture, `Idempotency-Key` = pending-checkout id (D9). PI id stored on the
   pending row.
4. Backend calls `process_payment_intent` on the bound reader.
5. Frontend shows "Waiting for customer on reader…", with **Cancel** available.
6. Reader shows amount + tip options → customer tips, taps/inserts, PINs.
7. Stripe fires webhooks. Backend verifies the signature against the **raw
   body**, records the event in `stripe_events`, and returns `2xx` immediately.
8. Handler, in **one transaction** with `SELECT … FOR UPDATE` on the pending row:
   - asserts the amount Stripe charged matches snapshot total + tip,
   - inserts `orders` (with `tip` set and `total` = tip-inclusive — see the
     invariant below),
   - inserts `order_items` / modifiers / addons from the snapshot,
   - inserts one `payments` row: `captured`, `processor_txn_id` = PI id,
     `processor_payment_type`, `card_brand`, `card_last4`,
   - sets `pending_checkouts.status='succeeded'` and `order_id`.
9. Order appears on the KDS at `status='open'`, exactly as a cash order does.

Cash is untouched (D11).

### The money invariant (non-negotiable)
Every report rests on:
```
SUM(orders.total) [status='ready'] − SUM(refunds) == SUM(settled payments)
```
and on `orders.total = subtotal − discount + tax + tip`. On-reader tipping means
Stripe charges **more** than the snapshot total. Therefore the webhook must
write `orders.tip` and a **tip-inclusive** `orders.total`, and the `payments`
row amount must equal `orders.total` exactly. Assert it in code at insert time;
a mismatch is a hard failure, not a warning. Without this, Sales Summary
silently stops balancing on day one.

### Failure, cancel and busy paths
- **Decline** → `pending_checkouts.status='failed'` + `error_message`. No order,
  no payments row (D7). Cashier can retry, which creates a **new**
  PaymentIntent against the **same** pending checkout.
- **Cashier cancels** → `cancel_action` on the reader, pending row
  `cancelled`.
- **Customer walks away** → same as cancel; the reconciliation sweep expires
  stale `awaiting_payment` rows.
- **Reader busy** ("action already in progress") → surface a specific,
  actionable message; offer cancel-and-retry. This is a daily occurrence at a
  counter, not an edge case.
- **Reader offline / unreachable** → clear error plus the fallback instruction
  (take cash, or flip `PAYMENTS_PROVIDER`).

### Webhook handling requirements
Required events: `terminal.reader.action_succeeded`,
`terminal.reader.action_failed`, `payment_intent.succeeded`,
`payment_intent.payment_failed`, `charge.refunded`, `refund.updated` /
`refund.failed`.

- Verify `Stripe-Signature` on every request using the **raw body**.
- Mount `express.raw({ type: 'application/json' })` on the webhook route
  **before** the global `express.json()` (`server.js:139`), or capture
  `rawBody` via the `verify` option. This ordering is easy to get wrong here
  because `express.json()` is global.
- The route is **exempt from `requireDevicePairing`** — every other
  `/api/orders*` route has it, and Stripe has no device cookie. CORS does not
  apply (server-to-server).
- Dedup on `stripe_events.id`; the partial UNIQUE index on
  `payments.processor_txn_id` is the real guarantee (D9).
- Respond `2xx` fast; log every event.

### Reconciliation sweep (the safety net)
A background job / on-demand endpoint that:
- finds `awaiting_payment` rows older than N minutes and asks Stripe for the
  real PaymentIntent status;
- materializes the order if the webhook was missed;
- marks genuinely abandoned rows `expired`;
- flags **"PI succeeded, no order row"** as `orphaned` and alerts loudly (D8);
- reports counts so a silent webhook outage becomes visible.

---

## Tipping

- On-reader tipping via a Terminal Configuration object; 15 / 18 / 20 %, custom
  and no-tip available.
- Configured once in Stripe and attached to the Location. Readers pick it up on
  refresh (may take a few minutes).
- The final charged amount is what we store, per the invariant above.
- Tips already flow into Sales Summary (`SUM(orders.tip)`) and Transaction Log.
  Once tips are non-zero, **verify both reports against a real charge** — they
  have only ever been exercised with `tip = 0`.

---

## Refunds

The existing dual-control flow is unchanged: cashier initiates, manager+
approves by PIN inline, reversals ≥ `$100` need owner/admin, every reversal
writes an `order_refunds` audit row plus a negative `payments` row.

Two pieces of work sit on top.

### R1 — Tip-aware refund math (local, no Stripe dependency)
This must land **before** Stripe refunds are wired, and is independently
testable. `applyRefund` currently launders tip through two ratios that both
assume `tip = 0`:

- **Tax proration is an outright bug once tips exist.** `orderTax / orderTotal`
  under-states the tax portion of a partial refund (on a $113 order with a $10
  tip, refunding half records $5.97 of tax instead of $6.50). That flows
  straight into Sales Summary's `taxCollected = tax − refundTax` and
  **overstates HST remitted to CRA.** The denominator must become
  `refundableBase`.
- **Line allocation ratio** must become `refundableBase / orderSubtotal`, or
  every line-item refund silently returns a slice of the tip (D3). The
  documented invariant changes with it: refunding every line returns exactly
  `orders.total − tip`, not `orders.total`.
- **The `remaining` cap splits in two**: void and full refund cap at
  `orders.total`; partial and line-item cap at
  `refundableBase − alreadyRefunded`. One variable can no longer serve both.
- **"Full remaining"** follows D4.
- **Threshold** needs no change — it already reads `refundAmount`.
- **Void** needs no change — it returns `orders.total` + `orders.tax`, already
  consistent with "full returns tip".

### R2 — Stripe refunds
- On approval, call `Refund.create` against the original PaymentIntent with an
  `Idempotency-Key` (D9). Store `stripe_refund_id`.
- Implement the state machine `refunds-plan.md:205-213` already specified and
  the code currently short-circuits: create at
  `order_refunds.status='pending'` with the negative `payments` row at
  `status='pending'`, and let the webhook flip to `completed`/`refunded` or
  `failed`, recording `processor_status`. Today both are hardcoded to the
  settled values — meaning a **failed** Stripe refund would already be counted
  as money returned. `settledPaymentsWhere()` already excludes `pending`, so an
  in-flight refund never corrupts a total.
- **Interac** follows D5: blocked from Back Office with a specific error,
  terminal-present at the POS, or an explicit cash-out. The cash-out path needs
  `applyRefund` to accept an explicit refund method rather than always
  mirroring the original capture — no schema change, `payments.method` already
  exists.
- Cash refunds remain internal, no Stripe call.

---

## Receipts

Prepare the data path only; do not block core payments on printer hardware.
After a successful payment everything a receipt needs is available: order,
lines, tax, tip, `card_brand`, `card_last4`, PI id.

**Shipped in Slice 8** — the decision was "both", with no hardware dependency
either way:

- `GET /api/orders/:id/receipt` (device-paired) is the single read-only
  projection every receipt renders from — business details, lines with their
  modifier/removal/add-on detail, totals, the payment row's card fields, and any
  reversals. It prices nothing and writes nothing, so a reprint an hour later is
  identical to the original.
- **Print** is the browser's own print dialog over an 80mm layout
  (`ReceiptModal.jsx`), so any receipt printer the tablet's OS already sees just
  works — no driver, no printer config, and no reason to wait for hardware.
- **Email** is `POST /api/orders/:id/receipt/email`, which sets `receipt_email`
  on the Stripe charge and lets Stripe send its own receipt. Deliberately not
  our own template: Stripe already renders the card brand and last4 from the
  charge itself. Cash sales, and anything taken while `PAYMENTS_PROVIDER=mock`,
  have no charge to attach an address to and are print-only — the endpoint says
  so specifically rather than failing vaguely.
- Reachable from the checkout confirmation (which stops its own 2-second
  self-dismiss when a receipt is asked for) and from Order Recall, which is the
  reprint surface for any past order.

**Money display rule**: `order_items.unit_price` already includes modifier
deltas and paid add-ons, so `SUM(unit_price × quantity)` *is* `orders.subtotal`.
Modifiers therefore print as descriptive sub-lines with no money beside them —
printing a per-modifier price next to a line total that already contains it is
how a receipt stops adding up in the customer's hands.

**Outstanding**: the HST registration number has no home in the schema. A
Canadian receipt should carry it so a customer can claim an input tax credit;
`locations.hst_number` is the right place and needs a migration. Until then it
comes from the optional `BUSINESS_TAX_NUMBER` env var and the line is omitted
when unset.

---

## Multi-location readiness

Stripe objects that are location-scoped (Location, Configuration, Readers) are
looked up through `locations.stripe_location_id` and
`device_pairings.stripe_reader_id`, never hard-coded. Adding a second store
should require a new Stripe Location, its readers, and a `locations` row —
configuration, not code.

**Stripe readers are a separate trust layer from `device_pairings`.** Readers
are registered to a Stripe Location by Stripe; `device_pairings` is our own
device-trust layer for tablets (`device-pairing.md`). `stripe_reader_id` binds
them without merging them. Do not try to unify the two.

---

## How this touches what's already built

The exact call sites this work modifies. Line numbers are from the state of the
repo when this plan was written and will drift.

| Call site | What changes |
|---|---|
| `POST /api/orders` — `server.js:460` | Splits by method (D11). Cash and `PAYMENTS_PROVIDER=mock` keep today's synchronous insert. Card prices the cart with the same logic, then writes `pending_checkouts` and returns a pending handle instead of an order. |
| Order insert + `tip = 0` — `server.js:728-784` | The card path's insert moves into the webhook handler, with `tip` and a tip-inclusive `total` from Stripe, and one `payments` row carrying the Stripe fields. |
| `applyRefund` — `server.js:1295-1560` | Tip-aware rework per R1, plus the pending/failed state machine and an explicit refund method for the Interac cash-out. |
| `remaining` cap — `server.js:1355` | Splits into full (`orders.total`) and partial (`refundableBase`) caps. |
| Line allocation ratio — `server.js:1418` | `orderTotal / orderSubtotal` → `refundableBase / orderSubtotal`. Update the explanatory comment at `server.js:1370-1375` with it. |
| Tax proration — `server.js:1457`, `server.js:1468` | `orderTax / orderTotal` → `orderTax / refundableBase`. **The CRA-facing fix.** |
| Refund threshold — `server.js:1485` | No change; already reads `refundAmount` (D3). |
| `POST /api/backoffice/orders/:id/refund` — `server.js:1799` | Rejects Interac-funded orders with a specific error; offers the cash-out path (D5). |
| pos-recall payments join — `server.js:1644` | No change **provided D7 holds**. If failed attempts ever write payments rows, this `LEFT JOIN` goes multi-valued and duplicates orders in the recall list. |
| Modifier-option delete guard — `server.js:2872-2894` | Extend the smart-deletion check to also protect in-flight pending checkouts. Audit the modifier-group and item-modifier-group delete paths for the same window. |
| `settledPaymentsWhere()` — `server.js:4360` | No change. `pending` is already excluded, which is exactly what an in-flight refund needs. |
| Sales Summary — `server.js:4376` | No query change; **verify** tips and refund tax against a real tipped charge. |
| Transaction Log — `server.js:4527` | No change. Under D1 there are no phantom `cancelled` rows to filter out. |
| KDS list / history — `server.js:1006`, `server.js:1070` | No change. Orders still appear at `status='open'`, just a few seconds later. |
| `express.json()` — `server.js:139` | The webhook route mounts raw-body parsing **before** this. |
| `backend/package.json` | Add `stripe` with a pinned `apiVersion` (D12). |

### The one new hazard Option B introduces
`server.js:2872-2894` hard-deletes a modifier option when
`order_item_modifiers` has zero references. Under D1, a cart that is mid-payment
has **no `order_items` yet**, so a referenced option looks unreferenced. Owner
edits the menu during service → option hard-deleted → the deferred insert fails
on a foreign key **after the customer has been charged**. The guard extension
above closes it; D8's orphan recovery catches anything that still slips through.

Lower-severity relatives of the same window: a cashier hard-deleted mid-flight
(staff with no history can be hard-deleted), and a menu item deactivated
mid-flight (harmless — the snapshot is authoritative per D2, and menu items and
variants have no DELETE route at all).

---

## Implementation slices

Each slice leaves the system working and is independently reviewable.

### Slice 0 — Foundations and guardrails

The only slice that touches production before any feature code exists. It ships
the migration and the kill-switch, and nothing user-visible changes: with
`PAYMENTS_PROVIDER=mock` the POS behaves exactly as it does today. Do these in
order.

**0.1 — Stripe account and dashboard objects** (no code)
1. Confirm the Canadian Stripe account and enable Terminal.
2. Create a **Location** for Lawrence East with the real Canadian address.
   Record the `tml_…` id — it goes in `locations.stripe_location_id`, not an env
   var (D-multi).
3. Create a **Terminal Configuration** with tipping at 15 / 18 / 20 %, custom
   tip and no-tip enabled, and attach it to that Location. Tipping is not
   exercised until Slice 4, but creating it here means the reader has already
   picked it up by then.
4. Register a **simulated reader** against the Location.
5. Register the **test-mode webhook endpoint**. Note the `whsec_…` secret.
   Leave the live endpoint until Slice 9.

**0.2 — Migration, following the Schema Change Checklist in `CLAUDE.md` in
full, in order, no steps skipped**
1. Write `database/stripe_terminal.sql`: the two new tables, five added
   nullable columns, and the indexes from the Schema section above. Additive
   and idempotent throughout — `CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, `DO $$` guards on constraints, matching the
   style of `refunds.sql`. **No new enum values** (D6).
2. Apply locally and verify:
   `docker exec -i narcos_tacos_db psql -U narcos -d narcos_tacos < database/stripe_terminal.sql`
3. `cd backend && npm run schema:sync`, and commit the regenerated
   `backend/schema-requirements.json` **in the same commit as the `.sql`**.
   `npm run check:schema` fails if this is forgotten.
4. **Apply to production**:
   `psql "<Render External Database URL>" -f database/stripe_terminal.sql`
5. **Verify against production** — must print `Schema OK`:
   `cd backend && DATABASE_URL="<Render External Database URL>" npm run check:schema`
   Anything else means step 4 did not fully succeed. Exit 2 (cannot connect) is
   **not** a pass.
6. **Manually confirm the two partial UNIQUE indexes landed in production** —
   the guard covers tables and columns but not indexes or constraints
   (`schema-guard.md`), and the one on `payments(processor_txn_id)` is the
   double-charge guarantee:
   ```sql
   SELECT indexname FROM pg_indexes
    WHERE tablename IN ('payments','pending_checkouts')
      AND indexdef LIKE '%UNIQUE%';
   ```
7. Only now push the dependent code.

This slice is **not complete** until step 5 has actually reported `Schema OK`
against production. Local Docker is never production.

**0.3 — Backend wiring** (no behaviour change yet)
1. `npm i stripe` in `backend/`; construct the client once with an explicitly
   pinned `apiVersion` (D12). Never let it float.
2. Read and validate env at boot, in the same fail-fast style as
   `SESSION_SECRET` / `DEVICE_SECRET`: `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION`, `PAYMENTS_PROVIDER`.
   `PAYMENTS_PROVIDER` defaults to `mock`, so a missing or broken Stripe config
   can never silently take card payments down — it degrades to today's path.
   When it is `stripe`, the Stripe vars become **required** and a missing one
   throws at boot rather than at the first customer.
3. Set the same vars on Render (test keys for now). Note that these are backend
   vars, not `VITE_*` — no rebuild semantics apply.
4. Add an owner/admin-only diagnostic that confirms the backend can reach
   Stripe in test mode and lists registered readers. This is what proves the
   connection before any money logic exists, and stays useful afterwards for
   "is the reader online?".

**0.4 — Exit criteria**
- `Schema OK` against **production**, and both UNIQUE indexes confirmed by hand.
- The diagnostic lists the simulated reader from a deployed environment.
- `PAYMENTS_PROVIDER=mock` in production, and a cash **and** a card order both
  complete exactly as before — Slice 0 must be invisible to staff.
- `npx vite build` clean.

**Slice 1 — Pending checkout + PaymentIntent on a simulated reader.** Refactor
the pricing logic out of the order insert so both paths share it. Write
`pending_checkouts`; create the PaymentIntent with an idempotency key; call
`process_payment_intent`. Extend the modifier-delete guard. Frontend shows a
waiting state.

**Slice 2 — Webhooks and order materialization.** Raw-body route, signature
verification, `stripe_events` dedup, the single-transaction order insert with
`FOR UPDATE`, the amount assertion, and the Stripe fields on `payments`. This is
the slice where the money invariant becomes real.

**Slice 3 — Frontend flow.** Pending / success / decline / cancel states;
cancel-on-reader; reader-busy and reader-offline handling; retry. Cash path
visibly untouched.

**Slice 4 — Tipping.** Terminal Configuration (15/18/20); confirm the tip is
returned, stored, and that `orders.total` stays tip-inclusive. Verify Sales
Summary and Transaction Log with non-zero tips for the first time.

**Slice 5 — Tip-aware refund math (R1).** Local only, no Stripe. Lands before
Stripe refunds so the math is proven independently.

**Slice 6 — Reconciliation and orphan recovery.** The sweep, `expired` and
`orphaned` handling, alerting (logs are acceptable in v1).

**Slice 7 — Stripe refunds (R2).** Refund API wiring, the pending/failed state
machine, terminal-present refunds, the Interac block and cash-out path.

**Slice 8 — Receipts path.** Done. One read-only receipt endpoint, an 80mm
browser-print layout reachable from the checkout confirmation and Order Recall,
and Stripe's own emailed receipt for card sales. No schema change. See the
Receipts section above for what shipped and the one outstanding gap (HST
registration number).

**Slice 9 — Hardware and go-live.** Readiness done; execution pending hardware.
The procedure — reader registration, Location/till binding, the ordered
switch-to-live checklist, staff training and the in-service fallback — lives in
`stripe-go-live.md`, which is the operational companion to this design doc. This
slice deliberately ships **no code**: no hardware is present, no keys are
flipped, and `PAYMENTS_PROVIDER` stays `mock`.

The simulated-reader audit found the full loop complete (payment → tip →
webhook → order → refund → receipt) with every required webhook event handled,
and surfaced three operational gaps that a simulated reader never forces anyone
to confront:

1. ~~**`device_pairings.stripe_reader_id` has no read or write surface.**~~
   **Fixed** — Back Office → Devices now shows each till's bound reader and
   sets/clears it, with a live reader picker from the diagnostics endpoint and
   `tmr_` validation that catches a pasted Location id or serial number.
   `locations.stripe_location_id` is still SQL-only, but it is set once per
   store rather than whenever hardware changes.
2. **The Interac cash-out has no button.** `applyRefund()` accepts
   `refundMethod: 'cash'`; no frontend sends it, so an Interac refund without
   the physical card is a dead end at the counter.
3. **`RECONCILE_INTERVAL_MINUTES` defaults to `0`** — the sweep never runs
   unattended unless production sets it. Now documented in `.env.example` and a
   step in the go-live checklist.

None of the three is a defect in the payment path; all three are between the
code and the counter, which is exactly where this slice was supposed to look.

---

## Testing

1. **Simulated reader** — full flow development and regression.
2. **Test mode + physical reader** — real presentment, tipping, Interac.
3. **Live mode** — small real transactions, then full volume.

Explicit cases:
- Successful card payment with tip; tip lands in `orders.tip` and `orders.total`
- Declined card → no order row, no payments row
- Customer cancels on reader; cashier cancels; reader busy; reader offline
- Interac debit end to end
- Retry after decline → exactly one order, one payments row
- Webhook replayed twice → exactly one order (both dedup layers)
- Webhook never delivered → reconciliation materializes the order
- PI succeeded but order insert fails → flagged `orphaned`, alerted
- Modifier option deleted while a checkout is in flight → blocked by the guard
- Full refund returns the tip; partial and line-item refunds do not
- Partial refund tax portion matches `orderTax / refundableBase`
- Refund of every line equals `orders.total − tip`
- Interac refund from Back Office → blocked with the specific error
- Failed Stripe refund → `order_refunds.status='failed'`, excluded from totals
- Cash still works, start to finish
- `PAYMENTS_PROVIDER=mock` restores today's behaviour exactly

All existing refund acceptance and report reconciliation checks must still pass.
`npx vite build` clean before any frontend change is considered done.

---

## Security checklist

- [ ] Secret key only on the backend / Render env, never in git or the bundle
- [ ] Webhook signature verified on every request, using the raw body
- [ ] Webhook route exempt from `requireDevicePairing`, no other auth bypass
- [ ] Idempotency keys on every outbound Stripe call
- [ ] Durable inbound event dedup + the partial UNIQUE index
- [ ] No card data ever touches our servers (Terminal handles presentment)
- [ ] Existing dual-control, PIN approval and role checks unchanged for refunds
- [ ] Amounts never taken from the client; the server-priced snapshot is
      authoritative and the charged amount is asserted against it
- [ ] Audit log of Stripe events and local state changes

---

## Rollout checklist

- [ ] Stripe account + Location created
- [ ] Migration applied to **production** and `check:schema` reports `Schema OK`
      against production
- [ ] Partial UNIQUE index on `processor_txn_id` manually confirmed in prod
- [ ] Test keys working; simulated reader flow green
- [ ] Webhooks verified in test mode, including a replay
- [ ] Tipping configuration live; reports verified with non-zero tips
- [ ] Refund math verified (full vs. partial tip behaviour, tax proration)
- [ ] Physical reader registered and tested
- [ ] Reconciliation sweep running
- [ ] Stripe refunds verified, including a deliberate failure
- [ ] Reports still reconcile end to end
- [ ] Receipt printer chosen and confirmed visible in the tablet's print dialog
- [ ] Decide whether the HST registration number goes on
      `locations.hst_number` (migration) or stays on `BUSINESS_TAX_NUMBER`
- [ ] Live keys switched; small live transaction successful
- [ ] Kill-switch tested — flip to `mock` and back
- [ ] Staff trained on the card flow, the tip screen, and the Interac refund rule
- [ ] `features.md` and CLAUDE.md "What's NOT built yet" updated

---

## Open items

- T600 availability timeline for Canadian accounts — confirm with Stripe
  Support; not a blocker, readers are swappable by id.
- Receipt printer hardware choice — after core payments are live.
- Whether to surface reader online/offline status in Back Office → Devices.
  `device_pairings.stripe_reader_id` makes this cheap to add later.
- Interac vs. credit split in the Sales Summary payment-method mix.
  `payments.processor_payment_type` makes it available; whether to surface it
  is a reporting decision, not a payments one.
- Timing instrumentation, if the "under 10–15 seconds of customer interaction"
  success criterion is to be measured rather than felt.
- KDS device-pairing revocation is still not live-polled (`device-pairing.md`) —
  unchanged by this work, noted so it is not assumed fixed.

---

## Success criteria

- A cashier can take a card payment with an on-reader tip in 10–15 seconds of
  customer interaction.
- Webhooks plus reconciliation make a lost event rare and always recoverable;
  money is never captured without an order, or silently without an alert.
- Refunds (card, Interac, cash) work under the existing dual-control rules and
  appear correctly in every report.
- The tip is in `orders.total`, and Sales Summary still reconciles to the cent.
- The Cash path is unaffected, and `PAYMENTS_PROVIDER=mock` restores it fully.
- A second location can be added by configuration.
