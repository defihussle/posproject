# Clover Mini Semi-Integration — Plan

**Living source of truth** for the Clover Mini workstream. Decisions and context
live here; the slice checklist lives in
[docs/architecture/task.md](task.md). Read both at the start of every session.

**Status:** Phase 0 (docs only) · **Created:** 2026-08-27 · **Owner:** @defihussle

> Terminology, one line each:
> - **Semi-integration** — the payment terminal only takes the money; our POS
>   keeps the menu, cart, prices and receipts.
> - **Cloud Pay Display** — Clover's cloud relay: our server calls Clover's
>   cloud, Clover's cloud pushes the amount down to the Mini.
> - **OAuth** — the "Connect this app to my store" handshake that gives our
>   server an access token for a merchant.

---

## 1. Goal

Turn the Clover Mini into a dumb payment terminal driven by Narcos POS, so staff
build the cart in Order Entry and the Mini simply shows the amount for
chip/tap/PIN/tip — nobody retypes a price.

---

## 2. Locked decisions — do not re-litigate

| # | Decision | Note |
| --- | --- | --- |
| L1 | Continue the Clover Mini semi-integration. **Do NOT restart Stripe Terminal as the hardware path.** | The direction is settled. |
| L2 | **Narcos POS is the system of record** — menu, cart, pricing, KDS, staff, reports, refunds. | Clover never owns the order. |
| L3 | **Clover Mini is a payment terminal only.** | No menu, no cart, no items on the Mini. |
| L4 | **Primary path: Clover Cloud Pay Display** (Render backend → Clover cloud → Mini). | |
| L5 | **Do NOT use Secure Network Pay Display as the primary path.** | Render cannot reach the store LAN. |
| L6 | **The server computes and authorizes the amount.** The browser is not the source of truth for the charge. | Same rule the Stripe path already follows. |
| L7 | **Stripe code stays.** Historical Stripe charges must refund via Stripe APIs based on that payment row — not only on the current env flag. | Deleting Stripe would strand old refunds. |
| L8 | Provider target is `mock \| stripe \| clover`. | Today boot **throws** on any `PAYMENTS_PROVIDER` value other than `mock\|stripe`; `isStripeCardCheckout()` is the gate. |
| L9 | **Production payments do not change until a human asks.** | The live site keeps its current flows. |
| L10 | **Secrets never in git or chat.** | Names in `.env.example` only; values in env / Render. |
| L11 | **A second Mini for Narcos testing.** Do not share the owner's existing Mini across two POS systems. | |
| L12 | The Clover app **stays draft**. Install via App Market Preview → Connect. | |

---

## 3. What already exists — PRESERVE, do not break

### POS features already shipped

Order Entry · KDS · Back Office · tablet/device pairing · multi-location prep ·
reports · refunds with dual-control / PIN / $100 threshold · receipts ·
Interac refund and cash-out rules.

### The Stripe chapter — reuse the patterns, keep the code

These are the hard-won mechanics. Clover must inherit the *shape* of each, even
where the API underneath differs:

| Thing to preserve | Why it matters |
| --- | --- |
| `pending_checkouts` — freeze the cart **before** the charge | The server-priced cart is frozen; nothing can drift mid-payment. |
| **Order materialization only after payment success** | A decline or an abandoned tap leaves no order row anywhere. |
| **On-device tipping**; `orders.total` is tip-inclusive; `payments.amount == orders.total` | Invariant asserted in code at insert time. Clover tips on the Mini the same way. |
| **Tip-aware refund math** — `refundableBase = total − tip` | A refund must never hand back the tip as if it were sale revenue. |
| **Interac to-card vs cash-out**, plus dual-control / PIN / $100 threshold | Interac requires the physical card present; the cash-out branch and the approval rules carry over unchanged. |
| **Reconcile sweep idea** | Clover needs its **own** completion path plus a safety-net reconcile — *not* a Stripe PaymentIntent retrieve. |
| Ledger helpers `settledPaymentsWhere()` / `settledRefundsWhere()` | One predicate nets refunds across every report. Clover rows must flow through the same helpers. |
| **Stripe files, webhooks, simulated `tmr_` readers — do not delete** | Old Stripe charges still need a live refund path (L7). |

---

## 4. Target flow

1. Staff build the cart in Order Entry on the POS tablet. Prices come from our
   menu, exactly as they do today.
2. Staff hit checkout and choose Card. The **server** prices the cart and
   freezes it (`pending_checkouts`-style), producing the authoritative amount.
3. The Render backend calls **Clover's cloud** (Cloud Pay Display) to start a
   payment for that amount on the bound Mini.
4. The **Mini** shows the amount and runs chip / tap / PIN, and prompts for the
   **tip on the device**.
5. The POS shows a waiting screen — success / failure / cancel are all handled
   explicitly, never left hanging.
6. On **success only**, the order is materialized, the payment row is written
   with `payments.amount == orders.total` (tip-inclusive), and the ticket goes
   to **KDS**.
