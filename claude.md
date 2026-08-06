# Narcos Tacos POS — Project Reference

Custom-built restaurant POS system. Read automatically at the start of
every Claude Code session — the standing source of truth for
architecture, conventions, and business rules. Detailed feature behavior
and design-decision history live under `docs/architecture/`, linked from
the relevant section below.

## Business context
- **Narcos Tacos**, first location "Lawrence East" (Scarborough, Ontario)
- Counter-service — no table service, no combos. Order at the counter,
  food lands on a pass table between kitchen/cashier, customer picks up
  (physical buzzers, standalone hardware, no software integration)
- Single location now; schema is multi-location-ready
- Tax rate: 13% (Ontario HST), on `locations.tax_rate`

## Tech stack
- **Backend**: Node.js + Express — `backend/server.js`
- **Database**: PostgreSQL 16 in Docker — container `narcos_tacos_db`,
  database `narcos_tacos`, user `narcos` (`docker compose up -d`)
- **Frontend**: React + Vite — `frontend/`, `react-router-dom`
- Two dev servers, separate terminals: `cd backend && npm run dev` (port
  4000), `cd frontend && npm run dev` (port 5173/5174)
- Git + GitHub (private repo) — commit after every working milestone

## Folder structure
```
posproject/
  backend/server.js      — all API routes
  database/               — all SQL, at REPO ROOT (sibling of backend/,
                            NOT inside it)
    schema.sql             — initial schema only; later changes are
                            separate migration files, not back-ported here
    seed_menu.sql, seed_staff.sql, seed_test_staff.sql — seed data
  frontend/src/
    components/            — PinLogin, OrderEntry, ItemModal,
                            KitchenDisplay (KDS), BackOffice,
                            BackofficeLogin/ResetPassword, HomeDashboard,
                            StaffManager (+StaffManagementModal),
                            MenuManager (+ManageMenu), DeviceManager,
                            DevicePairingScreen, RequireDevicePairing
    config.js               — exports API_URL (VITE_API_URL, trailing
                            slash stripped — see Known Gotchas)
    App.jsx                 — routing + auth/theme state
  docs/architecture/       — detailed design docs, linked from here
```

## Database schema — key tables
- `locations` — id, name, tax_rate, timezone
- `staff` — id, location_id, name, email (unique, owner/admin only),
  pin_hash (bcrypt), role (enum: owner/admin/manager/cashier/kitchen),
  hourly_rate, active, plus Back Office columns `password_hash`,
  `totp_secret`, `totp_enabled`, `reset_token` (SHA-256 hash, not raw)
- `shifts` — staff_id, clock_in, clock_out (NULL = still open)
- `shift_breaks` — shift_id, break_start, break_end (NULL = still open;
  multiple per shift, no limit)
- `menu_categories`, `menu_items`, `item_variants`, `modifier_groups`,
  `modifier_options` (`max_quantity` for stepper multi-select,
  `default_selected` for included ingredients), `item_modifier_groups`
  (join), `item_addons` (bundled free with another item)
- `ingredients`, `item_ingredients`, `modifier_ingredients` — schema
  exists, not yet used in UI
- `orders` — status enum `open/preparing/ready/completed/cancelled`;
  `discount` (always server-computed, never trust client),
  `discount_percent`, `discount_reason` (required when applied),
  `discount_applied_by`, `tip` (always `$0` — no tip UI yet),
  `voided_from_status` + `void_acknowledged_at` (KDS voided-ticket handling)
- `order_items` — status enum `pending/preparing/ready/served`
- `order_item_modifiers`, `order_item_addons` — support `quantity`
- `payments` — method enum `card/cash/gift_card/other`; status
  `captured` (positive) / `refunded` (NEGATIVE reversal row, `refund_id` FK);
  `processor_txn_id` reserved for Stripe
- `order_refunds` — reversal audit: `type` (`void`/`refund`), `amount`,
  `tax_amount`, CHECK-constrained `reason` + `reason_note`, `requested_by`,
  `approved_by`, `status`, `stripe_refund_id`/`processor_status` (Stripe-ready)
- `order_refund_items` — per-line refund detail (empty for full/amount-only)
- `device_pairings` — device_id, device_name, pairing_code_hash
  (SHA-256, not raw), code_expires_at, paired_at, created_by,
  revoked_at/revoked_by, last_seen_at

## Order lifecycle & discounts (important)
- `open` = placed, kitchen hasn't started · `preparing` = kitchen started
  · `ready` = kitchen finished, food on pass table — **treated as
  complete**, no "picked up" step; `completed_at` set the moment status
  becomes `ready`
