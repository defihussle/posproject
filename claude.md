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
- Payments are **mocked** (Cash/Card recorded, no processor) — real
  integration will be **Stripe Terminal** (BBPOS WisePOS E) later
- **Discounts** — cart-level, all roles. Presets (10/20/50%) + custom %;
  a reason is **required**, from a fixed set (`family`/`friend`/
  `employee`/`neighbouring_store`, CHECK-constrained server-side). Client
  sends only percent + reason, **never** a dollar amount — the real
  discount is always recomputed server-side from the live subtotal at
  checkout; a forged amount in the request is ignored
- **Tips** — `orders.tip` summed as a Back Office stat, but there's no
  tip-collection UI yet; deferred to Stripe Terminal (tipping happens on
  the physical reader, not this app)

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
- Full schema + real 24-item menu (variants/modifiers/addons/checklists)
- Auth: PIN login (all roles), Back Office email/TOTP (owner/admin),
  device pairing gating Order Entry/KDS
- Order Entry: item customization, cart, discounts, checkout with
  server-side recomputation
- KDS: live polling board, status advance, history, recall/undo,
  new-order sound, Rush Hour aggregated view
- Back Office: Home dashboard (KPIs w/ vs-last-period deltas, Sales
  Trend/Hourly/Category/Labor charts, discounts, top items, staff
  performance, custom date range), Staff Management, Menu Management,
  Payroll, Devices — plus Manage Menu and a Staff popup, POS-reachable
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
- Self-service: Change PIN, Clock In/Out (timer shows worked time, breaks
  subtracted), My Hours

Full detail: `docs/architecture/features.md`

## What's NOT built yet
- Back Office Orders section
- Real Stripe Terminal integration (payments mocked, no tip UI)
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

  **Required process for any schema change:**
  1. Write the migration file in `database/`.
  2. Apply it to the **production** database first (via Render External Database URL + `psql` or the Render shell).
  3. Verify the new column/table exists on prod.
  4. Only then push/deploy the code that uses it.
  5. Never deploy code that depends on a migration that has not yet been run on prod.

  Local Docker is not production. “It worked on my machine” is not sufficient.

  **This is now enforced automatically** — see
  `docs/architecture/schema-guard.md`. `backend/schema-requirements.json`
  lists every table/column `database/*.sql` declares; the server refuses to
  boot, and Render's Pre-Deploy Command fails, if the database is missing any
  of them. **After adding a migration, run `npm run schema:sync` from
  `backend/` and commit the regenerated JSON** — `npm run check:schema` fails
  if you forget. The guard is a backstop, not a replacement for step 2: it
  turns a silent outage into a blocked deploy.
- `npm run dev` (`--watch`) auto-restarts on backend changes; plain
  `node server.js` does not — manual restart needed
- Commit after each working milestone; never commit `.env`,
  `node_modules`, exported reports/CSVs, or SQL dumps
- Verify `npx vite build` clean before considering a frontend change done

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
