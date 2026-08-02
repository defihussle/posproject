# Device Pairing — Full Detail

Companion to the condensed **Device pairing** bullet in `CLAUDE.md`'s
Auth model section. Adds a device-trust layer UNDERNEATH staffId/PIN
identity — orthogonal to who's logged in, this is about whether the
physical tablet itself was ever authorized by an owner/admin. Migration:
`database/device_pairing.sql`.

## Why
Before this, Order Entry and KDS were reachable by anyone with the URL —
KDS in particular has no staff auth at all by design (a deliberate
"open book" screen at a non-guessable route, meant to be opened once and
left running). A lost/shared tablet link meant unlimited PIN attempts
against Order Entry, and unrestricted access to KDS. Device pairing adds
a one-time-per-device gate in front of both.

## Schema — `device_pairings`
One row per pairing lifecycle, covering both the pending-code stage and
the paired-device stage:
- `device_id` (UUID, pre-allocated at code-generation time — it's just a
  random identifier, nothing device-specific about it yet)
- `device_name` — NULL until redeemed; a device has no name until a
  human sitting at it types one in
- `pairing_code_hash` — SHA-256 of the raw code, same pattern as
  `staff.reset_token`; the raw code only ever exists in the generate-
  code HTTP response and the pair request body, never persisted
- `code_expires_at`, `paired_at` (NULL until redeemed, set exactly once
  — a code is single-use by construction: the pairing endpoint's WHERE
  clause requires `paired_at IS NULL`, so a used code can never validate
  again regardless of `code_expires_at`)
- `created_by`, `revoked_at`, `revoked_by`, `last_seen_at`
- `last_order_entry_at`, `last_kds_at` (migration:
  `database/device_connection_tracking.sql`) — `last_seen_at` only says
  "this device made *some* gated request"; these split it by surface so
  Back Office's device list can show what a device is actually being used
  for. `requireDevicePairing` stamps `last_seen_at` plus exactly one of
  these on every pass, chosen by `surfaceColumnForRequest()`. That
  classifier is a **denylist, not an allowlist**: `POST /api/auth/login`
  and `POST /api/orders` are Order Entry, and *everything else gated*
  falls through to `last_kds_at`. For the dedicated tablets this POS runs
  on, a non-NULL value maps to the device's real role — but the fallback
  is worth knowing about before adding a gated route (see the list below)
- Rows are never deleted, including revoked ones — this table IS the
  audit trail (who generated a code, when/whether it was redeemed, who
  revoked it and when), same "never hard-delete history" spirit as
  staff/shifts elsewhere in this schema.

## Backend endpoints
- `POST /api/backoffice/devices/generate-code` — owner/admin, session-
  cookie authenticated, rate-limited (reuses the app's existing
  `checkRateLimit`/`recordFailedAttempt` sliding-window counter, keyed
  by requester id — repurposed here as a generic throttle rather than a
  literal "wrong guess" counter, since generating a code always
  succeeds). Returns the raw code exactly once.
- `POST /api/devices/pair` — public (a device isn't authenticated as
  anything yet), body `{ code, deviceName }`, rate-limited by the
  submitted code value (same principle as PIN login: key by the
  identity being guessed, not IP). Generic error message on any failure
  reason (unknown/expired/already-used/revoked all look identical).
- `GET /api/backoffice/devices` — owner/admin, lists every device that
  completed pairing (active AND revoked); pending/never-redeemed codes
  are excluded, they're not a "device" yet.
- `PUT /api/backoffice/devices/:id` — owner/admin, rename only.
- `POST /api/backoffice/devices/:id/revoke` — owner/admin. Idempotency
  guard means re-revoking an already-revoked row 404s instead of
  silently overwriting who/when it was originally revoked.
- `GET /api/devices/me` — public, lets the frontend check pairing status
  on load without provoking a 401.

## Server-side enforcement
The frontend route guard (`RequireDevicePairing`) is only the visible
half; the real gate is the `requireDevicePairing` middleware, attached to
exactly the server-side surface of the two device-gated screens so a
direct API call can't bypass an unpaired browser:
- `POST /api/auth/login` — Order Entry PIN entry (the original threat:
  unlimited PIN attempts from a lost/shared tablet link)
- `POST /api/orders` — Order Entry checkout
- `GET /api/orders`, `GET /api/orders/history` — KDS board + history
- `PATCH /api/orders/:id/status`, `.../status/revert` — KDS advance /
  recall
- `GET /api/orders/pos-recall` — Order Entry's order-recall list (order
  totals, line items and prior refund history; the same "don't hand the
  day's sales to an unpaired browser" reasoning as the routes above)
- `POST /api/orders/:id/refund` — POS void/refund. Device pairing is the
  outer gate here; the real authorization is the dual-control approver
  PIN inside the request (`features.md` → Refunds & Voids)
- `GET /api/staff/approvers` — the eligible-approver name list the POS
  reversal flow picks from (a staff roster, so it stays behind the gate)
- `POST /api/orders/:id/acknowledge-void` — KDS dismissing a VOIDED
  ticket. Like the rest of KDS it has **no staff auth at all**; device
  pairing is its only gate, which is exactly why the acknowledgement is
  idempotent and carries no identity