- Payment happens **upfront**, before the kitchen sees the order
- **Cash** is recorded with no processor and inserts the order immediately.
  **Card** runs real **Stripe Terminal** card-present payments (built,
  simulated-reader verified) behind the `PAYMENTS_PROVIDER=mock|stripe`
  kill-switch — production is still on `mock`, where Card takes the same
  synchronous mocked path as Cash. See `docs/architecture/stripe-terminal-plan.md`
- **Discounts** — cart-level, all roles. Presets (10/20/50%) + custom %;
  a reason is **required**, from a fixed set (`family`/`friend`/
  `employee`/`neighbouring_store`, CHECK-constrained server-side). Client
  sends only percent + reason, **never** a dollar amount — the real
  discount is always recomputed server-side from the live subtotal at
  checkout; a forged amount in the request is ignored
- **Tips** — collected **on the card reader** (15/18/20% + custom/no-tip),
  never in this app. Percentages are calculated on the discounted pre-tax
  subtotal, not the taxed total. `orders.total` is tip-inclusive and the
  `payments` row equals it exactly — that invariant is asserted in code at
  insert time. A cash order still has `tip = 0`

## Auth model
Three independent trust layers — full narrative/history:
`docs/architecture/auth-model.md`.

- **PIN login** — every staff member has a unique 4-digit PIN, bcrypt-
  hashed, `POST /api/auth/login`. Fully separate from Back Office login.
