# Auth Model — Full Detail

Companion to the condensed **Auth model** section in `CLAUDE.md`. This
file carries the full narrative — exact routes, flows, and the design
decisions (including past bugs) behind them — for whichever surface you
need to touch. See `CLAUDE.md` first for the one-paragraph summary of
each; this is the "why" and "exactly how" behind it.

## Order Entry/KDS PIN login
Every staff member (owner/admin/manager/cashier/kitchen) has a unique
4-digit PIN, bcrypt-hashed, checked via `POST /api/auth/login`. This is
completely separate from Back Office's login below (different route,
different credentials, different session mechanism) and is unaffected by
anything there — including for owner/admin, who use their PIN here and
email+password+TOTP there.

**Role permissions**:
- **Owner**: full access, only role that can create staff/appoint
  admin/manager roles, can toggle app-wide light/dark theme
- **Admin**: can edit menu/prices, apply discounts, view full reports —
  cannot create staff or appoint roles
- **Manager**: can apply discounts/comps, void orders, shift-level
  reports — cannot touch menu/pricing
- **Cashier**: takes orders, can apply discounts (per business decision)
- **Kitchen**: KDS only

**Routing after login**: owner/admin/manager/cashier → `/order-entry`.
**Kitchen does NOT log in at all** — KDS is a no-auth "open book" screen
at a deliberately non-guessable route (`/kds/lawrence-east-4471`), meant
to be opened once on a kitchen device and left running indefinitely (now
also gated by device pairing — see `device-pairing.md`).

## Back Office
Separate route `/backoffice`, persistent sidebar nav (`NAV_ITEMS` config
in `BackOffice.jsx` — add future sections there, each with its own
allowed-roles list). **Owner/admin ONLY, authenticated via email +
password + TOTP 2FA** (`BackofficeLogin.jsx`) — NOT the PIN used above. A
real server-side session (httpOnly, signed JWT cookie, verified by
`requireBackofficeSession` on every `/api/backoffice/*` route) replaced
an old model that trusted whatever `staffId` the client sent; every Back
Office route now re-derives identity from the cookie alone.

