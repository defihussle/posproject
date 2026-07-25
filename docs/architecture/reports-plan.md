# Reports — Implementation Plan

Companion plan for a new **Back Office → Reports** section. Written for review
before implementation, in the same spirit as `payroll-plan.md` and the other
architecture docs. No code yet.

## Why Reports exists (and how it differs from the Dashboard)
The Dashboard already answers *"how's the business doing right now?"* —
glanceable, visual, comparison-driven, period-to-date. **Reports has a
different job: turn the POS's live data into portable, exportable documents
for record-keeping and hand-off.** Three audiences drive every decision here:

- **Owner** — periodic review and reconciliation (close out a week/month, sanity-check the numbers).
- **Accountant / bookkeeper** — clean, complete numbers for filing (HST, revenue, labor expense) and import into accounting software.
- **Audit** — the ability to *justify* a number after the fact: why was this discounted, who applied it, what was the exact transaction.

Design consequence: Reports is about **extraction and record-keeping, not
visualization.** No charts. Tables, totals, and files. Where the Dashboard
shows a bar chart of hourly sales, Reports produces an `Hour | Orders | Sales`
table you can export. Anything whose only value is "it looks nice on screen"
belongs on the Dashboard, not here.

## Audit of what already exists (reuse vs. net-new)
All current stats endpoints are owner/admin (`requireBackofficeSession`), filter
`status = 'ready'` on `completed_at`, and resolve their window through the one
shared `getStatsBounds(client, req)` helper — which already accepts either a
preset (`range=today|week|month`) or a **custom `start`/`end`** (YYYY-MM-DD, in
the location timezone) and returns `{ startTs, endTs, prev, tz, location }`.
That helper is the reuse backbone: **Reports gets correct, timezone-safe date
windows for free.**

| Existing endpoint | Returns | Reports reuse |
|---|---|---|
| `stats/summary` | gross, net, discount total, orders, AOV, tips, previous | **Reuse** — core of the Sales Summary report |
| `stats/by-category` | `{category, sales, qty}` | **Reuse** — Category sales report (reformat to table) |
| `stats/top-items` | `{name, variant, quantity, revenue}` | **Reuse** — Item sales report |
| `stats/discounts` | `{reason, amount, orders}` | **Reuse** — Discount report (summary half) |
| `stats/labor` | per-staff hours/cost, total, labor % | **Reuse the calculation**, not the endpoint as-is (see below) |
| `stats/staff-performance` | `{name, role, orders, totalSales}` | **Reuse** — folded into the **Labor Report** as per-staff Orders/Sales columns (no standalone staff report — see below) |
| `stats/hourly`, `stats/trend` | hour-of-day / time-series for charts | **Mostly skip** — visualization-first; a plain hourly *table* can reuse `hourly` if an owner wants it, but trend/line data has no place in Reports |

**Net-new queries Reports needs (do not exist anywhere today):**
- **Transaction log** — one row per completed order (join `orders` + `payments` + `staff`). This is the audit backbone and has no current equivalent.
- **Payment-method breakdown** — `SUM(amount) GROUP BY method` from the `payments` table. Payments are recorded per order but never surfaced in any endpoint.
- **Per-order discount detail** — `orders WHERE discount > 0` joined to `discount_applied_by` (staff). The by-reason rollup exists; the line-level "who/when/how much" for audit does not.
- **Tax collected** — `orders.tax` is stored per order but `summary` doesn't break it out; a tax figure for filing needs it surfaced.

## Shared calculation logic — resolve BEFORE building Reports
The mandate: **a number that appears in more than one place must come from one
implementation.** The audit found this is *already violated* for labor/hours —
the "worked = elapsed − breaks" math exists in **three subtly different forms**:

- `stats/labor` — worked = elapsed − breaks, open shift counts to `now()`, **no window-end cap**.
- `payroll` — same, but **capped at the week end** (`LEAST(COALESCE(clock_out, now()), week_end)`) so a forgotten open shift can't grow.
- `staff/me/hours` (My Hours) — overlap + clip **both** ends in JS.

For the current week these agree; for a **past** period they diverge (an open
shift is capped in Payroll but runs to `now()` in the Dashboard labor number).
Reports must not add a fourth variant.

**Recommendation (small refactor, prerequisite to the Labor report):** extract
the canonical worked-time calc — *overlap the window, clip both ends to
`[startTs, endTs)`, subtract in-window breaks* — into one shared SQL fragment /
helper keyed off `getStatsBounds`, and point `stats/labor`, `payroll`, and the
new Reports labor query at it. My Hours can follow. This is the single most
important thing to get right before writing Reports, and it directly satisfies
the "never a second formula for the same number" requirement.

### Preserved behavior (must not regress)
Three shipped commits fixed specific worked-time cases. The canonical helper
(and the refactor around it) must reproduce each **exactly** — these are the
acceptance criteria, not just the general "elapsed − breaks" formula:

- **`d56b6d8` — My Hours "Today" includes an open shift that started before
  midnight.** *In scope* for the refactor (My Hours). Case: a shift clocked in
  ~22:00 *yesterday* and still open must appear in the Today window with worked
  time = *hours so far today* (clip to `[today 00:00, tomorrow 00:00)`), **not**
  be dropped by a `clock_in >= today` filter. The overlap+clip *is* this behavior.
