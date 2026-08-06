# What's Built — Full Detail

Companion to the condensed **What's built** section in `CLAUDE.md` —
exact routes, algorithms, and state machines behind each feature.
Self-service account actions (Change PIN, Clock In/Out, My Hours) are
documented in `auth-model.md` instead, since they're fundamentally part
of the PIN/session model rather than a standalone feature area. The
*why* behind Reports and Refunds/Voids (audiences, rejected
alternatives, build order) lives in `reports-plan.md` and
`refunds-plan.md`; this file records what actually shipped.

## Core data
Full schema, migrated, real 41-item menu seeded with variants/modifiers/
addons/ingredient checklists.

**Protein = item, not variant** (`database/menu_restructure.sql`). Burritos,
Bowls and Quesadillas each carry one item per protein — "Chicken (Pollo)
Burrito", "Shrimp (Camaron) Quesadilla" — the same shape Birria Tacos always
used, so an owner edits one price without digging into a variant list and a
cashier sees the cards the menu board shows. The combined "Burritos & Bowls"
and "Nachos & Fries" categories are likewise split in two, which retires the
`Format` and `Base` modifier groups: the category now answers what they asked.
Nachos/Fries keep proteins as variants — only one item each ("Nachos Supreme",
"Fries Supreme"), so there was nothing to flatten.

Modifier groups are **shared, not copied**: `item_modifier_groups` is
many-to-many, so all six quesadillas point at one Ingredients group and all
twelve burritos/bowls share Toppings + Add-ons. Editing a topping edits it
everywhere. The old parent items, categories and groups are deactivated rather
than deleted — `order_items.item_id`/`variant_id` still reference them, so
every past order and report resolves its name, while `active = true` filtering
keeps them off the POS.

## Order Entry
Real menu browsing, full item customization modal (variants, modifier
groups with min/max/required rules, addons, ingredient checklists with
default-checked items), working cart, cart-level discounts (presets +
custom %, required reason, server-recomputed), checkout
(`POST /api/orders`) with full server-side price + discount
recomputation.

Checkout splits by method. **Cash** inserts the order immediately, exactly as
it always has. **Card** either does the same (while `PAYMENTS_PROVIDER=mock`,
the default) or runs the real Stripe Terminal flow — see **Card payments**
below. A receipt can be printed straight from the confirmation screen.

The reversal flow is entered from one place — the **Recall / Refund
Orders** item at the top of the account dropdown, opening
`OrderRecallModal` (see **Refunds & Voids** below). It sat in the top bar
as well until that duplicate was removed to keep the ordering screen
uncluttered; reversals are an exception path, not a per-order step. It is
not role-gated in the UI: every role that can reach Order Entry may
*initiate* a reversal, and the approval step is what actually gates it.

## KDS (`/kds/lawrence-east-4471`)
No staff auth (gated by device pairing only — see `device-pairing.md`),
opened once and left running:
- Live order queue polling every 5s (`GET /api/orders`)
- Tap-to-advance status (open → preparing → ready via
  `PATCH /api/orders/:id/status`)
- Recall/undo: `PATCH /api/orders/:id/status/revert` (preparing→open,
  ready→preparing); an undo toast appears for 6s after any status
  advance, single-level
- Color-escalating elapsed timers (green → yellow at 5min → red at
  10min)
- New-order sound: Web Audio API two-tone chime (C5+E5), plays only on
  genuinely new orders, with graceful browser autoplay handling
  (unlocks on first user interaction)
- A Completed Orders history view (`GET /api/orders/history`), Past
  Orders window covers the last 6 hours
- **Rush Hour** — a manual toggle that replaces the ticket grid with an
  aggregated view: every unique item+variant+exact-modifier-combination
  across open/preparing orders, shown as one line with a count, sorted
  count-descending. View-only (no tap targets) — completing orders still
  happens in the normal ticket view; recomputed client-side from the
  same polled data, no extra route
- Order card styling: single `elapsedTier()` function is the one source
  of truth for card color (avoids a prior bug where a separate left-edge
  accent color drifted out of sync with the rest of the card); status
  badge (NEW/IN PROGRESS) uses fixed neutral styling regardless of tier
- Device-paired indicator (bottom-right badge) — see `device-pairing.md`