7. A decline, a cancel, or an abandoned payment leaves **no order row** — the
   frozen cart is released and staff can retry.
8. Refunds run through the existing dual-control / PIN / $100 rules, dispatched
   **per payment row** to whichever processor actually took the money.

---

## 5. Codebase conflicts to plan around

1. **The schema is stripe-shaped.** These names all say "stripe" and will need a
   Clover-aware plan (new columns, a neutral column, or a documented reuse):
   - `pending_checkouts.stripe_*` (e.g. `stripe_payment_intent_id`)
   - `stripe_events`
   - `device_pairings.stripe_reader_id`
   - `locations.stripe_location_id`
   - `order_refunds.stripe_refund_id`
2. **Reader validation expects `tmr_`.** [backend/server.js:8413](../../backend/server.js#L8413)
   rejects anything that doesn't match `/^tmr_[A-Za-z0-9_]{1,240}$/` — a Clover
   device id will not pass it.
3. **The provider enum blocks boot.** `PAYMENTS_PROVIDERS = ["mock", "stripe"]`
   ([backend/server.js:61](../../backend/server.js#L61)) throws at startup on any
   other value, and `isStripeCardCheckout()`
   ([backend/server.js:554](../../backend/server.js#L554)) is the single gate
   deciding whether Card takes the Stripe path or the synchronous mocked path.
4. **Every new Clover column or table must follow this repo's
   Schema Change Checklist** — write the new `.sql` in `database/`,
   `npm run schema:sync`, apply to **production**, `npm run check:schema` must
   print `Schema OK`, **then** push the dependent code. No exemption for a
   "small" or "additive" migration.

---

## 6. Clover sandbox status

| Item | Value |
| --- | --- |
| Developer | Duri Developments |
| App | **Narcos Pos** (draft) |
| App type | Payment app + existing POS integration |
| Web REST | Enabled |
| Device family | Mini 3rd Gen |
| Permissions | Read + Write **Orders**, Read + Write **Payments**, Read **Merchant** |
| Site URL | `http://localhost:4000` |
| Alternate Launch Path | `/api/clover/oauth/callback` |
| OAuth response type | **Code** (not Token) |
| Test merchant | name `Test Merchant`, UUID `2N9FRNJANSV31`, country US |
| `client_id` (public) | `2P5T9VH3N0H7T` |
| Sandbox API base | `https://apisandbox.dev.clover.com` |
| Redirect already proven | Clover already redirected to `http://localhost:4000/api/clover/oauth/callback?merchant_id=2N9FRNJANSV31&client_id=2P5T9VH3N0H7T` — localhost refused **because the callback route does not exist yet**. That redirect means the settings worked. |
| Env var **names** (no values, ever) | `CLOVER_APP_ID`, `CLOVER_APP_SECRET`, `CLOVER_RAID`, `CLOVER_MERCHANT_ID` |

---

## 7. Phases

| Phase | Scope |
| --- | --- |
| **0 — Organize** | These docs. |
| **1 — OAuth + ping** | OAuth callback + token store + a `GET` merchant ping. Flags only; **no `provider=clover` live**. |
| **2 — Provider plumbing** | Extend the provider enum; **per-payment refund dispatch**; do not break `mock` or `stripe`. |
| **3 — Take a payment** | Cloud Pay Display checkout + waiting UI + success / fail / cancel + KDS on success. |
| **4 — Money correctness** | Refunds / Interac / reports; keep the Stripe refund path for old rows. |
| **5 — Go live** | Second Mini, bind the device, parallel soak, production app + real Narcos merchant, **human signoff**. |

---

## 8. Open questions — not blockers for Phase 0–1

- **Mini 2 vs Mini 3.** Check the serial under the paper roll: `C032` = Mini 2,
  `C035` = Mini 3.
- **The exact current Cloud Pay Display endpoint set** — confirm at Phase 3.
  Do not invent endpoint URLs before then.
- **When to move the Site URL** from `http://localhost:4000` to
  `https://api.narcostacos.ca/api/clover/oauth/callback`.
- **A Canada test merchant** for Interac (the sandbox merchant is US).

---

## 9. How agents must work

1. **Read §2 (Locked decisions) first.** Those are settled — implement them,
   don't re-open them.
2. **One slice at a time.** Do the current slice in [task.md](task.md), then stop.
3. **No secrets.** Never put a Clover App Secret, a Stripe key, or a token in
   git, in a doc, or in chat. Names go in `.env.example`; values go in env /
   Render.
4. **Schema Change Checklist, every time** — new `.sql` in `database/` (repo
   root), `npm run schema:sync` committed alongside it, apply to **production**,
   verify `Schema OK` against production, **then** push the dependent code.
5. **Stop on open questions instead of guessing hardware.** If the answer depends
   on which Mini, which endpoint, or which merchant — ask.
6. **Do not change production payments** until a human asks (L9).
7. **Do not delete Stripe code** (L7).

---

## 10. Context appendix

```text
HANDOFF KEY

PROJECT   Narcos Tacos POS — custom restaurant POS. Toronto / Ontario / HST.
REPO      github.com/defihussle/posproject
STACK     React + Vite frontend · Express backend · Postgres
LIVE      pos.narcostacos.ca (POS) · api.narcostacos.ca (API) — Render
DEV ENV   Windows + VS Code. Beginner-friendly: short steps, jargon in one line.

WORKSTREAM  Clover Mini semi-integration.
  Narcos POS = system of record (menu, cart, pricing, KDS, staff, reports).
  Clover Mini = payment terminal only (chip/tap/PIN/tip).
  Staff build the cart on Order Entry; the Mini shows the amount.
  Staff do not retype the price.

LOCKED
  Continue Clover Mini semi-integration.
  Do NOT restart Stripe Terminal as the hardware path.
  Stripe card code stays so old Stripe charges can still be refunded.
  Historical Stripe charges refund via Stripe APIs on that payment row,
    not only the current env flag.
  Primary path = Clover Cloud Pay Display (Render backend -> Clover cloud -> Mini).
  NOT Secure Network Pay Display as primary — Render cannot reach the store LAN.
  Server computes/authorizes the amount; the browser is not the source of truth.
  Provider target: mock | stripe | clover.
  Today boot THROWS on any PAYMENTS_PROVIDER other than mock|stripe.
  isStripeCardCheckout() is the gate.
  Production payments do not change until a human asks.
  Secrets never in git or chat.
  Second Mini for Narcos testing — do not share the owner's existing Mini
    across two POS systems.
  App stays draft. Install via App Market Preview -> Connect.

PRESERVE / REUSE
  pending_checkouts freeze-cart-before-charge
  order materialization only after payment success
  on-device tipping; orders.total tip-inclusive; payments.amount == orders.total
  tip-aware refund math (refundableBase = total - tip)
  Interac to-card vs cash-out + dual-control / PIN / $100 threshold
  reconcile sweep idea (Clover needs its own completion path + safety-net
    reconcile, not Stripe PI retrieve)
  ledger helpers settledPaymentsWhere / settledRefundsWhere
  Stripe files, webhooks, simulated tmr_ readers — do not delete

CONFLICTS
  Schema names are stripe-shaped: pending_checkouts.stripe_*, stripe_events,
    device_pairings.stripe_reader_id, locations.stripe_location_id,
    order_refunds.stripe_refund_id
  Reader validation expects tmr_
  New clover columns/tables require this repo's Schema Change Checklist
    (new SQL, schema:sync, apply prod, check:schema, THEN push code)
  backend/server.js:61   PAYMENTS_PROVIDERS = ["mock", "stripe"]
  backend/server.js:554  isStripeCardCheckout()
  backend/server.js:8413 reader id must match /^tmr_.../

CLOVER SANDBOX
  Developer: Duri Developments
  App: Narcos Pos (draft). Type: Payment app + existing POS integration.
    Web REST enabled. Device family: Mini 3rd Gen.
  Permissions: Read+Write Orders + Payments; Read Merchant
  Site URL: http://localhost:4000
  Alternate Launch Path: /api/clover/oauth/callback
  OAuth response: Code (not Token)
  Test merchant: name Test Merchant, UUID 2N9FRNJANSV31, country US
  client_id (public): 2P5T9VH3N0H7T
  Sandbox API: https://apisandbox.dev.clover.com
  Clover already redirected to
    http://localhost:4000/api/clover/oauth/callback?merchant_id=2N9FRNJANSV31&client_id=2P5T9VH3N0H7T
    localhost refused because the callback route does not exist yet.
    That redirect means settings worked.
  Env names only (no values): CLOVER_APP_ID, CLOVER_APP_SECRET,
    CLOVER_RAID, CLOVER_MERCHANT_ID

PHASES
  0 Organize = these docs
  1 OAuth callback + token store + GET merchant ping; flags only;
    no provider=clover live
  2 Extend provider enum; per-payment refund dispatch; do not break mock/stripe
  3 Cloud Pay Display checkout + waiting UI + success/fail/cancel +
    KDS on success
  4 Refunds / Interac / reports; keep Stripe refund path for old rows
  5 Second Mini, bind device, parallel soak, production app + real Narcos
    merchant, human signoff

OPEN (do not block Phase 0-1)
  Mini 2 vs 3 (serial under paper roll: C032=Mini 2, C035=Mini 3)
  Exact current Cloud Pay Display endpoint set (confirm at Phase 3)
  When to move Site URL from localhost to
    https://api.narcostacos.ca/api/clover/oauth/callback
  Canada test merchant for Interac

DOCS
  docs/architecture/plan.md — living source of truth (this file)
  docs/architecture/task.md — slice checklist
  CLAUDE.md — project reference + the mandatory Schema Change Checklist
```
