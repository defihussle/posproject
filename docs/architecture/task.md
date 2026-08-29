# Clover Mini Semi-Integration — Task Checklist

The slice checklist. Decisions and context live in
[docs/architecture/plan.md](plan.md). Read both at the start of every session.

**Current slice: Phase 2 — provider enum + per-payment refund dispatch.**
Stays the current slice until the human confirms it. Phase 2 needs **no
migration and no deploy** — it is code-only and inert until someone sets
`PAYMENTS_PROVIDER=clover`, which nobody has.

---

## Agent rules — read before touching anything

1. **Read [plan.md §2 "Locked decisions"](plan.md) first.** Those are settled.
   Implement them; do not re-open them.
2. **One slice at a time.** Do only the phase marked *current slice* above, then
   stop and report. Do not start the next phase because it "looks easy".
3. **No secrets, ever.** No Clover App Secret, Stripe key, or access token in
   git, in a doc, or in chat. Env var **names** go in `.env.example`; values go
   in local env / Render only.
4. **Schema Change Checklist is mandatory** (see `CLAUDE.md`). For any new Clover
   column or table, in this order:
   1. Write a **new** `.sql` file in `database/` (repo root, not `backend/`).
   2. `cd backend && npm run schema:sync`, commit the regenerated
      `backend/schema-requirements.json` **in the same commit as the `.sql`**.
   3. Apply it to **production**.
   4. Verify against **production** — must print `Schema OK`.
   5. **Only then** push/deploy the code that depends on it.
   Local Docker is never production. No exemption for a "small" migration.
5. **Stop on open questions instead of guessing hardware.** If the work depends
   on Mini 2 vs Mini 3, the exact Cloud Pay Display endpoints, or which merchant
   — ask the human. Do not invent Clover endpoint URLs.
6. **Do not change production payments** until a human asks. The live site keeps
   its current flows.
7. **Do not delete or disable Stripe code.** Old Stripe charges must stay
   refundable.
8. Verify `npx vite build` is clean before calling any frontend change done.

---

## Phase 0 — Organize ✅ complete

- [x] Locate the existing docs folder (`docs/architecture/`) — no second docs tree
- [x] Write `docs/architecture/plan.md` (goal, locked decisions, what exists,
      target flow, conflicts, sandbox status, phases, open questions, agent
      rules, HANDOFF KEY appendix)
- [x] Write `docs/architecture/task.md` (this file)
- [ ] Human reviews both docs and confirms the locked decisions are correct

**Done when:** both files exist under `docs/architecture/`, the locked-decisions
table matches what the human actually decided, and the HANDOFF KEY block is
complete enough that a cold agent can pick up Phase 1 from it alone.

**Out of scope:** any application code, any schema change, any `.env` value, any
Clover API call, any change to `CLAUDE.md`.

---

## Phase 1 — OAuth callback + token store + merchant ping ✅ code complete

Local test steps: [clover-mini-phase1.md](clover-mini-phase1.md)

- [x] Add `GET /api/clover/oauth/callback` — the route Clover already redirects to
- [x] Exchange the OAuth **code** for a token server-side (response type is Code,
      not Token) — `exchangeCloverCode()`, v2 endpoint first with a v1 fallback
- [x] Write the migration `database/clover_oauth.sql` (new table
      `clover_oauth_tokens`) + `npm run schema:sync` (Checklist steps 1–2)
- [ ] **Apply `database/clover_oauth.sql` to PRODUCTION** — Checklist step 3.
      **NOT DONE** — no Render External Database URL available in this environment.
- [ ] **Verify `Schema OK` against PRODUCTION** — Checklist step 4. **NOT DONE.**
- [ ] **Push/deploy the dependent code** — Checklist step 5. Deliberately
      **NOT DONE**: the boot guard `process.exit(1)`s when a required table is
      missing, so pushing before the two steps above would take the live API down.
- [x] Add env var **names** to `.env.example`: `CLOVER_APP_ID`,
      `CLOVER_APP_SECRET`, `CLOVER_RAID`, `CLOVER_MERCHANT_ID`, `CLOVER_API_BASE`
      — names only, no values
- [x] Add a read-only **`GET` merchant ping** proving the token works against
      `https://apisandbox.dev.clover.com` — `cloverMerchantPing()`, run
      automatically at the end of a successful callback
- [x] Add `GET /api/clover/status` — `{ configured, merchantId, tokenPresent,
      lastMerchantPing }`; no token, no secret
- [x] Everything behind flags — verified by booting with and without credentials:
      no throw, logs `Clover: not configured`, no existing flow changed
- [ ] **End-to-end Preview → Connect with the real App Secret** — needs the
      human: Docker Desktop was not running and the App Secret is not in this
      environment. Steps are in `clover-mini-phase1.md` §6.

**Done when:** connecting the draft app from App Market Preview lands on our
callback, a token is stored, and the merchant ping returns the sandbox merchant —
with `PAYMENTS_PROVIDER` still `mock` on production and no checkout behaviour
changed anywhere.