- **Device pairing** — Order Entry and KDS both require a paired device
  before the PIN pad/board renders. Owner/admin generates a short-lived
  (10 min), single-use random code from Back Office → Devices; a new
  device enters it plus a human-assigned name (no browser API can read a
  device's real OS/Bluetooth name). Issues a long-lived httpOnly JWT
  cookie (`DEVICE_SECRET`, separate from `SESSION_SECRET`); revocation
  is DB-driven, checked live, not just on cookie expiry. Details:
  `docs/architecture/device-pairing.md`.
- **Roles**: Owner (full access; only one who can create staff/appoint
  admin/manager or toggle dark mode) · Admin (menu/prices, discounts,
  reports) · Manager (discounts/comps, void orders, shift reports; no
  menu/pricing) · Cashier (orders + discounts) · Kitchen (KDS only,
  never logs in).
- **Routing**: owner/admin/manager/cashier → `/order-entry` after PIN
  login. Kitchen never logs in — KDS has no staff auth, gated only by
  device pairing, at a non-guessable URL.
- **Back Office** (`/backoffice`) — owner/admin ONLY, email + password +
  TOTP 2FA, NOT the PIN above. httpOnly signed JWT session cookie,
  verified by `requireBackofficeSession` on every `/api/backoffice/*`
  route — a client-sent staffId is never trusted. **Manager has no Back
  Office access at all.** First-time setup (PIN → email/password → TOTP
  QR) and forgot-password (1-hour single-use token, generic response —
  prevents account enumeration) are both rate-limited.
- **Manage Menu** (`/manage-menu`) — POS-reachable, owner/admin, same
  `MenuManager` component/routes as Back Office Menu Management.
- **Hierarchy & smart deletion** (staff AND devices) — owners act on
  owner rows, owner+admin on admin rows; enforced server-side
  (`canManageTarget`/`requireManagedTarget`) AND in the UI. "Remove"
  hard-deletes a row with zero real history, force-deactivates anything
  with order/shift history — never hard-deleted either way. Same pattern
  for menu items/modifiers referenced by real orders.
- **POS-side staff actions** (Order Entry dropdown) — Manager: add-only
  quick-add modal. Owner/admin: full roster popup
  (`StaffManagementModal.jsx`), dedicated trusted-staffId routes,
  independent of the Back Office session cookie. No role/rate editing
  there. **Self-service** (every role): Change PIN, Clock In/Out
  (multi-break), My Hours — all PIN-verified, scoped to caller only.
- Theme defaults **Light**; only owners toggle dark mode.

## Design system
- Brand red `#E8442E` · green `#34A853` · fonts: Archivo Black
  (headlines), Inter (body), IBM Plex Mono (numeric/status)
- Light theme: bg `#FAFAF9`/surface `#FFFFFF`; Dark: `#111111`/`#1C1C1C`
- PIN login: circular Apple-Passcode-style keypad
- Multi-quantity modifiers use a Shopify-style pill stepper `(− n +)`,
  not checkboxes
- Cart panel collapsible: slim strip by default, auto-expands on add
- Staff/Menu/Device management share one pattern: browsable list → tap a
  row for a detail modal; destructive actions confirm via `ConfirmDialog`

## What's built
- Full schema + real 41-item menu (variants/modifiers/addons/checklists).
  Quesadillas/Burritos/Bowls carry one item per protein rather than one
  parent item with protein variants — see `menu_restructure.sql`
- Auth: PIN login (all roles), Back Office email/TOTP (owner/admin),
  device pairing gating Order Entry/KDS
- Order Entry: item customization, cart, discounts, checkout with
  server-side recomputation
- KDS: live polling board, status advance, history, recall/undo,
  new-order sound, Rush Hour aggregated view
- Back Office: Home dashboard (KPIs w/ vs-last-period deltas, Sales
  Trend/Hourly/Category/Labor charts, discounts, top items, staff
  performance, custom date range), Staff Management, Menu Management,
  Payroll, Devices (pairing codes, rename, revoke, **card-reader
  binding**) — plus Manage Menu and a Staff popup, POS-reachable
  equivalents
- Payroll: weekly (Mon–Sun) hours + gross pay per staff, Mark-as-Paid
  (persisted in `payroll_status`), CSV/PDF export; owners excluded,
  breaks subtracted, past-week open shifts capped at week end
- Reports: period-oriented range selector + role-aware registry; five
  reports — Sales Summary, Transaction Log, Discount Report, Refunds Report,
  Labor Report — each with CSV/PDF export. Money reconciles across surfaces
  via one settled-payments predicate; hours/cost reuse the canonical
  worked-time helpers (same numbers as `stats/labor`/Payroll). Phase 2
  (Category & Item Sales) deferred. See `docs/architecture/reports-plan.md`
- Refunds & Voids (all 5 slices): **Void** erases a sale
  (`status='cancelled'`, drops out of every report); **Refund** returns money
  on a standing `ready` order (full, partial-$, or line-item) and leaves it
  in gross/net/tax. Every reversal writes a NEGATIVE `payments` row plus an
  `order_refunds` audit record (type, amount, tax portion, CHECK-constrained
  reason, requested_by/approved_by), so `settledPaymentsWhere()`
  (`captured`+`refunded`) nets refunds through one predicate. Dual-control at
  the POS — a cashier initiates, a manager+ approves by PIN inline; reversals
  ≥ `REFUND_OWNER_APPROVAL_THRESHOLD` ($100) need owner/admin. Line-item
  detail is validated against the order (ownership, quantity ordered, and
  cumulative quantity already refunded). Surfaces: POS order-recall modal,
  Back Office Transaction Log, the Refunds Report, and a KDS VOIDED ticket
  with its own alert sound that kitchen staff must manually acknowledge
  (never auto-cleared), after which it stays in KDS history marked voided.
  See `docs/architecture/refunds-plan.md`
- **Stripe Terminal card payments** (Slices 0–8, simulated-reader verified;
  production still on `PAYMENTS_PROVIDER=mock`). Card checkout freezes a
  server-priced cart onto `pending_checkouts` and creates **no order row**
  until the success webhook arrives — so a decline or an abandoned payment
  leaves nothing behind anywhere. On-reader tipping, webhook-driven order
  materialization with the money invariant asserted at insert, real Stripe
  refunds with a pending/failed state machine, the Interac "card must be
  present" rule, a reconciliation/orphan sweep, and an owner/admin Stripe
  diagnostics endpoint. Design: `docs/architecture/stripe-terminal-plan.md`;
  hardware + go-live procedure: `docs/architecture/stripe-go-live.md`
- **Receipts** — one read-only `GET /api/orders/:id/receipt` projection;
  80mm browser-print layout from the checkout confirmation and Order Recall,
  plus Stripe's own emailed receipt for card sales
- Self-service: Change PIN, Clock In/Out (timer shows worked time, breaks
  subtracted), My Hours

Full detail: `docs/architecture/features.md`

## What's NOT built yet
- Back Office Orders section
- **Stripe Terminal go-live** — the integration is built and verified on the
  *simulated* reader, but no physical reader has been bought or registered
  and production still runs `PAYMENTS_PROVIDER=mock`. No customer has been
  charged through Stripe. Full procedure: `docs/architecture/stripe-go-live.md`
  - `locations.stripe_location_id` is still set by hand in SQL (once per
    store). The **reader binding is done** — Back Office → Devices → a
    device → Card reader
  - **No Interac cash-out button.** `applyRefund()` accepts
    `refundMethod: 'cash'`; no frontend sends it, so an Interac refund
    without the physical card is a dead end at the counter
  - The reconciliation sweep is opt-in (`RECONCILE_INTERVAL_MINUTES`,
    default `0` = never runs) and must be set in production before go-live
  - HST registration number has no schema home — optional
    `BUSINESS_TAX_NUMBER` env var is the stopgap for receipts
- No Back Office UI for Stripe diagnostics or reconciliation — both are
  API-only, reachable from a browser tab while logged into Back Office
- Owner/admin accounts still need first-time Back Office setup — see
  `seed_test_staff.sql` for test PINs
- KDS device-pairing revocation isn't live-polled yet (checked on page
  load only) — `docs/architecture/device-pairing.md`

