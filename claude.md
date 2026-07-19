# Narcos Tacos POS — Project Reference

Custom-built restaurant POS system. This file is read automatically at the 
start of every Claude Code session — treat it as the standing source of 
truth for architecture, conventions, and business rules.

## Business context
- Restaurant: **Narcos Tacos**, first location "Lawrence East" (Scarborough, 
  Ontario, Canada)
- Counter-service model — no table service, no combos. Customer orders at 
  the counter, food is prepared and placed on a pass table between kitchen 
  and cashier, customer picks it up (physical buzzers are used but are a 
  standalone hardware system, no software integration)
- Single location now; schema is multi-location-ready for future expansion
- Tax rate: 13% (Ontario HST), stored on `locations.tax_rate`

## Tech stack
- **Backend**: Node.js + Express — `backend/server.js`
- **Database**: PostgreSQL 16 in Docker — `docker compose up -d`, container 
  `narcos_tacos_db`, database `narcos_tacos`, user `narcos`
- **Frontend**: React + Vite — `frontend/`, using `react-router-dom`
- Two independent dev servers must run in separate terminals: 
  `cd backend && npm run dev` (port 4000) and `cd frontend && npm run dev` 
  (port 5173/5174)
- Git + GitHub (private repo) — commit after every working milestone

## Folder structure
```
posproject/
  backend/
    server.js          — all API routes
  database/            — all SQL, at the REPO ROOT (a sibling of backend/,
                          NOT inside backend/)
    schema.sql          — base table definitions (initial schema; later
                          changes are layered on as separate migration files
                          and are NOT back-ported into this file)
    seed_menu.sql       — real menu data
    seed_staff.sql      — owner accounts
    seed_test_staff.sql — manager/cashier/kitchen test accounts
    (various migration .sql files, run in chronological order)
  frontend/
    src/
      components/        — PinLogin.jsx (Order Entry/KDS PIN login),
                            OrderEntry.jsx, ItemModal.jsx,
                            KitchenDisplay.jsx (KDS, incl. Rush Hour),
                            BackOffice.jsx (Back Office shell/nav),
                            BackofficeLogin.jsx + ResetPassword.jsx
                            (email+password+TOTP login, forgot/reset
                            password), HomeDashboard.jsx, StaffManager.jsx
                            (Back Office's full-edit Staff tab) +
                            StaffManagementModal.jsx (self-contained POS
                            roster popup for owner/admin, own CSS file —
                            see Auth model, NOT a wrapper around
                            StaffManager), MenuManager.jsx (shared editor,
                            see Auth model) + ManageMenu.jsx (its POS
                            wrapper)
      assets/             — narcos-tacos-logo.png (official brand logo, 
                            transparent background)
      config.js           — exports API_URL (from VITE_API_URL, trailing
                            slash stripped defensively — see Known Gotchas)
      App.jsx             — routing + auth/theme state
```

## Database schema — key tables
- `locations` — id, name, tax_rate, timezone
- `staff` — id, location_id, name, title, phone, email (unique, case-
  insensitive index; only ever set for owner/admin — see Auth model), 
  photo_url, pin_hash (bcrypt via pgcrypto), role (enum: `owner`, `admin`, 
  `manager`, `cashier`, `kitchen`), hourly_rate, hire_date, active, plus 
  Back Office auth columns `password_hash`, `totp_secret`, `totp_enabled`, 
  `reset_token` (SHA-256 hash, not the raw token), `reset_token_expiry`
- `shifts` — id, staff_id, location_id, clock_in (default now()), 
  clock_out (nullable — NULL means the shift is still open). Self-service 
  clock in/out, Order Entry account dropdown, all roles (see below)
- `shift_breaks` — id, shift_id (FK to shifts), break_start (default 
  now()), break_end (nullable — NULL means the break is still open). 
  Multiple rows per shift, no limit — a shift's worked time is clock_out 
  minus clock_in minus the sum of every break within it
