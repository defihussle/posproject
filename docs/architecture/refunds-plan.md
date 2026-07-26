# Refunds & Voids — Implementation Plan

Companion plan for a new **Refund/Void** capability, written for review before
implementation, in the same spirit as `reports-plan.md` and `payroll-plan.md`.
No code yet.

## Why this exists (and why now)
Payments are still mocked, but Stripe (Stripe Terminal / BBPOS WisePOS E) is
coming soon. Today there is **no way to reverse a sale anywhere in the app**:
the `cancelled` and `refunded` enum values exist in the schema but nothing ever
sets them, and there is no audit trail (reason, who approved, when). The Reports
plan flagged this as *the single biggest gap* in the "justify any number" audit
trail. It must exist **before** real money moves through Stripe — otherwise the
first real refund or dispute silently breaks Sales Summary and Transaction Log
reconciliation.

Three audiences, same as Reports: **Owner** (day-to-day: quick full refunds for
mistakes, oversight against staff misuse), **Accountant** (a clean refund trail
alongside Sales Summary), **Audit** (justify every reversed dollar — who
approved it, why, when).

## Audit of what exists today (reuse vs. net-new)
- **Checkout** (`POST /api/orders`, `backend/server.js:447`) writes an order at
  `status='open'` and **one** `payments` row at `status='captured'`,
  `amount = total`, upfront (before the kitchen). Discount audit is captured
  inline: `discount_reason` (CHECK-constrained), `discount_applied_by` = the
  ringing cashier (`server.js:718-736`).
- **Order lifecycle** (`PATCH /api/orders/:id/status`, `server.js:1077`) only
  moves **forward** open→preparing→ready (ready stamps `completed_at`, treated
  as complete), plus a one-step **revert** (`:id/status/revert`,
  `server.js:1145`). **Nothing ever sets `cancelled`.** KDS routes are gated by
  `requireDevicePairing` only (no staff auth).
- **Schema already half-ready** (`database/schema.sql`):
  - `order_status` ENUM has dormant `cancelled` (and `completed`).
  - `payment_status` ENUM has dormant `refunded` (+ `failed`, `pending`,
    `authorized`).
  - `payments.processor_txn_id TEXT` **already exists** — the Stripe reference
    field is there.
  - `payments.amount NUMERIC(10,2)` — can hold **negative** values.
- **Reconciliation invariant** (Reports): `SUM(orders.total)` over
  `status='ready'` orders `== SUM(payments.amount)` over settled rows. Enforced
  through **one predicate**, `settledPaymentsWhere()` (`server.js:3729`,
  currently `p.status = 'captured'`), reused by Sales Summary, Transaction Log,
  and Labor. The code comments there **already anticipate** this feature: "When
  a refund/void flow ships, change ONLY this predicate … and every report's
  money reconciles together."
- **Access model**: two trust surfaces — **Back Office** (owner/admin only, TOTP
  session; `requireBackofficeSession(req, allowedRoles=['owner','admin'])`,
  `server.js:1733`) and **POS** (PIN + device pairing; cashiers/managers work
  here). Manager has **no** Back Office access. `canManageTarget()`
  (`server.js:2293`) is the hierarchy pattern for who-may-act-on-whom. **Order
  Entry has no order-recall/lookup today** — checkout just shows a confirmation
  number (`OrderEntry.jsx:284,774`), so a POS refund needs a new order-lookup
  surface.

## Definitions & state machine (the core model)
Two distinct reversal types, chosen by the initiator with guidance and enforced
by state:

- **Void** — *erase a sale that should never have counted* (wrong order rung,
  duplicate, order abandoned pre-pickup). Always **full-order**. Sets
  `orders.status = 'cancelled'`. A voided order **drops out of all revenue**
  (every report already filters `status='ready'`, so voids vanish from
  gross/net/tax/orders with zero query changes). Terminal. Maps forward to a
  Stripe **PaymentIntent cancel** (pre-capture) once real payments land.
- **Refund** — *money returned on a sale that still stands* (post-pickup return,
  quality issue, overcharge). Order **stays `status='ready'`** and remains in
  gross/net/tax; the refund is a **deduction** from money collected. Can be
  **full, partial-by-amount, or line-item** (line-item recomputes the tax
  portion on the refunded lines). Multiple partials may accumulate up to the
  order total. Maps forward to a Stripe **refund**.

State rules (enforced server-side):
- Void allowed from any live/complete state **only if the order has no prior
  refund**; once voided, terminal.
- Refunds allowed only on `status='ready'` orders; cumulative refunded ≤
  `orders.total`. "Fully refunded" is a **derived** state from the refund ledger
  (order stays `ready`) — we do **not** add a new `order_status`; only Void uses
  `cancelled`.

## Money model — how reconciliation still holds (the key decision)
The `payments` table stays the **single money ledger**; a dedicated table
carries the audit.

