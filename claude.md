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
      components/        — PinLogin.jsx, OrderEntry.jsx, ItemModal.jsx, 
                            Dashboard.jsx (also doubles as KDS placeholder), 
                            BackOffice.jsx
      assets/             — narcos-tacos-logo.png (official brand logo, 
                            transparent background)
      App.jsx             — routing + auth/theme state
```

## Database schema — key tables
- `locations` — id, name, tax_rate, timezone
- `staff` — id, location_id, name, title, phone, email, photo_url, pin_hash 
  (bcrypt via pgcrypto), role (enum: `owner`, `admin`, `manager`, `cashier`, 
  `kitchen`), hourly_rate, hire_date, active
- `shifts` — clock in/out records (not yet wired to any UI)
- `menu_categories`, `menu_items`, `item_variants` (e.g. protein choices, 
  each with own absolute price), `modifier_groups`, `modifier_options` 
  (has `max_quantity` for stepper-style multi-select, `default_selected` 
  for standard/included ingredients), `item_modifier_groups` (join), 
  `item_addons` (items bundled free with another item, e.g. Consomé with 
  Birria Tacos, also independently sellable)
- `ingredients`, `item_ingredients`, `modifier_ingredients` — ingredient-level 
  inventory (schema exists, not yet actively used in UI)
- `orders` — status enum: `open`, `preparing`, `ready`, `completed`, 
  `cancelled`
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

## Auth model
- Every staff member (owner/admin/manager/cashier/kitchen) has a unique 
  4-digit PIN, bcrypt-hashed, checked via `POST /api/auth/login`
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
- **Back Office** — separate route `/backoffice`, own PIN login, persistent 
  sidebar nav (`NAV_ITEMS` config in `BackOffice.jsx` — add future sections 
  there, each with its own allowed-roles list). Owner/admin see Home, Staff 
  Management, Menu Management and land on Home. **Managers see Staff 
  Management ONLY — Home is hidden from their nav entirely, not just 
  blocked** — and land there directly. Cashier/kitchen blocked with a 
  message. Home is pure-display stat cards (sales summary, top sellers, 
  staff performance) via `/api/backoffice/stats/*` (owner/admin only, 
  role checked server-side); Reports/Orders sections not yet added to the 
  nav.
- **Staff management hierarchy** (enforced server-side in /api/backoffice/
  staff routes AND mirrored in UI button-hiding): only owners can act on 
  owner rows or assign the owner/admin role; owner+admin can act on admin 
  rows; owner/admin/manager can act on manager/cashier/kitchen rows. 
  Deactivation only (active=false), never hard-delete — staff rows are 
  referenced by historical orders. PINs: 4 digits, bcrypt-hashed server-side, 
  never returned/logged, unique among active staff (login matches globally).
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
- Staff auth (PIN login) for owner/admin/manager/cashier roles
- Order Entry: real menu browsing, full item customization modal (variants, 
  modifier groups with min/max/required rules, addons, ingredient 
  checklists with default-checked items), working cart

## What's NOT built yet (as of this file's creation)
- Checkout / order persistence (`POST /api/orders`) — in progress
- KDS real build (`GET /api/orders`, `PATCH /api/orders/:id/status`, the 
  actual KDS screen)
- Back Office Reports/Orders sections (not yet added to the nav). Home 
  dashboard, Menu editing, and Staff management ARE built (Home/Menu/Staff 
  nav sections + /api/backoffice/* routes with server-side role checks; 
  staff also quick-addable from the Order Entry account dropdown for 
  owner/admin/manager)
- Real Stripe Terminal integration
- Change-PIN self-service flow (managers+ can reset PINs via Staff tab; 
  self-service for cashiers not built)
- Staff accounts: 3 owners (Ali Barakat 1234, Umran Hanifi 1235, Saif Omar 
  1236) + test accounts Test Admin 5001, Test Manager 2001, Test Cashier 
  3001, Test Kitchen 4001 (seed_test_staff.sql)

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