- `menu_categories`, `menu_items`, `item_variants` (e.g. protein choices, 
  each with own absolute price), `modifier_groups`, `modifier_options` 
  (has `max_quantity` for stepper-style multi-select, `default_selected` 
  for standard/included ingredients), `item_modifier_groups` (join), 
  `item_addons` (items bundled free with another item, e.g. Consomé with 
  Birria Tacos, also independently sellable)
- `ingredients`, `item_ingredients`, `modifier_ingredients` — ingredient-level 
  inventory (schema exists, not yet actively used in UI)
- `orders` — status enum: `open`, `preparing`, `ready`, `completed`, 
  `cancelled`; also `discount` (dollar amount, always server-computed — 
  never trust a client-sent amount), `discount_percent`, `discount_reason` 
  (one of `family`/`friend`/`employee`/`neighbouring_store`, required 
  whenever a discount is applied), `discount_applied_by` (staff id), and 
  `tip` (pre-existing column, now actually read — see Business rules; 
  currently always `$0` since there's no tip-collection UI yet)
- `order_items` — status enum: `pending`, `preparing`, `ready`, `served`
- `order_item_modifiers`, `order_item_addons` — line-level modifier/addon 
  records, both support `quantity`
- `payments` — method enum: `card`, `cash`, `gift_card`, `other`

## Business rules — order lifecycle (important)
- `open` = just placed, kitchen hasn't started
- `preparing` = kitchen started
- `ready` = kitchen finished, food on the pass table. **Treated as complete** 
  — no separate "picked up" step exists or is planned. `completed_at` gets 
  set the moment status becomes `ready`.
- Payment happens **upfront**, before the order goes to the kitchen (matches 
  real counter-service — pay first, food made after)
- Payments are currently **mocked** (Cash/Card recorded, no real processor) 
  — real integration will be **Stripe Terminal** (BBPOS WisePOS E reader) 
  when that phase happens
- **Discounts** — cart-level, in Order Entry's checkout flow, available to 
  **all roles** (owner/admin/manager/cashier). Preset percentages 
  (10/20/50%) plus a custom percentage; a reason is **required** whenever a 
  discount is applied, from a fixed set — `family`, `friend`, `employee`, 
  `neighbouring_store` (enforced server-side via CHECK constraint, checkout 
  rejected without one). Same never-trust-the-client principle as pricing: 
  the client sends only a percent + reason, never a dollar amount — the 
  actual discount is always recomputed server-side from the live subtotal 
  at checkout (a tampered/forged dollar amount in the request is ignored).
- **Tips** — `orders.tip` is tracked and summed as a "Total Tips" stat on 
  the Back Office Home dashboard, but there is **no tip-collection UI 
  anywhere on the POS yet** — that's intentionally deferred until real 
  Stripe Terminal integration, where tipping will happen on the physical 
  terminal's own screen, not in this app. Expect `tip` to read `$0` on 
  every order until that phase.

## Auth model
- **Order Entry/KDS** — every staff member (owner/admin/manager/cashier/
  kitchen) has a unique 4-digit PIN, bcrypt-hashed, checked via 
  `POST /api/auth/login`. This is completely separate from Back Office's 
  login below (different route, different credentials, different session 
  mechanism) and is unaffected by anything there — including for owner/
  admin, who use their PIN here and email+password+TOTP there.
- Role permissions:
  - **Owner**: full access, only role that can create staff/appoint 
    admin/manager roles, can toggle app-wide light/dark theme
  - **Admin**: can edit menu/prices, apply discounts, view full reports — 
    cannot create staff or appoint roles
  - **Manager**: can apply discounts/comps, void orders, shift-level 
    reports — cannot touch menu/pricing
  - **Cashier**: takes orders, can apply discounts (per business decision)
  - **Kitchen**: KDS only
- **Routing after login**: owner/admin/manager/cashier → `/order-entry`. 
  **Kitchen does NOT log in at all** — KDS is a no-auth "open book" screen 
  at a deliberately non-guessable route (`/kds/lawrence-east-4471`), meant 
  to be opened once on a kitchen device and left running indefinitely.
- **Back Office** — separate route `/backoffice`, persistent sidebar nav 
  (`NAV_ITEMS` config in `BackOffice.jsx` — add future sections there, each 
  with its own allowed-roles list). **Owner/admin ONLY, authenticated via 
  email + password + TOTP 2FA** (`BackofficeLogin.jsx`) — NOT the PIN used 
  above. A real server-side session (httpOnly, signed JWT cookie, verified 
  by `requireBackofficeSession` on every `/api/backoffice/*` route) 
  replaced the old model that trusted whatever `staffId` the client sent; 
  every Back Office route now re-derives identity from the cookie alone. 
  **Manager has NO Back Office access at all** (revoked — previously had 
  Staff Management only) and has no email/password/TOTP of any kind — 
  Manager's only staff-related capability is the POS quick-add below. 
  Owner/admin see Home, Staff Management, Menu Management and land on 
  Home. Cashier/kitchen are blocked with a message (they have no email 
  either, so there's no login path for them to even attempt). Home is 
  pure-display stat cards (sales summary, orders, avg order, **Total 
  Tips**, top sellers, staff performance) via `/api/backoffice/stats/*`, 
  with a Today/Week/Month range switcher; Reports/Orders sections not yet 
  added to the nav.
  - **First-time setup**: an owner/admin with no email/password yet 
    (currently true for all 3 owners + Test Admin — see staff accounts 
    below) enters their existing PIN once to prove identity (same trust 
    model as PIN login elsewhere — nothing new), then picks an email + 
    password, then scans a QR code to enroll a TOTP authenticator app 
    (Google Authenticator, Authy, 1Password, etc.). One correct 6-digit 
    code confirms setup, flips `totp_enabled`, and logs them in. An 
    interrupted setup (password saved but TOTP never confirmed) resumes 
    cleanly next login instead of getting stuck.
  - **Returning login**: email + password, then a 6-digit TOTP code. Both 
    steps are independently rate-limited.
  - **Forgot password**: emails a time-limited (1 hour), single-use reset 
    link via Resend (from `noreply@narcostacos.ca`, domain verified) to 
    the account's email. Always returns the same generic response whether 
    or not the email matches an account, so it can't be used to enumerate 
    who has Back Office access.
- **Manage Menu** — POS-reachable menu editor at `/manage-menu`, owner/admin 
  only, opened from Order Entry's account dropdown (full page, not a modal). 
  Renders the same `MenuManager` component and hits the same 
  `/api/backoffice/menu*` / `/api/backoffice/item-variants*` / 
  `/api/backoffice/modifier-groups*` / `/api/backoffice/modifier-options*` 
  routes as Back Office's Menu Management section — one editor, two entry 
  points, kept in sync automatically since it's the same component. 
  Shopify-product-editor-inspired: browsable category/item list on the 
  left, inline-editable detail panel on the right — name/description/
  price, variants table, **and modifier groups/options (full CRUD: 
  create/edit/deactivate/delete — previously view-only)**. No hard-delete 
  for menu items, or for modifier groups/options actually referenced by 
  order history (same "deactivate only" pattern as staff) — deleting a 
  group/option that's been used in a real order is blocked with a 409 
  suggesting deactivation instead; unused ones hard-delete normally. 
  86/Reactivate is the only lifecycle action for menu items themselves.
- **Staff management hierarchy** (enforced server-side in /api/backoffice/
  staff routes AND mirrored in UI button-hiding): only owners can act on 
  owner rows or assign the owner/admin role; owner+admin can act on admin 
  rows. Deactivation only (active=false), never hard-delete — staff rows are 
  referenced by historical orders. PINs: 4 digits, bcrypt-hashed server-side, 
  never returned/logged, unique among active staff (login matches globally). 
  The add/edit forms have an **email field**, but it's only shown/editable 
  when the selected role is owner or admin — structurally hidden for 
  manager/cashier/kitchen (those roles are simply never offered as options 
  when the field's visibility condition can be true, e.g. Manager's own 
  role dropdown never includes owner/admin in the first place).
- **Order Entry's "Staff Management" dropdown entry is role-branched**:
  - **Manager** — `POST /api/staff/quick-add` (deliberately separate from 
    `/api/backoffice/staff`, so it isn't swept up by the Back Office role 
    restriction below), owner/admin/manager. This is Manager's ONE 
    remaining staff capability, and their only POS-side admin capability 
    of any kind — Manager has no menu/modifier access and no Back Office 
    access at all: an add-only modal, unchanged since it was first built. 
    `StaffAddForm` (in `StaffManager.jsx`) is shared by this and the 
    owner/admin popup below via an `endpoint` prop — the email field 
    above never appears here for Manager, since their role options never 
    include owner/admin (server-side `assertRoleAssignable` blocks it 
    too, even if the client were tampered with).
  - **Owner/admin** — `StaffManagementModal.jsx`, a popup (not a page — 
    same interaction weight as the item customization modal), fully 
    self-contained and independent of Back Office: it does NOT wrap 
    `StaffManager` or call any `/api/backoffice/*` route. Instead it hits 
    dedicated POS routes (`GET /api/staff/roster`, 
    `PATCH /api/staff/:id/status`, `POST /api/staff/:id/reset-pin`) that 
    follow the exact same trusted-staffId pattern as 
    `POST /api/staff/quick-add` above — staffId comes from the client 
    (Order Entry's own logged-in staff object, no session cookie), and 
    the server re-derives that staffId's real role from the DB before 
    allowing anything. This exists specifically so an owner/admin who has 
    ONLY ever logged into Order Entry via PIN — never Back Office — can 
    still use it; the original version of this feature accidentally 
    required a separate Back Office login on the same device by reusing 
    the session-cookie routes, which was a bug, not a design choice. 
    Scope is deliberately smaller than Back Office's Staff tab: view 
    (active + inactive, dimmed if inactive) + add (reuses 
    `POST /api/staff/quick-add`, not duplicated) + deactivate/reactivate 
    + reset PIN. **No role or hourly-rate editing here** — that stays 
    Back-Office-only. Hierarchy protection (`canManageTarget`/
    `requireManagedTarget`, same functions Back Office's staff routes 
    use) is enforced server-side on every write and mirrored in the UI 
    (an admin sees no Reset PIN/Deactivate buttons on owner rows). Live 
    clock-in/break status per row is sourced by its own small helper 
    (`getLiveStatusByStaffId()`) rather than reusing 
    `GET /api/backoffice/staff/live-status`, to avoid touching the route 
    Back Office Home's Live Status card depends on. Back Office's own 
    `StaffManager.jsx`/`StaffManager.css` and `/api/backoffice/staff*` 
    routes are completely unchanged by this — full role/hourly-rate 
    editing stays there.
- Theme defaults to **Light**, only owners can toggle dark mode 
  (app-wide setting, in the account dropdown menu next to the staff name 
  on Order Entry — NOT visible to non-owner roles at all)

## Design system
- Brand red: `#E8442E` · success green: `#34A853`
- Fonts: `Archivo Black` (headlines), `Inter` (body), `IBM Plex Mono` 
  (numeric/status text) — Google Fonts
- Light theme (default): bg `#FAFAF9`, surface `#FFFFFF`
- Dark theme: bg `#111111`, surface `#1C1C1C`
- Official logo at `frontend/src/assets/narcos-tacos-logo.png`, used in 
  Order Entry top bar and PIN login screen
- PIN login uses circular Apple-Passcode-style keypad buttons
- Multi-quantity modifier options (e.g. Extra Taco) use a Shopify-style 
  pill stepper `(− count +)`, not checkboxes
- Cart panel on Order Entry is collapsible: slim ~75px strip by default, 
  auto-expands when an item is added, manually collapsible via chevron

## What's built and working
- Full schema, migrated, real 24-item menu seeded with variants/modifiers/
  addons/ingredient checklists
- Staff auth: PIN login (`POST /api/auth/login`) for Order Entry/KDS, all 
  roles; separate email+password+TOTP login for Back Office, owner/admin 
  only (see Auth model for both flows)
- Order Entry: real menu browsing, full item customization modal (variants, 
  modifier groups with min/max/required rules, addons, ingredient 
  checklists with default-checked items), working cart, cart-level 
  discounts (presets + custom %, required reason, server-recomputed), 
  checkout (`POST /api/orders`) with full server-side price + discount 
  recomputation and mocked Cash/Card payment
- KDS (`/kds/lawrence-east-4471`, no auth, opened once and left running): 
  live order queue polling every 5s (`GET /api/orders`), tap-to-advance 
  status (open → preparing → ready via `PATCH /api/orders/:id/status`), 
  color-escalating elapsed timers (green → yellow at 5min → red at 10min), 
  a Completed Orders history view (`GET /api/orders/history`), and 
  **Rush Hour** — a manual toggle that replaces the ticket grid with an 
  aggregated view: every unique item+variant+exact-modifier-
  combination across open/preparing orders, shown as one line with a 
  count, sorted count-descending. View-only (no tap targets) — completing 
  orders still happens in the normal ticket view; recomputed client-side 
  from the same polled data, no extra route
- Back Office (`/backoffice`): Home (sales summary, order count, avg 
  order, **Total Tips**, top sellers, staff performance — Today/Week/
  Month range switcher — plus **Live Status**, a read-only 5s-polled card 
  showing every currently-clocked-in staff member and how long they've 
  been Working/On Break, `GET /api/backoffice/staff/live-status`, owner/
  admin only), Staff Management (full CRUD, PIN reset, hierarchy-
  enforced, email field for owner/admin), Menu Management (full CRUD for 
  items, variants, AND modifier groups/options)
- Manage Menu (`/manage-menu`) — the same editor as Back Office's Menu 
  Management, reachable from the POS for owner/admin
- Order Entry's "Staff Management" dropdown entry, owner/admin — a 
  self-contained popup (`StaffManagementModal.jsx`) hitting dedicated 
  trusted-staffId POS routes (`GET /api/staff/roster`, 
  `PATCH /api/staff/:id/status`, `POST /api/staff/:id/reset-pin`), no 
  Back Office session/cookie dependency at all: list (active + inactive), 
  live clock-in/break status per row, add (reuses quick-add), 
  deactivate/reactivate, reset PIN — no role/hourly-rate editing (that 
  stays Back-Office-only). Hierarchy protection enforced both server-side 
  and in the UI. Manager keeps the original add-only quick-add modal, 
  unchanged
- Order Entry account dropdown, self-service, every role, no Back Office 
  equivalent for the actions themselves (works for cashier/kitchen too, 
  who have no Back Office access at all — Live Status above is read-only 
  visibility into the same state, not a duplicate control surface):
  - **Change PIN** (`PUT /api/staff/me/pin`) — current PIN required and 
    bcrypt-verified server-side; distinct from the manager+ 
    `PUT /api/backoffice/staff/:id/pin` route that resets SOMEONE ELSE's 
    PIN
  - **Clock In/Out** — a single contextual card (`ClockCard.jsx`) driven 
    by `GET /api/staff/me/clock-status` (`not_clocked_in` | `working` | 
    `on_break`, checked fresh every time the card opens): Start Shift; 
    or a running shift timer + End Shift/Take Break; or a running break 
    timer + End Break/End Shift (ending a shift directly from a break — 
    an emergency path — auto-closes the open break with the same 
    clock-out timestamp first, so a shift can never end with a break 
    still open). Every action (`POST /api/staff/me/clock-in`, 
    `.../clock-out`, `.../break-start`, `.../break-end`) requires the PIN 
    entered inline in the card, bcrypt-verified server-side same as PIN 
    login. Multiple breaks per shift, no limit.
  - **My Hours** (`GET /api/staff/me/hours?range=today|week|month`) — own 
    shift history + total WORKED hours (clocked time minus every break 
    within it), Today/Week/Month switcher matching Back Office Home's. 
    Always scoped to the calling staffId; no parameter broadens it to 
    anyone else's shifts
  - No manager editing/correction of punches, and clock status is NOT a 
    gate on order-taking — pure time-tracking layered on top of 
    PIN-based access

## What's NOT built yet
- Back Office Reports/Orders sections (not yet added to the nav)
- Real Stripe Terminal integration — payments are still mocked (Cash/Card 
  recorded, no processor), and there's no tip-collection UI anywhere on 
  the POS yet; both are deferred to this phase, when tipping will happen 
  on the physical terminal's own screen
- Staff accounts: 3 owners (Ali Barakat 1234, Umran Hanifi 1235, Saif Omar 
  1236) + test accounts Test Admin 5001, Test Manager 2001, Test Cashier 
  3001, Test Kitchen 4001 (seed_test_staff.sql). None of the owner/admin 
  accounts have completed Back Office first-time setup yet (no email/
  password/TOTP set) — each will hit the first-time setup flow on their 
  next Back Office visit.

## Workflow conventions
- Prompts should be scoped to one complete, testable slice of functionality 
  at a time — not everything at once
- Any database change goes through a `.sql` migration file saved in 
  `database/` (at the repo root, NOT under `backend/`), run via 
  `docker exec -i narcos_tacos_db psql -U narcos -d narcos_tacos < 
  database/file.sql` (or piped via `Get-Content ... | docker exec -i ...` 
  on Windows/PowerShell)
- After any backend code change, the dev server must actually pick it up — 
  if using `npm run dev` (which uses `--watch`), it auto-restarts; if it 
  was started with plain `node server.js`, it will NOT auto-restart and 
  needs a manual stop/restart
- Commit to git after each working milestone with a clear message
- Never commit `.env`, `node_modules`, exported reports/CSVs, or SQL dumps 
  (already covered in `.gitignore`)
- Production build should be verified clean (`npx vite build`) before 
  considering a frontend change done

## Known Gotchas
- **UTF-8 encoding risk on Windows:** piping SQL containing accented 
  characters (é, à, etc.) through PowerShell to `docker exec` has corrupted 
  them before (e.g. "Consomé" → "Consom??", "à la carte" → "?? la carte"). 
  When inserting or updating text with accented characters via this method, 
  verify the stored value afterward with a `SELECT` query before considering 
  the change done.
- **Render Static Site SPA routing:** a `frontend/public/_redirects` file 
  (Netlify-style `/*  /index.html  200`, copied into `dist/` by Vite) is 
  NOT on its own guaranteed to make Render serve `index.html` for every 
  client-side route — this broke KDS in production once (every route but 
  `/` 404'd on direct navigation/refresh). If it recurs, check that the 
  same rewrite rule is ALSO configured directly in the Render dashboard 
  (Static Site → Redirects/Rewrites), not just relying on the `_redirects` 
  file being auto-honored.
- **Render env vars + Vite builds:** `VITE_*` env vars (e.g. `VITE_API_URL`) 
  are baked into the JS bundle at BUILD time, not read at runtime. Changing 
  one in Render's dashboard does nothing until a fresh build/deploy is 
  manually triggered — unlike a backend service, where an env var change 
  alone can be enough. Also double-check the value has no trailing slash 
  (see `config.js`'s defensive strip) before assuming the env var itself 
  is the problem.