**Manager has NO Back Office access at all** (revoked — previously had
Staff Management only) and has no email/password/TOTP of any kind —
Manager's only staff-related capability is the POS quick-add (see
below). Owner/admin see Home, Staff Management, Menu Management, Devices
and land on Home. Cashier/kitchen are blocked with a message (they have
no email either, so there's no login path for them to even attempt).

- **First-time setup**: an owner/admin with no email/password yet enters
  their existing PIN once to prove identity (same trust model as PIN
  login elsewhere — nothing new), then picks an email + password, then
  scans a QR code to enroll a TOTP authenticator app (Google
  Authenticator, Authy, 1Password, etc.). One correct 6-digit code
  confirms setup, flips `totp_enabled`, and logs them in. An interrupted
  setup (password saved but TOTP never confirmed) resumes cleanly next
  login instead of getting stuck.
- **Returning login**: email + password, then a 6-digit TOTP code. Both
  steps are independently rate-limited.
- **Forgot password**: emails a time-limited (1 hour), single-use reset
  link via Resend (from `noreply@narcostacos.ca`, domain verified) to
  the account's email. Always returns the same generic response whether
  or not the email matches an account, so it can't be used to enumerate
  who has Back Office access.

## Manage Menu
POS-reachable menu editor at `/manage-menu`, owner/admin only, opened
from Order Entry's account dropdown (full page, not a modal). Renders
the same `MenuManager` component and hits the same `/api/backoffice/
menu*` / `/api/backoffice/item-variants*` / `/api/backoffice/modifier-
groups*` / `/api/backoffice/modifier-options*` routes as Back Office's
Menu Management section — one editor, two entry points, kept in sync
automatically since it's the same component. Shopify-product-editor-
inspired: browsable category/item list on the left, inline-editable
detail panel on the right — name/description/price, variants table, and
modifier groups/options (full CRUD: create/edit/deactivate/delete). No
hard-delete for menu items, or for modifier groups/options actually
referenced by order history (same "deactivate only" pattern as staff) —
deleting a group/option used in a real order soft-deactivates instead;
unused ones hard-delete normally. 86/Reactivate is the only lifecycle
action for menu items themselves.

## Staff management hierarchy
Enforced server-side in `/api/backoffice/staff` routes AND mirrored in
UI button-hiding: only owners can act on owner rows or assign the
owner/admin role; owner+admin can act on admin rows. PINs: 4 digits,
bcrypt-hashed server-side, never returned/logged, unique among active
staff (login matches globally). The add/edit forms have an **email
field**, but it's only shown/editable when the selected role is owner or
admin — structurally hidden for manager/cashier/kitchen (those roles are
simply never offered as options when the field's visibility condition
can be true, e.g. Manager's own role dropdown never includes
owner/admin in the first place).

**Smart deletion** (added after the original deactivation-only model):
attempting to remove a staff member checks for any real history (orders
placed, shifts clocked). Zero history → genuine hard `DELETE`. Any
history → forced deactivation (`active=false`) instead, with a message
explaining why, same UI action either way — the caller can't tell which
happened without checking. The exact same pattern now applies to
`device_pairings` rows (see `device-pairing.md`).

## Order Entry's "Staff Management" dropdown entry (role-branched)
- **Manager** — `POST /api/staff/quick-add` (deliberately separate from
  `/api/backoffice/staff`, so it isn't swept up by the Back Office role
  restriction above), owner/admin/manager. This is Manager's ONE
  remaining staff capability, and their only POS-side admin capability
  of any kind — Manager has no menu/modifier access and no Back Office
  access at all: an add-only modal. `StaffAddForm` (in
  `StaffManager.jsx`) is shared by this and the owner/admin popup below
  via an `endpoint` prop — the email field above never appears here for
  Manager, since their role options never include owner/admin
  (server-side `assertRoleAssignable` blocks it too, even if the client
  were tampered with).
- **Owner/admin** — `StaffManagementModal.jsx`, a popup (not a page —
  same interaction weight as the item customization modal), fully
  self-contained and independent of Back Office: it does NOT wrap
  `StaffManager` or call any `/api/backoffice/*` route. Instead it hits
  dedicated POS routes (`GET /api/staff/roster`, `PATCH /api/staff/:id/
  status`, `POST /api/staff/:id/reset-pin`, `DELETE /api/staff/:id`)
  that follow the exact same trusted-staffId pattern as `POST /api/
  staff/quick-add` above — staffId comes from the client (Order Entry's
  own logged-in staff object, no session cookie), and the server
  re-derives that staffId's real role from the DB before allowing
  anything. This exists specifically so an owner/admin who has ONLY
  ever logged into Order Entry via PIN — never Back Office — can still
  use it; the original version of this feature accidentally required a
  separate Back Office login on the same device by reusing the
  session-cookie routes, which was a bug, not a design choice. Scope is
  deliberately smaller than Back Office's Staff tab: view (active +
  inactive, dimmed if inactive) + add (reuses `POST /api/staff/quick-
  add`, not duplicated) + deactivate/reactivate/delete + reset PIN. **No
  role or hourly-rate editing here** — that stays Back-Office-only.
  Hierarchy protection (`canManageTarget`/`requireManagedTarget`, same
  functions Back Office's staff routes use) is enforced server-side on
  every write and mirrored in the UI (an admin sees no Reset PIN/
  Deactivate buttons on owner rows). Live clock-in/break status per row
  is sourced by its own small helper (`getLiveStatusByStaffId()`) rather
  than reusing `GET /api/backoffice/staff/live-status`, to avoid
  touching the route Back Office Home's Live Status card depends on.

## PIN reset — two distinct flows
- **Self-service Change PIN** (`PUT /api/staff/me/pin`) — current PIN
  required and bcrypt-verified server-side; old + new + confirm.
- **Admin resetting SOMEONE ELSE's PIN** (`PUT /api/backoffice/staff/
  :id/pin` from Back Office, or `POST /api/staff/:id/reset-pin` from the
  POS popup) — deliberately just New + Confirm, no "current PIN" field,
  since the person resetting it doesn't (and shouldn't need to) know the
  old one. Both require a confirmation step naming the affected staff
  member before submitting.

## Order Entry account dropdown — self-service (every role)
No Back Office equivalent for the actions themselves — works for
cashier/kitchen too, who have no Back Office access at all.
- **Change PIN** — see above.
- **Clock In/Out** — a single contextual card (`ClockCard.jsx`) driven
  by `GET /api/staff/me/clock-status` (`not_clocked_in` | `working` |
  `on_break`, checked fresh every time the card opens): Start Shift; or
  a running shift timer + End Shift/Take Break; or a running break timer
  + End Break/End Shift (ending a shift directly from a break — an
  emergency path — auto-closes the open break with the same clock-out
  timestamp first, so a shift can never end with a break still open).
  Every action (`POST /api/staff/me/clock-in`, `.../clock-out`,
  `.../break-start`, `.../break-end`) requires the PIN entered inline in
  the card, bcrypt-verified server-side same as PIN login. Multiple
  breaks per shift, no limit.
- **My Hours** (`GET /api/staff/me/hours?range=today|week|month`) — own
  shift history + total WORKED hours (clocked time minus every break
  within it), Today/Week/Month switcher matching Back Office Home's.
  Always scoped to the calling staffId; no parameter broadens it to
  anyone else's shifts.
- No manager editing/correction of punches, and clock status is NOT a
  gate on order-taking — pure time-tracking layered on top of
  PIN-based access.

## Theme
Defaults to **Light**, only owners can toggle dark mode (app-wide
setting, in the account dropdown menu next to the staff name on Order
Entry — NOT visible to non-owner roles at all).