## Workflow conventions
- Scope prompts to one complete, testable slice at a time
- DB changes go through a `.sql` migration in `database/` (repo root,
  not `backend/`), run via `docker exec -i narcos_tacos_db psql -U
  narcos -d narcos_tacos < database/file.sql`
- **CRITICAL: Migrations MUST run on production BEFORE (or at the same time as) the code that depends on them is deployed.**  
  This rule has already failed twice in production (`is_upsell` and the Refunds/KDS void migrations).  
  Code that references a column or table that does not yet exist will 500 every query against that table and can take the live system down.  

  Local Docker is **never** production. “It worked on my machine” is not
  evidence that anything reached prod.

  **Every schema change MUST follow the “Schema Change Checklist (Mandatory)”
  below — in order, with no steps skipped.** There is no exemption for a
  “small”, “additive” or “obviously safe” migration: `is_upsell` was one
  nullable column, and it took the whole menu down.
- `npm run dev` (`--watch`) auto-restarts on backend changes; plain
  `node server.js` does not — manual restart needed
- Commit after each working milestone; never commit `.env`,
  `node_modules`, exported reports/CSVs, or SQL dumps
- Verify `npx vite build` clean before considering a frontend change done

## Schema Change Checklist (Mandatory)
Applies **every time** you create or modify a file in `database/`. Follow it in
order. Do not reorder, do not skip, do not batch steps 3–4 “for later”.

1. **Write the migration** — a new `.sql` file in `database/` (repo root, not
   `backend/`). **Never** add new objects by editing a migration that has
   already been applied anywhere; write a new file instead.
2. **Sync the schema-guard manifest** — `cd backend && npm run schema:sync`,
   then commit the regenerated `backend/schema-requirements.json` **in the same
   commit as the `.sql`**. `npm run check:schema` fails if you forget.
3. **Apply it to PRODUCTION** — using the Render External Database URL:  
   `psql "<Render External Database URL>" -f database/<file>.sql`
4. **Verify against PRODUCTION** — must print `Schema OK`:  
   `cd backend && DATABASE_URL="<Render External Database URL>" npm run check:schema`  
   Anything other than `Schema OK` means step 3 did not fully succeed. Fix it
   before going further. (Exit 2 = could not connect — that is *not* a pass.)
5. **Only then** push/deploy the code that depends on the new columns/tables.

**Completion rule — steps 3 and 4 are part of the work, not an afterthought.**
A schema-related task is **not complete** until step 4 has actually reported
`Schema OK` against production, or the user has explicitly confirmed they ran
steps 3–4 themselves. Never describe such a task as done, and never push the
dependent code, on the strength of local Docker testing alone.

If you cannot reach production (no URL, no access, credentials unavailable):
**stop and say so plainly.** State that steps 3–4 are outstanding, give the
exact commands the user must run, and leave the dependent code unpushed. Do
not quietly defer them, and do not assume someone else will remember.

**The schema guard is a backstop, not a substitute for this checklist** (see
`docs/architecture/schema-guard.md`). It turns a forgotten migration into a
blocked deploy or a refused boot rather than a silent outage — but a blocked
deploy is still a failure of process, and the guard only covers tables and
added columns.

## Known Gotchas
- **UTF-8 on Windows**: piping SQL with accented chars (é, à) through
  PowerShell to `docker exec` has corrupted them before (Consomé →
  Consom??). Verify with a `SELECT` after any such change.
- **Render SPA routing**: `frontend/public/_redirects` alone doesn't
  guarantee Render serves `index.html` for every route — broke KDS in
  prod once. Also set the rewrite rule directly in the Render dashboard.
- **Render env vars + Vite**: `VITE_*` vars bake into the JS bundle at
  BUILD time, not runtime — changing one needs a fresh build/deploy, not
  just a dashboard save. Check no trailing slash (`config.js` strips it).