Back Office's own routes are deliberately NOT device-gated — an owner
manages devices/staff/menu from any browser (guarded by the Back Office
session cookie), not from a paired tablet. An unpaired request to any
gated route returns 401, which the frontend surfaces as the pairing
screen. Wiring this middleware and the frontend guards landed in the same
pass so the cutover was atomic — never a state where the gate existed on
one side only. The middleware also refreshes `last_seen_at` on every pass
(fire-and-forget), so Back Office's device list reflects real activity and
a revoked device is caught on its very next request, not just at cookie
expiry.

## Cookie strategy
Pairing issues a signed JWT (`{ deviceId, purpose: "device" }`) in an
httpOnly, Secure cookie, mirroring the Back Office session cookie's
already-solved cross-domain setup (`sessionCookieOpts` — same
frontend/backend split, same Safari cross-site quirks) rather than
duplicating that logic. Signed with a dedicated `DEVICE_SECRET`
(separate from `SESSION_SECRET`) so a leak of one doesn't compromise the
other token type.

**Expiry is deliberately long** (1 year) — physical possession of the
tablet is the real security boundary, not the token's clock. Immediate
revocation is instead handled by re-checking the database on every
check-in: `resolveDeviceId()` requires `paired_at IS NOT NULL AND
revoked_at IS NULL` on every call, not just JWT signature validity. This
mirrors how Back Office sessions already work (`requireBackofficeSession`
re-looks-up the staff row and checks `active = true`, not just JWT
validity).

## Frontend
- `DevicePairingScreen.jsx` — full-screen form (code + device-name
  fields), reuses `PinLogin.css`'s shell (`.login-screen`/`.login-card`/
  `.brand-logo`/`.login-footer`) for visual consistency with the PIN
  login and Back Office login screens.
- **Device naming** — pre-filled with a best-effort guess parsed from
  `navigator.userAgent` (e.g. "iPad · Safari"), but always human-edited
  before submitting. There is no web API that can read a device's real
  OS-level name (the "Omer's iPhone" shown in iOS Settings/Bluetooth) —
  that's native-app-only, never exposed to a browser tab. This is the
  same approach Square/Toast/Clover/Shopify POS all use: an admin-
  assigned terminal name, not an auto-detected device name.
- `RequireDevicePairing.jsx` — route guard wrapping `/order-entry` and
  the KDS route in `App.jsx`. Calls `GET /api/devices/me` once on mount.
  Status machine deliberately never "fails open": a network/server error
  while checking does NOT fall through to either "paired" or "unpaired"
  — it shows "Connection error — retrying…" and polls every 5s. This
  matters specifically for KDS, which runs unattended for hours; a brief
  Wi-Fi blip shouldn't bounce an already-paired screen back to the
  pairing form, but a failure to confirm pairing must also never
  silently grant access.
- `DeviceManager.jsx` (Back Office → Devices) — Shopify-style list +
  detail modal, same pattern as `StaffManager.jsx`/`MenuManager.jsx`.
  Floating "+ Generate Pairing Code" action shows the code with a live
  countdown; on expiry, flips to "Generate Another" rather than closing
  itself out from under an admin mid-read.

## A real bug found during implementation (fixed)
The first draft fetched the pairing code from inside a `useEffect` on
the generate-code modal's mount. React 18 `StrictMode` (enabled in
`main.jsx`) double-invokes effects in development, and since that
`fetch` wasn't idempotent, one FAB click silently created two server-
side rows — confirmed against the database (an orphaned, nameless
pending row alongside the real one). **Fix**: moved the actual
`POST /generate-code` call out of the modal entirely and into
`DeviceManager`'s FAB `onClick` handler — event handlers are never
double-invoked by StrictMode, only effects are. The modal is now purely
presentational (code/expiry in as props, an `onGenerateAnother`
callback out); its own internal effect only runs a countdown timer,
which is safe to double-fire since it has no server-side side effect.
**Lesson**: any non-idempotent side effect (POST/PATCH/DELETE that
creates or mutates a row) triggered from a mount effect is a latent
StrictMode bug — tie it to a real user gesture instead.

## Known limitation (planned follow-up)
KDS's device-pairing check currently only happens once, on page load —
there's no live re-poll while it's running. A mid-shift revocation
therefore doesn't kick KDS out until its next manual reload, unlike
Order Entry (re-checked on every page load, which happens more often).
The plan is to piggyback a lightweight device-status check onto KDS's
existing 5s order-polling loop (e.g. once a minute) rather than adding a
second timer, so a revoked KDS device is caught within roughly one
polling cycle instead of requiring physical intervention.

## Smart deletion parity with staff
`DELETE /api/backoffice/staff/:id` and the device revoke/delete flow
follow the same "hard-delete if no real history, else force-deactivate"
decision (see `auth-model.md`'s Staff management hierarchy section) —
for devices, "history" is simply whether the row has ever completed
pairing. In practice devices are always revoked (soft), never hard-
deleted through the UI, since a paired row by definition has history
(it was used); the shared pattern exists mainly for consistency and
because the underlying `device_pairings` audit-trail philosophy matches
staff's exactly.