### VOIDED tickets
When a sale is voided the kitchen has to be told to stop cooking, so the
board polls `status=open,preparing,cancelled` and the backend narrows
that third value hard: a `cancelled` order only reaches the board if
`voided_from_status IN ('preparing','ready')` **and**
`void_acknowledged_at IS NULL`. A void of an order that was still `open`
never reached the line, so it produces no ticket at all — it just
disappears from the queue.
- Rendered by `VoidedCard`, deliberately **not** a variant of
  `OrderCard`: it has no tap-to-advance target (a stray touch must never
  "complete" a cancelled order), a VOIDED banner, and copy that differs
  by `voided_from_status` — "stop now and discard" (was `preparing`) vs
  "pull it from the pass and discard" (was `ready`)
- Voided tickets **jump to the front** of the board regardless of FIFO
  age; they're an interrupt, not a queue entry
- **Distinct alert sound**, not a sibling of the new-order chime:
  `playVoidAlert()` is three *descending* sawtooth tones (G4→E4→C4)
  against the chime's two *ascending* sine tones (C5+E5) — different
  contour, timbre, length and volume, so it can't be misheard as "another
  order arrived". A void takes precedence: if an order is voided in the
  same poll it arrived, only the void alert plays. Newly-voided ids are
  tracked in their own `knownVoidedIds` ref, because a void is usually a
  *transition* on an order already on the board, so the new-order id
  check would never fire for it
- **Manual acknowledgement only** — `POST /api/orders/:id/acknowledge-void`
  is the only way a voided ticket leaves the board. There is deliberately
  no auto-clear timer: a void that scrolls away unseen is exactly the
  failure this exists to prevent. The acknowledgement is persisted
  server-side (not client state), so it survives a reload and clears on
  every KDS device at once, and it's idempotent
  (`COALESCE(void_acknowledged_at, now())`) so a double-tap is harmless
- Afterwards the ticket lives on in **Past Orders** marked VOIDED rather
  than vanishing without trace. History windows/sorts a voided order by
  `COALESCE(completed_at, created_at)`, since one cancelled mid-prep
  never got a `completed_at`. Its detail view withholds the undo
  affordance entirely — a void is terminal, there is no "return to queue"
- **Rush Hour** never aggregates a voided ticket into a make-line (that
  would tell the cook to produce food nobody is paying for); the voided
  cards render above the aggregated view instead, and stay actionable
  there, because "stop making this" can't wait for a view switch

## Refunds & Voids
Cross-surface feature (POS + KDS + Back Office + Reports), shipped in
five slices. Design rationale, rejected alternatives and the forward
Stripe mapping: `refunds-plan.md`. Migration: `database/refunds.sql`
(plus `database/kds_void_acknowledgement.sql`).

**Two reversal types**, both funnelling through one server-side helper,
`applyRefund()`:
- **Void** — erase a sale that should never have counted. Always
  full-order, sets `orders.status = 'cancelled'`, and since every report
  filters `status = 'ready'` the order drops out of gross/net/tax with no
  query changes. Terminal.
- **Refund** — money back on a sale that still stands. The order stays
  `ready` and stays in gross/net/tax; the refund is a deduction from
  money collected. Full, partial-by-amount, or line-item.

