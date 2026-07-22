# What's Built — Full Detail

Companion to the condensed **What's built** section in `CLAUDE.md` —
exact routes, algorithms, and state machines behind each feature.
Self-service account actions (Change PIN, Clock In/Out, My Hours) are
documented in `auth-model.md` instead, since they're fundamentally part
of the PIN/session model rather than a standalone feature area.

## Core data
Full schema, migrated, real 24-item menu seeded with variants/modifiers/
addons/ingredient checklists.

## Order Entry
Real menu browsing, full item customization modal (variants, modifier
groups with min/max/required rules, addons, ingredient checklists with
default-checked items), working cart, cart-level discounts (presets +
custom %, required reason, server-recomputed), checkout
(`POST /api/orders`) with full server-side price + discount
recomputation and mocked Cash/Card payment.

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

## Back Office (`/backoffice`)
- **Home** — sales summary, order count, avg order, Total Tips, top
  sellers, staff performance, Today/Week/Month range switcher, plus
  **Live Status**, a read-only 5s-polled card showing every currently-
  clocked-in staff member and how long they've been Working/On Break
  (`GET /api/backoffice/staff/live-status`, owner/admin only)
- **Staff Management** — full CRUD, PIN reset, hierarchy-enforced, email
  field for owner/admin, smart deletion (see `auth-model.md`)
- **Menu Management** — full CRUD for items, variants, AND modifier
  groups/options
- **Devices** — generate pairing codes, list/rename/revoke paired
  devices (see `device-pairing.md`)

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