- **Every reversal writes a NEW negative `payments` row** (`amount = −refunded`,
  `method` = original method for the mock, `status = 'refunded'`,
  `processor_txn_id` for Stripe later, plus a new `refund_id` FK linking it to
  its audit record). Original captures stay positive `status='captured'`,
  `refund_id = NULL`.
- **`settledPaymentsWhere()` evolves by one line** to
  `status IN ('captured','refunded')`. Because refund rows are negative,
  `SUM(amount)` over the settled set = **net collected** automatically — captures
  minus refunds — and every report that already routes through the predicate
  (Sales Summary mix, Transaction Log reconciliation/methods) nets refunds
  **together, in one place**, exactly as the existing comments promised. A future
  `failed` Stripe row stays excluded.
- **New reconciliation invariant:**
  `SUM(orders.total)` over `ready` orders `− SUM(refunds)` on those orders
  `== SUM(payments.amount)` over settled rows `==` Transaction Log net `==` Sales
  Summary "Total collected (net)". Voided orders contribute nothing on either
  side (excluded from `ready`; their capture is fully reversed by a negative row,
  netting to 0).

Rejected alternatives: flipping the original payment's status to `refunded`
(loses the capture amount and can't express partials/multiple refunds); a
refunds table with **no** payment rows (creates a second source of money truth,
breaking the single-predicate reconciliation).

## Schema changes — `database/refunds.sql` (new migration)
Run on prod **before** deploying dependent code (standing deploy-order rule; the
`is_upsell` lesson). Mirrors the discount-audit pattern
(`modifier_management_and_discounts.sql`).

- **Types**
  - `refund_type` ENUM (`'void'`, `'refund'`).
  - `refund_reason` — fixed set, **CHECK-constrained** like `discount_reason`.
    Proposed: `wrong_order`, `kitchen_error`, `quality_issue`,
    `customer_cancelled`, `overcharge`, `duplicate`, `other` (free-text
    `reason_note` **required** when `other`). Backed by a `REFUND_REASONS`
    constant in `server.js`, mirroring `DISCOUNT_REASONS` (`server.js:444`).
  - `refund_status` ENUM (`'pending'`, `'completed'`, `'failed'`) — mock sets
    `completed` immediately; exists now so a Stripe webhook can confirm
    asynchronously later.
- **`order_refunds`** (audit + processor layer): `id`, `order_id` FK,
  `type refund_type`, `amount NUMERIC(10,2)` (positive magnitude returned),
  `tax_amount NUMERIC(10,2)` (tax portion, for partial/line-item),
  `reason refund_reason`, `reason_note TEXT`, `requested_by` FK staff
  (initiator), `approved_by` FK staff (dual-control approver; `= requested_by`
  when owner/admin self-serves), `status refund_status DEFAULT 'completed'`,
  `stripe_refund_id TEXT` (nullable, set by Stripe later), `processor_status
  TEXT` (nullable, raw webhook status), `created_at`.
- **`order_refund_items`** (line-item detail; empty for full/amount-only
  refunds): `id`, `refund_id` FK ON DELETE CASCADE, `order_item_id` FK,
  `quantity`, `amount`.
- **`payments.refund_id UUID NULL REFERENCES order_refunds(id)`** — ties each
  negative money row to its audit record; NULL on original captures.

## Access control & the dual-control flow (per decision)
- **Cashier** — may **initiate** a refund/void at the POS; **cannot approve**.
- **Manager** — may **approve** a POS refund (dual-control) and may initiate.
  Still **no** Back Office access.
- **Owner / Admin** — may refund/void anywhere (POS or Back Office) and
  **self-approve**.
- **Kitchen** — none.

**POS flow (Order Entry).** Add an **order-recall surface** (recent orders +
lookup by order #; reuses the KDS-history query shape, `server.js:1037`) since
none exists today. Cashier picks an order → chooses Void / full / partial-$ /
line-item + reason → the action is a **pending request that requires a
manager/owner PIN inline to approve** before it commits. Server verifies the
approver's PIN (existing PIN-verify pattern behind `POST /api/auth/login`) and
that the approver's role is `manager`/`admin`/`owner`; `requested_by` = cashier,
`approved_by` = approver. A plain cashier can never be the approver. Endpoint:
`POST /api/orders/:id/refund` (`requireDevicePairing` + approver-PIN in body),
transactional (insert `order_refunds` [+ items], insert negative `payments` row,
set `orders.status='cancelled'` for a void).

**Back Office flow.** Owner/admin refund/void directly from the **Transaction
Log** row. Endpoint: `POST /api/backoffice/orders/:id/refund`
(`requireBackofficeSession`); `approved_by = requested_by =` the session staff.

**Misuse guardrails.** Mirror `DISCOUNT_FLAG_THRESHOLD` (`server.js:445`): a
`REFUND_FLAG_THRESHOLD` logs high-value refunds; **full voids of already-paid
orders and refunds above the threshold require owner/admin approval** (manager
PIN insufficient) — a configurable one-liner, flagged for the owner to tune at
review.

## Reports impact
- **`settledPaymentsWhere()`** → `status IN ('captured','refunded')` (one line;
  nets refunds everywhere).
- **Sales Summary** — new line + net total:
  `Gross → Discounts → Net sales → Tax → Tips → Refunds (−) → Total collected
  (net)`, plus a **Voids memo** (count + value of voided orders — excluded from
  the P&L but surfaced so reversal activity is never invisible). Payment mix
  becomes net-by-method.
- **Transaction Log** — add a **Refunded** column and a per-row state badge
  (Refunded / Partially refunded / Voided). **Include voided orders** as flagged
  rows (net $0) — this closes the "cancelled/incomplete orders are invisible"
  gap the Reports plan flagged. Totals computed on non-voided; reconciliation
  badge compares order net (total − refunds) to payments net.
- **New Refunds Report** (dedicated audit view; a 5th entry in the role-aware
  report registry, `Reports.jsx:33`). Two grains, exactly like the Discount
  Report:
  1. **Per-reason rollup** — reason, count, total refunded, % of gross.
  2. **Per-refund detail** — date, order #, type (void/refund), amount, tax,
     reason, requested_by, approved_by, method, line-item detail,
     `stripe_refund_id` (future).
  CSV + PDF export reusing `reportExport.js` (the two-section
  `preSection`/`preTable` + `tableTitle` params added in Reports Slice 4),
  owner/admin only.

## KDS / kitchen on a post-fire void (per decision: surface it)
- **Voids** touch the KDS; **refunds do not** (a refund is money-only on a
  delivered order).
- When an order that is `preparing`/`ready` (or recently active) is voided, the
  KDS board surfaces it as a distinct **VOIDED** ticket so the kitchen stops
  cooking / discards, with a brief alert (sibling of the existing new-order
  sound). An `open` (pre-fire) void simply drops from the queue. Implementation:
  the KDS poll/history queries begin surfacing recently-`cancelled` orders with a
  voided flag; the card renders off `orders.status = 'cancelled'` (no new
  `order_item_status` value needed). Live device-pairing revocation is already
  known-not-live-polled (`device-pairing.md`) — out of scope here.

## Forward-looking Stripe design (design only — do NOT build now)
The structure updates cleanly from a webhook **without reshaping the schema**:
- Original capture's Stripe PaymentIntent/Charge id → existing
  `payments.processor_txn_id`.
- A refund is created POS-side as `order_refunds.status='pending'` with
  `stripe_refund_id` set; the negative `payments` row starts `status='pending'`.
  A **webhook** (`refund.succeeded` / `.failed`) flips `refund_status` →
  `completed`/`failed`, `payments.status` → `refunded`/`failed`, and records
  `processor_status`. Reports already exclude non-settled rows, so an in-flight
  refund never corrupts totals.
- **Disputes/chargebacks** later = add a `refund_type` value `'dispute'`
  (one-line enum add) reusing the same `order_refunds` + negative-payment +
  processor-field structure.
- Mock today: refunds are created `status='completed'` and settle instantly.

## Suggested build order (reviewable slices, like Reports)
1. **Migration + money model + core endpoints** — `refunds.sql`; POS + Back
   Office refund/void endpoints with dual-control; `settledPaymentsWhere()`
   evolution; seeded rolled-back reconciliation tests. No UI.
2. **Reports impact** — Sales Summary Refunds line + net total + Voids memo;
   Transaction Log Refunded column / state badges / voided rows.
3. **Refunds Report** — registry entry + component + CSV/PDF export.
4. **POS refund UI** — order-recall surface + refund modal (full/partial/
   line-item) + inline manager/owner-PIN approval.
5. **KDS voided-ticket handling** — VOIDED state + alert.

(Real Stripe integration remains a separate future project.)

## How we'll verify (when built)
- **Seeded rolled-back transactions** (the established `BEGIN … ROLLBACK` via
  `docker exec … psql` pattern, as in Reports Slices 2–5):
  - Partial refund: `SUM(orders.total ready) − SUM(refunds) == SUM(payments
    settled)`.
  - Void: order leaves `ready` (→`cancelled`), its payments net to 0, gross/net/
    tax exclude it.
  - Refunds Report: rollup total == sum of per-refund detail == `SUM(negative
    payment rows)`.
  - Cross-surface: Sales Summary net collected == `SUM(payments settled)` ==
    Transaction Log net.
  - Dual-control: a refund whose approver role is `cashier` is **rejected**.
- **Frontend harness renders** (real CSS, desktop + mobile) for the POS refund
  modal, the KDS VOIDED ticket, and the Refunds Report — the harness-screenshot
  approach used in the Reports slices.
- **Migration before code** on prod, per the standing deploy-order rule.

## Out of scope (v1)
Real Stripe/processor calls, chargebacks/disputes UI, refund-to-a-different-
method, partial-capture/auth flows, and emailed/scheduled refund reports.
Structure is designed so each drops in later without a schema reshape.
