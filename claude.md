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
  `discount_applied_by`, `tip` (always `$0` — no tip UI yet)
- `order_items` — status enum `pending/preparing/ready/served`
- `order_item_modifiers`, `order_item_addons` — support `quantity`
- `payments` — method enum `card/cash/gift_card/other`
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
- Back Office: Home, Staff Management, Menu Management, Devices — plus
  Manage Menu and a Staff popup, POS-reachable equivalents
- Self-service: Change PIN, Clock In/Out, My Hours

Full detail: `docs/architecture/features.md`

## What's NOT built yet
- Back Office Reports/Orders sections
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
- **Run migrations before (or with) the code deploy, never after** — code
  that selects a not-yet-added column 500s every query against that table
  until the column exists. Deploying code-first once took the whole menu
  down in prod (`is_upsell`); apply the migration to the prod DB first,
  then push/deploy the code that depends on it
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