- **`6b3cf9e` — the live Clock In/Out timer subtracts break time.** Lives in
  `GET /api/staff/me/clock-status`, which returns `breakSeconds` (sum of
  *completed* breaks on the open shift); the card renders elapsed − breaks.
- **`8ad8fbe` — the shift-ended summary shows `workedSeconds`/`breakSeconds`.**
  Lives in `POST /api/staff/me/clock-out`, which returns the ended shift's
  worked (= elapsed − breaks) and break total.

Note: two of the three (`6b3cf9e`, `8ad8fbe`) live in `clock-status`/`clock-out`,
which are **not** in the immediate refactor scope (`stats/labor`, `payroll`,
`my-hours`). They stay untouched now — the refactor must not change them, and a
test locks each — but a **future** pass should bring them onto the same helper so
the timer/summary and the aggregate reports provably share one implementation.

### Refactor approach & test-first acceptance cases
Ship the refactor as its **own isolated commit — no Reports feature work mixed
in.** Write the tests first (existing rolled-back-transaction approach:
`BEGIN; … ROLLBACK` via `docker exec … psql`) so the refactor has concrete
targets to pass:

1. **My Hours pre-midnight open shift (`d56b6d8`).** Insert an open shift
   `clock_in = today_midnight − 2h`, no `clock_out`; run the My-Hours query for
   the Today window. Expect: the shift is present, and worked hours == hours
   since today midnight (matches the ~11.22h spot-check from the original fix),
   minus any in-window break.
2. **clock-status break subtraction (`6b3cf9e`).** Insert an open shift
   `clock_in = now − 4h` + one *completed* 30 m break; call clock-status.
   Expect `breakSeconds == 1800`.
3. **clock-out ended summary (`8ad8fbe`).** Same shift, then clock-out. Expect
   `workedSeconds == 12600` (3.5 h) and `breakSeconds == 1800`.

Plus a **byte-identical regression gate:** pick a *past* week with real closed
shifts, record Payroll's per-staff hours/cost and totals, run the refactor, and
confirm the numbers are **identical before and after**. The past-week open-shift
cap is exactly where the three current implementations diverge, so this is the
sharpest check. Only ship the refactor if all three cases pass and the
before/after Payroll numbers match.

## Placement & page structure
- **Sidebar:** new **Reports** item in `NAV_ITEMS` (`BackOffice.jsx`), placed **directly after Home**. Rationale: Home (live dashboard) and Reports (periodic extracts) are the two "insight" surfaces and belong together at the top; Staff/Menu/Payroll/Devices are management surfaces below. (Alternative considered: next to Payroll as a "records" group — rejected because Payroll is an operational weekly workflow, whereas Reports is analytical/read-only like Home.)
- **Page structure:** a single Reports page, not one page per report. Top: a **date-range selector** (shared across all reports) + a **report picker** (list/tabs of the available reports). Body: the selected report rendered as a clean table with a totals row, plus its **export buttons**. Mobile: the same horizontal-scroll table pattern Payroll uses. This mirrors how Payroll and the Dashboard are laid out, so it's instantly familiar.

## The reports (each tied to a real audience need)
Deliberately a focused set — each earns its place against owner / accountant /
audit, not "because the query is easy."

**Phase 1 (core):**
1. **Sales Summary** — one period, P&L-style, as a single ordered set of line items: **Gross sales → Discounts → Net sales → Tax collected → Tips → Total collected**, plus order count, AOV, and a **payment-method breakdown** (cash / card / gift card / other).
   - *Owner:* the close-out snapshot. *Accountant:* revenue + HST for filing. *Reconciliation:* payment mix vs. total.
   - Reuse `summary`; **net-new** payment-method rollup. **`orders.tax` is a line item ON this report** (the "Tax collected" line) — there is deliberately **no separate tax report**; the accountant reads gross → net → tax → total in one place.
2. **Transaction Log (Order Detail)** — one row per completed order: order #, timestamp, staff, subtotal, discount, discount reason, tax, tip, total, payment method, status.
   - *Audit:* the record that justifies any single number. *Accountant:* line-level reconciliation and import.
   - **Net-new** query (`orders` + `payments` + `staff`).