**State rules** (enforced in `applyRefund()`, with the order row locked
`FOR UPDATE` for the whole reversal):
- Anything already `cancelled` → 409, nothing left to reverse
- A **void** is rejected if any prior non-failed refund exists ("reverse
  the remainder with a refund, not a void"); it's otherwise allowed from
  any live state, and stores the pre-void status in
  `orders.voided_from_status`
- A **refund** requires `status = 'ready'` — an in-progress order is
  reversed with a void instead
- Cumulative refunds ≤ `orders.total`; over that is a 400 naming the
  remaining refundable. "Fully refunded" is **derived** from the ledger,
  not a new `order_status` — only Void uses `cancelled`
- Reasons are a fixed `REFUND_REASONS` set (`wrong_order`,
  `kitchen_error`, `quality_issue`, `customer_cancelled`, `overcharge`,
  `duplicate`, `other`), CHECK-constrained in the DB like discount
  reasons; `reason_note` is required when the reason is `other`

**Money model.** `payments` stays the single money ledger. Every reversal
writes a **new negative `payments` row** (`amount = −refunded`,
`status = 'refunded'`, `method` copied from the order's original capture,
`refund_id` FK → the audit record); the original capture is untouched.
`order_refunds` carries the audit (type, amount, tax portion, reason +
note, `requested_by`, `approved_by`, `status`, and the nullable
`stripe_refund_id`/`processor_status` fields Stripe will fill later), and
`order_refund_items` the optional per-line detail. Because reversals are
negative, `settledPaymentsWhere()` — one predicate,
`status IN ('captured','refunded')` — makes `SUM(payments.amount)` **net
collected by construction**, so every report nets refunds in one place.
Tax portion: a void returns the whole `orders.tax`; a full-remaining
refund returns `tax − already-refunded tax`; an explicit amount or a
line-item set gets a proportional share (`amount × tax / total`).

**Dual control.** `POST /api/orders/:id/refund` (POS, device-paired)
takes both a `staffId` (initiator — any of owner/admin/manager/cashier)
and an `approverStaffId` + `approverPin`. The approver must be
owner/admin/manager *and* prove their PIN, bcrypt-verified server-side;
a cashier can never be the approver, so a cashier can never refund a
sale alone. The approver may equal the initiator when the initiator is
manager or above.

**The one exception — voiding an order the kitchen hasn't finished.**
Omitting `approverStaffId` is a request to self-approve, and the server
grants it *only* for `type='void'` on an order still `open` or
`preparing`. Nothing has reached a customer yet, so killing a mis-rung
ticket is a correction rather than money moving, and making a cashier
find a manager mid-rush is how bad tickets reach the line. Once the order
is `ready` the food exists and dual control applies again; **refunds
always require an approver, at any status.** The check lives inside
`applyRefund()` under the `FOR UPDATE` lock rather than in the route,
because the order's status is exactly what a concurrent KDS advance
changes — deciding it before the lock would let a void started on a
`preparing` order land on a `ready` one unapproved. The
owner-approval threshold below is scoped to the dual-control path for the
same reason it exists (it governs who may *approve*), so a self-approved
void isn't refused for being large; it is still logged.

Two thresholds sit on top:
`REFUND_OWNER_APPROVAL_THRESHOLD` ($100) — a manager PIN is rejected at
or above it, owner/admin only; and `REFUND_FLAG_THRESHOLD` ($50) —
logged, never blocked, so a high-value reversal is never silently
invisible. `POST /api/backoffice/orders/:id/refund` is the Back Office
equivalent: owner/admin session, self-approving
(`approved_by = requested_by`).

**Line-item validation and pricing.** Caller-supplied line detail is
validated against the order before anything is written — the dollar
ceiling already stops money leaking, this stops the *audit* lying.
Duplicate entries for one line are collapsed first (so the same line
listed twice is checked on its combined quantity), then each line must
belong to this order, carry a positive integer quantity ≤ the quantity
ordered, and fit within `ordered − already refunded on prior non-failed
refunds` — so cumulative line refunds can never claim more units were
returned than were sold.

The line's **dollar value is computed server-side too**, never taken from
the request — the client sends only which lines and how many units, the
same never-trust-the-client rule as checkout pricing and discounts. A
line's share of what was actually collected is
`qty × unit_price × (orders.total / orders.subtotal)`: `unit_price` is
already the fully-priced per-unit figure (variant + modifier deltas +
paid addon extras) and `orders.subtotal` is exactly Σ(unit_price ×
quantity), so scaling by `total/subtotal` allocates the order's discount,
tax and tip across the lines proportionally. Refunding every line
therefore returns exactly `orders.total`, tax included, and a line of a
discounted order returns what was really paid for it rather than its
undiscounted list price. The reversal's `amount` is the sum of those
server-priced lines — so `order_refunds.amount` always equals
`SUM(order_refund_items.amount)` exactly, and any `amount` in a
line-item request is deliberately ignored.

**POS surface** (`OrderRecallModal.jsx`, opened from Order Entry) — the
order-recall surface the POS previously lacked:
- `GET /api/orders/pos-recall?search=&limit=` — recent orders (default
  20, max 50) with line items, payment method, and prior refund history;
  search matches order number or customer name
- Left list with per-order state badges (Voided / Fully Refunded /
  Partially Refunded), right pane with items, money summary, and a
  **Prior Reversal Log**
- Four actions: **Void Order** (only offered while nothing has been
  refunded), **Full Refund** of the remaining balance, **Partial Amount**,
  and **Line-Item** with a per-line `− n / ordered +` stepper. Reason
  picker, plus a required note when "Other"
- Approval is a two-step overlay: pick the approver by name
  (`GET /api/staff/approvers` — active owner/admin/manager, ordered by
  seniority), then a 4-digit keypad that auto-submits on the fourth
  digit. At $100+ the approver list is filtered to owner/admin and the
  overlay says why. The caller is pre-selected as approver when they are
  themselves eligible at that amount

**Reporting surfaces** — Transaction Log (Refunded column + Voided /
Refunded / Partially refunded row badges, voided rows included), Sales
Summary (Refunds line, net Total collected, Voids memo), and the
dedicated **Refunds Report** — all described under **Reports** below.

**KDS surface** — the VOIDED ticket flow documented in the KDS section
above. Refunds never touch the KDS; only voids do.

Acceptance tests (seeded `BEGIN … ROLLBACK` transactions, run against the
real DB): `tests/refund_reconciliation_acceptance.mjs`,
`tests/refund_line_item_acceptance.mjs`, `tests/kds_void_acceptance.mjs`,
and `tests/refund_cross_report_acceptance.mjs` — which adds the fifth
report, asserting that the Refunds Report agrees with Sales Summary and
the Transaction Log for a window containing both a sale and its reversal,
*and* that the two legitimately diverge for a window containing only one
of the pair (the activity-view vs original-sale-period scoping below).

## Card payments — Stripe Terminal
Real card-present payments on a Stripe smart reader. Design and locked
decisions: `stripe-terminal-plan.md`. Operational procedure (registering a
reader, going live, staff training): `stripe-go-live.md`. Migration:
`database/stripe_terminal.sql`.

**Status**: Slices 0–8 built and verified end to end on the **simulated
reader**. No physical reader has been purchased, and production still runs
`PAYMENTS_PROVIDER=mock` — so no customer has been charged through Stripe yet.

**The kill-switch** — `PAYMENTS_PROVIDER=mock|stripe`, defaulting to `mock`.
On `mock`, Cash *and* Card both take the original synchronous path and no
Stripe call is ever made; a dead terminal is recoverable with an env var
rather than a deploy. On `stripe`, the three Stripe vars become mandatory and
a missing one throws at boot rather than in front of a customer.

**No order row until the money lands** (decision D1, "Option B"). Card
checkout prices the cart with the *same* `priceCart()` the cash path uses,
freezes that snapshot onto a `pending_checkouts` row, creates a PaymentIntent
and hands it to the reader — and creates **nothing else**. A decline, a
cancel or a customer who walks away leaves no order, no payments row, no KDS
ticket and no phantom `cancelled` row in the Transaction Log. The real
`orders` + `payments` rows are written only when the success webhook arrives,
in one transaction, from the frozen snapshot (never re-priced — a price edit
mid-payment must not change what the customer was charged).

**The money invariant**, asserted in code at insert time and re-read from the
written rows before the transaction commits:
`orders.total = subtotal − discount + tax + tip`, and the `payments` row
equals `orders.total` exactly. A mismatch rolls the order back and flags the
checkout `orphaned` rather than recording a sale whose money doesn't add up.

**Tipping** — on the reader, 15/18/20 % plus custom and no-tip, from a
Terminal Configuration on the Stripe Location. The percentages are calculated
on the **discounted pre-tax subtotal** (`process_config.tipping
.amount_eligible`), not the full charge — tipping on HST would quietly inflate
every suggestion by 13 %. The tip is derived as *charged minus snapshot*, then
cross-checked against Stripe's own tip figure; disagreement is a hard failure.

**Webhooks are the source of truth.** Raw-body signature verification mounted
before the global `express.json()`, durable dedup on `stripe_events.id` backed
by a partial UNIQUE index on `payments.processor_txn_id` (the dedup that
actually makes a double-insert impossible), and `SELECT … FOR UPDATE` on the
pending row so concurrent deliveries serialise. Handled:
`payment_intent.succeeded` / `.payment_failed`,
`terminal.reader.action_succeeded` / `.action_failed`, `refund.created` /
`.updated` / `.failed`, `charge.refunded`.

**Reconciliation** (`POST /api/backoffice/payments/reconcile`, plus a
read-only `/status`) is the safety net, not the mechanism: it materializes
orders for missed webhooks, expires abandoned checkouts, and flags
"PaymentIntent succeeded but no order row" as `orphaned` and loudly. The
background schedule is **opt-in via `RECONCILE_INTERVAL_MINUTES` and off by
default** — it must be set in production before go-live.

**Refunds** reuse the existing dual-control flow unchanged. Tip policy: a full
refund and a void return the tip; partial and line-item refunds never do, and
all their math runs off `refundableBase = total − tip` (which also fixed a real
tax-proration bug that was overstating HST remitted to CRA). Card refunds go to
Stripe and sit at `status='pending'` — excluded from every total by
`settledPaymentsWhere()` — until a webhook promotes them to `completed` or
`failed`. **Interac refunds require the physical card at the reader**, so the
Back Office path rejects them with a specific message.

**Cashier-facing states** — waiting / declined / cancelled / reader-busy /
reader-offline, each with its own copy and actions (retry card, switch to
cash, back to cart). The cart is never cleared until money is genuinely
collected, so no failed attempt loses an order.

**Diagnostics** — `GET /api/backoffice/stripe/diagnostics` (owner/admin,
read-only) reports account, Location wiring, every registered reader with its
online status and whether it matches the configured Location, the live tipping
percentages, and a `hints[]` array that names whatever looks half-wired. It
deliberately lists *all* readers rather than filtering by Location, so a
mismatch reads as a mismatch instead of an empty list.

**Known gaps** (see `stripe-go-live.md`): `device_pairings.stripe_reader_id`
and `locations.stripe_location_id` are SQL-only — no UI binds a reader to a
till — and the Interac cash-out path exists in `applyRefund()` but has no
button.

## Receipts
`GET /api/orders/:id/receipt` (device-paired) is one read-only projection of a
settled order — business details, lines with their required-group choices,
added modifiers, "NO onions" removals, add-ons and notes, totals, the payment
row's card brand/last4/entry type, and any reversals with a net-paid figure. It
prices nothing and writes nothing, so a reprint an hour later is identical to
the original.

**Print** is the browser's own dialog over an 80mm layout (`ReceiptModal.jsx`),
so any receipt printer the tablet's OS already sees works with no driver in this
app. **Email** (`POST /api/orders/:id/receipt/email`) sets `receipt_email` on
the Stripe charge and lets Stripe send its own receipt — cash sales and anything
taken on `mock` have no charge to attach an address to and are print-only.

Reachable from the checkout confirmation (which cancels its own 2-second
self-dismiss when a receipt is asked for) and from Order Recall, the reprint
surface for any past order.

`order_items.unit_price` already includes modifier deltas and paid add-ons, so
`SUM(unit_price × quantity)` *is* `orders.subtotal` — modifiers therefore print
as descriptive sub-lines with no money beside them. The HST registration number
has no home in the schema yet and comes from the optional `BUSINESS_TAX_NUMBER`
env var.

## Back Office (`/backoffice`)
Sidebar order (`NAV_ITEMS` in `BackOffice.jsx`): Home, Staff Management,
Menu Management, Payroll, Reports, Devices. Every section is owner/admin.
- **Home** — a glanceable KPI dashboard: Gross Sales, Net Sales, Orders,
  Avg Order, Total Tips and Labor Cost %, each with a vs-previous-period
  delta (suppressed rather than faked when there's no prior baseline, and
  inverted for Labor Cost % where up is bad), Sales Trend /
  Hourly / Category-sales / Labor-vs-sales charts, discount breakdown,
  top items, staff performance, a Today/This Week/This Month switcher
  **plus a Custom start/end range** (which resolves through the same
  `getStatsBounds` window logic Reports uses), and **Live Status**, a
  read-only 5s-polled card showing every currently-clocked-in staff
  member and how long they've been Working/On Break
  (`GET /api/backoffice/staff/live-status`, owner/admin only)
- **Staff Management** — full CRUD, PIN reset, hierarchy-enforced, email
  field for owner/admin, smart deletion (see `auth-model.md`)
- **Menu Management** — full CRUD for items, variants, AND modifier
  groups/options
- **Payroll** — weekly hours + gross pay with Mark-as-Paid (see below)
- **Reports** — five exportable record-keeping reports (see below); the
  one sidebar entry that is a **dropdown group** rather than a single
  route
- **Devices** — generate pairing codes, list/rename/revoke paired
  devices (see `device-pairing.md`)

## Payroll (`/backoffice/payroll`)
Weekly (Mon–Sun) hours and gross pay per staff member, with a persisted
Paid/Unpaid marker and CSV/PDF export. Migration:
`database/payroll_status.sql`.
- `GET /api/backoffice/payroll?weekStart=YYYY-MM-DD` — `weekStart` is
  optional and normalized to that week's Monday with
  `date_trunc('week', …)` in the **location timezone**; omit it for the
  current week. The response carries both the Monday and the Sunday for
  display/filenames
- Hours come from the canonical worked-time helpers
  (`shiftOverlapsWindowSql` / `workedSecondsSql`) — clip the shift to the
  week window, subtract in-window breaks, floor at 0 — the same
  implementation `stats/labor` and the Labor Report use, so the numbers
  can't drift between surfaces. Because the window's upper bound is the
  week end, a **forgotten open shift in a past week is capped there**
  rather than growing to `now()`; for the current week `now()` wins
  naturally
- **Owners are excluded** (`st.role <> 'owner'`) — payroll is for paid
  staff. A NULL `hourly_rate` surfaces as "rate not set" with **null**
  pay, deliberately not `$0` (which would read as "worked for free");
  note this differs from the Labor *report*, which includes owners and
  costs a NULL rate at $0 to match `stats/labor`
- `PUT /api/backoffice/payroll/status` upserts the paid flags for a week
  in one transaction, keyed `(staff_id, week_start)`, recording `paid_at`
  and `paid_by` (cleared back to NULL when unmarked)
- CSV/PDF export, jsPDF lazy-loaded so it stays out of the main bundle

## Reports (`/backoffice/reports/*`)
Portable, exportable records for filing/reconciliation/audit — explicitly
**not** visualization; that's Home's job. Owner/admin only
(`requireBackofficeSession` on every endpoint). Design rationale and the
audience-per-report reasoning: `reports-plan.md`.

**Structure.** `frontend/src/components/reports/registry.js` is the
single source of truth: it drives BOTH the sidebar dropdown entries and
the nested routes under `/backoffice/reports/*`, so adding a report is a
one-line change with no other file edits. Each report carries its own
`roles` list — role-aware from day one, even though all five are
currently owner/admin. `ReportsLayout.jsx` owns the shared range selector
and hands the resolved window down through `<Outlet>` context;
`ReportRoute` re-checks the individual report's role list and redirects an
unauthorized role to the first report it *can* see. Every report is its
own URL, so a specific report can be linked/bookmarked.

**Range selector** (`reportRange.js`, pure and unit-tested in
`reportRange.test.mjs`). Reports describe *completed* periods, unlike
Home's period-to-date framing, so the presets are period-oriented:
**Last Month** (the default), This Month, This Quarter, This Year, plus
**Custom** with month / quarter / start-end sub-modes. A window whose
natural end is in the future is capped at today and labelled
"(to date)". Each resolved window carries a `kind`
(month/quarter/year/range) so `previousPeriod()` can pick the right prior
equivalent even when the dates alone are ambiguous — Jul 1–24 is the same
two dates whether it's this month or this quarter to date, but the prior
period differs (Jun 1–24 vs Apr 1–24). Dates are built from numeric parts
and never parsed from strings, because iOS Safari throws on
`new Date("YYYY-MM-DD…")` where Chromium accepts it. Start/end go to the
backend as `getStatsBounds`' custom `start`/`end`, so no new date logic
exists server-side.

**The five reports:**
1. **Sales Summary** (`reports/sales-summary`) — P&L-style single-period
   snapshot: Gross → Discounts → Refunds → Net sales → Tax → Tips →
   Total collected, plus order count, AOV and a payment-method mix. The
   pre-tax refund portion comes out of net sales and the refunded tax out
   of the tax line, so `Net + Tax + Tips == SUM(orders.total) − refunds`
   by construction. The mix is a net `SUM(amount) GROUP BY method` over
   the settled set, so a method's bucket is what it *net* collected,
   while its `count` counts captures only and still reads as "orders paid
   by this method". A **Voids memo** (count + value, scoped by when the
   void happened) is a footnote, not a P&L line — voided orders are
   `cancelled` and so are already excluded from every line above