**Out of scope:** `provider=clover` going live · any charge · any Cloud Pay
Display call · touching `isStripeCardCheckout()` · any UI.

---

## Phase 2 — Provider enum + per-payment refund dispatch ← **CURRENT SLICE**

Design rationale: [plan.md §5 "Phase 2 note"](plan.md).

- [x] Extend the provider enum to `mock | stripe | clover` — all three boot; an
      unrecognised value still throws with the updated list
- [x] `isStripeCardCheckout()` **unchanged** — still requires `provider ===
      "stripe"`; added `isCloverCardCheckout()` as a separate twin rather than
      widening it
- [x] Card under `clover` returns **501** and never falls through to the mocked
      path — verified end-to-end: no order, no payment, no `pending_checkouts` row
- [x] Refunds dispatch **per payment row** via `paymentProcessorOf()` — the
      processor is read off the row, never off `PAYMENTS_PROVIDER`
- [x] Old Stripe rows keep refunding through Stripe even when
      `PAYMENTS_PROVIDER=clover` — verified against a real DB row: settlement
      `stripe_api`, identical under `mock` and `clover`
- [x] A Clover-shaped row returns `clover_api` and is refused **501 before
      anything is written** (Clover refunds are Phase 4)
- [x] Cash refunds, dual-control, PIN and the $100 threshold untouched —
      `refundMethod: 'cash'` still short-circuits to `internal_cash`
- [x] **No new schema** — processor inferred from existing `processor_txn_id`.
      Schema Change Checklist therefore does not apply to this slice.
- [x] Confirmed `settledPaymentsWhere()` / `settledRefundsWhere()` are untouched
      and purely status-based (`captured`/`refunded`) — processor-agnostic, not
      narrowed to Stripe
- [x] Fixed the same env-flag-vs-row bug in the two receipt paths, so an old
      Stripe charge stays emailable after a switch to Clover
- [ ] **Human confirms** — then this becomes Phase 3's slice

**Done when:** `mock` and `stripe` behave **exactly** as before, `clover` is an
accepted value that boots cleanly, and a refund on a historical Stripe payment
still goes to Stripe.

**Out of scope:** taking a Clover payment · the waiting UI · Interac rules ·
production flag changes.

**Deploy note:** code-only, no migration. Inert until someone sets
`PAYMENTS_PROVIDER=clover`; Render env is unchanged and still `mock`/`stripe`.

---

## Phase 3 — Cloud Pay Display checkout

- [ ] **Confirm the current Cloud Pay Display endpoint set with the human first**
      — do not invent URLs
- [ ] Server prices and freezes the cart before the charge
      (`pending_checkouts` pattern)
- [ ] Backend starts the payment on the Mini via Clover's cloud
- [ ] POS waiting UI with explicit **success / failure / cancel** states
- [ ] On-device tip captured; `orders.total` tip-inclusive;
      `payments.amount == orders.total` asserted at insert
- [ ] Order materialized **only** on payment success; ticket goes to KDS
- [ ] Decline / cancel / abandon leaves **no order row**; the frozen cart is
      released and staff can retry
- [ ] A Clover completion path plus a safety-net reconcile (Clover's own, not a
      Stripe PaymentIntent retrieve)

**Done when:** a sandbox card payment started from Order Entry appears on the
Mini, completes with a tip, materializes exactly one order that reaches KDS, and
a cancelled payment leaves nothing behind.

**Out of scope:** refunds · Interac cash-out · reports · production.

---

## Phase 4 — Refunds, Interac, reports

- [ ] Clover refunds behind the existing dual-control / PIN / **$100 threshold**
      rules
- [ ] Tip-aware refund math preserved — `refundableBase = total − tip`
- [ ] Interac to-card vs cash-out rules applied to the Clover path
- [ ] **The Stripe refund path keeps working for old rows** (plan.md L7)
- [ ] Clover rows reconcile in every report through the existing ledger helpers

**Done when:** full, partial-$ and line-item refunds work on a Clover sale, an
old Stripe sale still refunds via Stripe, and Sales Summary / Transaction Log /
Refunds Report all net the same money.

**Out of scope:** production go-live · buying hardware.

---

## Phase 5 — Second Mini, soak, go live

- [ ] **Resolve Mini 2 vs Mini 3** — serial under the paper roll: `C032` = Mini 2,
      `C035` = Mini 3
- [ ] Acquire the **second Mini** for Narcos testing — do **not** share the
      owner's existing Mini across two POS systems
- [ ] Bind the device in Back Office → Devices (note: reader validation currently
      expects a `tmr_` id — plan.md §5)
- [ ] Move the Site URL from `http://localhost:4000` to
      `https://api.narcostacos.ca/api/clover/oauth/callback`
- [ ] Promote the app from draft to a production app; connect the real Narcos
      merchant
- [ ] Parallel soak alongside the current flow
- [ ] **Human signoff before production payments change**

**Done when:** a real card is charged on the Narcos merchant through the second
Mini, reconciles in reports, and the human has explicitly signed off on flipping
production.

**Out of scope:** flipping production without that signoff — never.