3. **Discount Report** — per-reason totals (+ % of sales) **and** per-order detail (order #, amount, %, reason, applied-by, timestamp).
   - *Audit:* justify family/friend/employee/neighbouring-store comps — who approved what. *Owner:* comp oversight.
   - Reuse `discounts` rollup; **net-new** per-order detail (`discount_applied_by`).
4. **Labor Report** — per-staff **hours, labor cost, orders, and sales** for the range, plus total labor cost and labor % of sales.
   - *Owner:* labor cost control **and** labor-vs-output (efficiency) per person in one document. *Accountant:* labor expense.
   - Reuse the **canonical** worked-time calc (above) for hours/cost, and `stats/staff-performance` for the Orders/Sales columns (identical per-staff grain, so they join cleanly). Distinct from Payroll: Payroll is a weekly Mon–Sun *workflow* with a paid/unpaid toggle; the Labor *report* is expense/output reporting over any range, no paid state.
   - **Staff Performance is folded in here, not shipped standalone:** per-staff orders/sales is an *insight* (already a Dashboard card), not a filing/audit document — it earns its place only as context beside labor cost, not on its own.

**Phase 2 (owner insight, not filing/audit):**
5. **Category & Item Sales** — sales by category, and item ranking with revenue + qty. *Owner:* menu/inventory decisions. Reuse `by-category` + `top-items`.

**Explicitly excluded:** hourly/trend line-and-bar data (that's the Dashboard's
job — visualization), and any "staff leaderboard" gamification (not a
record-keeping need).

## Date-range handling — the key difference from the Dashboard
The Dashboard's "This Month" is **month-to-date** (partial) because it answers
"how are we doing *right now*." **Reports are about completed periods** — an
accountant filing HST wants *all of June*, not June-so-far. So Reports reuses
`getStatsBounds` (custom `start`/`end` already gives arbitrary windows) but the
**selector is period-oriented**:
- **Last Month** (the most-used filing period), **This Month (to date)**, **This Quarter**, **This Year**, and **Custom** start/end — plus explicit **month / quarter / year pickers** so "July 2026" or "Q2 2026" is one tap.
- Full calendar periods map cleanly onto `getStatsBounds`' custom bounds (a full month = `start` = 1st, `end` = last day). No new bounds logic — just a richer picker.

## Export format per report (and why)
CSV = machine-readable interchange (the accountant imports it); PDF =
human-readable record you can file/print/email. jspdf + jspdf-autotable are
already installed (from Payroll) and lazy-loaded.

| Report | CSV | PDF | Why |
|---|---|---|---|
| Sales Summary | ✅ | ✅ | Small; PDF is the filing-ready one-pager, CSV for the numbers |
| Transaction Log | ✅ | ⚠️ ≤ 500 rows only | Can be hundreds/thousands of rows → CSV is the real format. **PDF is disabled when the result exceeds 500 rows (CSV-only);** at ≤ 500 rows it's offered as a readable record. The 500 threshold keeps the PDF usable/printable and the generation fast |
| Discount Report | ✅ | ✅ | Small; both useful (CSV to import, PDF as the audit record) |
| Labor Report | ✅ | ✅ | Small; matches Payroll's export UX |
| Category & Item | ✅ | ✅ | Small |

Filenames follow the Payroll convention: `report-<name>-<start>-to-<end>.{csv,pdf}`.

## Access
Owner + admin, consistent with the rest of Back Office (`requireBackofficeSession`
default; Manager has no Back Office access at all). **Recommendation:** make the
report registry **role-aware from day one** (each report carries the roles that
may run it), even if every phase-1 report is owner+admin — so that if the owner
later wants the **financial reports (Sales Summary, Transaction Log) restricted
to owner-only**, it's a one-line change per report, not a refactor.

## Future gaps (capturable data we don't have yet — flag, don't block)
Reports will expose exactly what the schema can back today. Worth naming what it
*can't*, so numbers aren't over-trusted:
- **Payments are mocked.** Method + amount are recorded at checkout, but nothing is settled through a processor, and **tips are always $0** (no capture until Stripe Terminal). A tips report is real plumbing but empty data today. The payment-method breakdown reflects *what the cashier selected*, not a reconciled settlement.
- **No refund / void flow.** `order_status` has `cancelled` and `payment_method` has `refunded`, but there's no built flow, **no cancellation reason, and no who/when/amount audit** for a reversed sale. A genuinely complete audit trail eventually needs void/refund records — flag this as the biggest audit gap.
- **Cancelled / incomplete orders are invisible.** Every stat filters `status = 'ready'`. For audit *completeness* a report may want to show cancelled orders — but there's no reason captured to explain them.
- **No cost of goods / margins.** `ingredients` / `item_ingredients` tables exist but are unused, so profit/margin reporting isn't possible yet.
- **Single tax line (13% HST).** Fine for one Ontario location; a future multi-rate/multi-jurisdiction setup would need per-tax-component breakdown, not one `tax` column.
- **No customer data** (counter service, no accounts) — so no customer-level reports. Expected, not a gap.

## Out of scope (v1)
Scheduled/emailed reports, saved report presets, cross-location consolidation
(schema is multi-location-ready but there's one location), and anything
requiring the gaps above (refund/void, COGS, real tips).

## How we'll verify (when built)
- Backend: each report query validated against seeded orders in a rolled-back transaction; **cross-check that the Labor report, `stats/labor`, and `payroll` return the same number for the same window** (the whole point of unifying the calc).
- Reconciliation check: Sales Summary `total collected` == `SUM(payments.amount)` for the window == Transaction Log total — three surfaces, one number.
- Frontend: render the Reports page from real CSS in a harness at mobile + desktop; confirm CSV opens correctly and PDF downloads with the right filename (Back Office is TOTP-gated, so the live click-through is a manual check).
- Deploy: any new column/table migration runs on prod **before** the code push (standing deploy-order rule).