2. **Transaction Log** (`reports/transactions`) — the audit backbone, one
   row per completed (`ready`) order plus every voided one: number, time,
   staff, subtotal, discount + reason, tax,
   tip, total, **Refunded**, payment method(s), and a state badge
   (Voided / Refunded / Partially refunded). **Voided orders are
   included** as flagged rows contributing nothing to the totals, which
   closes the "cancelled orders are invisible" gap. Carries a
   **reconciliation badge** comparing order net (total − refunds) against
   the settled-payments sum, and an optional prior-period comparison
   (the frontend computes `prevStart`/`prevEnd` via `previousPeriod()`;
   the backend runs the same aggregate over whatever it's handed)
3. **Discount Report** (`reports/discounts`) — two grains: a per-reason
   rollup (reason, orders, amount, % of gross) and per-order detail
   (order #, time, subtotal, discount $, %, reason, **applied by**). Both
   share one WHERE, so the rollup total equals the detail sum by
   construction. `discount_applied_by` is LEFT JOINed so a comp whose
   applier was since removed still shows. Order-side only — a discount
   isn't a payment, so `settledPaymentsWhere()` is deliberately not
   involved
4. **Refunds Report** (`reports/refunds`) — the reversal audit, same two
   grains: per-reason rollup, and per-reversal detail (time, order #,
   type, amount, tax, reason, **requested by**, **approved by**, method,
   `stripe_refund_id` for later). Scoped by **when the reversal
   happened** (`order_refunds.created_at`) — an activity view,
   deliberately different from Sales Summary / Transaction Log, which
   attribute a refund back to the original sale's period so their money
   reconciles with settled payments
5. **Labor Report** (`reports/labor`) — per-staff hours, labor cost,
   orders handled and sales rung, plus total labor cost and labor % of
   sales. Hours/cost use the same canonical worked-time helpers as
   `stats/labor`, Payroll and My Hours over the same window, so they're
   identical to those surfaces by construction. Rows are shift-driven
   (everyone with a shift overlapping the window, owners included);
   orders/sales are LEFT JOINed on so a worker who rang nothing still
   shows their hours. Staff Performance is folded in here rather than
   shipped standalone. Distinct from Payroll: Payroll is a Mon–Sun
   workflow with a paid/unpaid state; this is expense/output reporting
   over any range

**Reconciliation.** Every money rollup routes through the one
`settledPaymentsWhere()` predicate, so:
`SUM(orders.total)` [ready] − `SUM(refunds on those orders)`
`== SUM(payments.amount)` [settled] `==` Transaction Log net `==` Sales
Summary "Total collected". Proven against seeded partial-refund,
full-refund and void data in
`tests/refund_reconciliation_acceptance.mjs`, with
`tests/refund_cross_report_acceptance.mjs` extending the check to the
Refunds Report — pinning both when it must agree with the other two and
when its activity-view scoping is *supposed* to make it differ.

**Export** (`reportExport.js`) — one CSV builder and one PDF builder
shared by all five bodies, so every export has an identical header, look
and filename convention: `report-<name>-<start>-to-<end>.{csv,pdf}`
(matching Payroll's). Two-grain reports (Discount, Refunds) pass
`preSection` + `tableTitle` to emit the rollup above the detail table in
both formats. jsPDF + jspdf-autotable are dynamically imported on export
only, keeping them out of the main bundle. **Transaction Log PDF is
disabled above 500 rows** (CSV-only, with an inline explanation) — that
report can run to thousands of rows, where CSV is the real format and a
PDF would be neither printable nor fast to generate.

**Phase 2 (Category & Item Sales) is deferred** — the `by-category` and
`top-items` stats endpoints exist and back Home's cards, but no Reports
entry consumes them yet.

## Manage Menu (`/manage-menu`)
The same editor as Back Office's Menu Management, reachable from the POS
for owner/admin — see `auth-model.md` for why it's the same component.

## POS Staff Management popup
Order Entry's "Staff Management" dropdown entry, owner/admin — a
self-contained popup (`StaffManagementModal.jsx`) hitting dedicated
trusted-staffId POS routes, no Back Office session/cookie dependency at
all: list (active + inactive), live clock-in/break status per row, add
(reuses quick-add), deactivate/reactivate/delete, reset PIN — no
role/hourly-rate editing (stays Back-Office-only). Hierarchy protection
enforced both server-side and in the UI. Manager keeps the original
add-only quick-add modal, unchanged. Full detail: `auth-model.md`.
