# Stripe Terminal — Hardware & Go-Live Runbook

Operational companion to `stripe-terminal-plan.md`. That document is the
**design** — decisions, architecture, why things are the way they are. This one
is the **procedure**: what to click, what to run, and in what order, on the day
the reader arrives and on the day real money starts moving.

**Status**: Slices 0–8 complete and verified on the simulated reader. No
physical reader purchased. `PAYMENTS_PROVIDER=mock` in production — no customer
has ever been charged through Stripe by this system.
**Last updated**: 2026-08-06

Written to be followed by someone who is not a Stripe expert. Every step says
what you should see if it worked, and what it means if you don't.

---

## Part 0 — Where things actually stand

### What is proven on the simulated reader

The full loop has been exercised end to end and reconciles:

| Step | Proven | Where it lives |
|---|---|---|
| Cart priced + frozen server-side | ✅ | `priceCart()`, `pending_checkouts` |
| PaymentIntent created, sent to reader | ✅ | `startTerminalPayment()` |
| Tip taken on the reader (15/18/20%) | ✅ | `process_config.tipping` |
| Webhook materializes the order | ✅ | `handlePaymentIntentSucceeded()` |
| Money invariant asserted at insert | ✅ | `materializeOrderFromPendingCheckout()` |
| Declines / cancels / reader busy / offline | ✅ | `readerErrorKind()` + Order Entry states |
| Tip-aware refund math | ✅ | `applyRefund()` |
| Real Stripe refunds + pending/failed states | ✅ | `settleStripeRefund()`, refund webhooks |
| Interac blocked from Back Office | ✅ | `decideRefundSettlement()` |
| Reconciliation + orphan recovery | ✅ | `reconcilePendingCheckouts()` |
| Receipts (print + Stripe email) | ✅ | `buildReceipt()`, `ReceiptModal` |

Webhook coverage is complete for every event the plan required:
`payment_intent.succeeded`, `payment_intent.payment_failed`,
`terminal.reader.action_succeeded`, `terminal.reader.action_failed`,
`refund.created`, `refund.updated`, `refund.failed`, `charge.refunded`.

### The three gaps that are not code bugs

Nothing above is broken. But three things that a simulated reader never forced
anyone to confront will bite on hardware day, and they are listed here rather
than discovered at the counter.

**1. There is no UI for binding a reader to a till.**
`device_pairings.stripe_reader_id` is what tells a till which reader to drive.
It has **no read or write surface anywhere** — `GET /api/backoffice/devices`
doesn't return it, `PUT /api/backoffice/devices/:id` only accepts
`device_name`, and the Devices screen has no field for it. It is set with SQL,
by hand. Worse, when it is missing the error a cashier sees says *"Assign one
in Back Office → Devices"* — pointing at a screen that cannot do it.

The same is true of `locations.stripe_location_id`.

This is not a blocker (the SQL is two lines, below), but a small Back Office
field should land before the store depends on it. Tracked as the top open item.

**2. The Interac cash-out path has no button.**
The server fully supports it — `applyRefund()` accepts `refundMethod: 'cash'`
and writes the negative `payments` row as cash with no Stripe call. **No
frontend sends it.** So today, an Interac sale where the customer has lost the
card, or isn't coming back, is a dead end: the cashier gets a 409 telling them
to issue a cash refund, with nothing to press. Staff must be told this
explicitly (see Part 3) until the button exists.

**3. The reconciliation sweep is off by default.**
`RECONCILE_INTERVAL_MINUTES` defaults to `0`, which means no background sweep
runs at all. That is deliberate — the plan wanted it exercised manually before
being trusted unattended — but it must be **set in production before go-live**,
or a lost webhook stays lost until somebody notices a customer waiting for food
nobody is cooking.

---

## Part 1 — Physical reader playbook

Do this when the reader arrives. Everything here is still in **test mode** —
you are not taking real money yet. Nothing in Part 1 requires a code change or
a deploy.

### 1.1 Which reader

Any smart reader works; the code only ever handles a reader **id**, so swapping
models later changes one database value and nothing else.

- **Stripe Reader S700 / S710** or **BBPOS WisePOS E** — available now, fully
  supported.
- **Stripe Reader T600** — the 8" tablet-style unit; confirm Canadian
  availability with Stripe Support before ordering.
- **Not** M2 or WisePad 3 — Bluetooth-only readers do not work with the
  server-driven integration this system uses.

Order from Dashboard → **Terminal → Shop**. Order in the **same Stripe account**
the API keys belong to.

### 1.2 Power it on and get it online

1. Plug in with the supplied USB-C cable and adapter (12 W). Hold the power
   button on the right side until the screen lights.
2. Open settings: **swipe right from the left edge of the screen**, tap
   **Settings**, enter the admin passcode **`07139`**.
3. **WiFi settings** → join the store's network. Leave the reader plugged in and
   powered on permanently — that is how it receives firmware updates.

If the store has the optional dock + Ethernet hub, plug the Ethernet in and the
reader prefers it automatically. Ethernet is the better choice at a counter.

### 1.3 Register it to the Stripe Location

The Location must already exist (Slice 0.1 created it — Dashboard → Terminal →
Locations, the Lawrence East address, id starts `tml_`).

**Easiest method — serial number.** You don't need to touch the device.

1. Find the serial number: printed on the back of the reader and on the box,
   or in Dashboard → **Terminal → Hardware orders**.
2. Dashboard → **Terminal → Readers** → **Register reader**.
3. Enter the serial number → **Next**.
4. Name it something a human will recognise at 7pm: `Front Counter Reader`.
5. Select the **Lawrence East** Location.
6. **Register**.

**Alternative — pairing code.** Use this if the serial-number route fails, or if
you're re-registering. On the reader: settings (swipe right → Settings → `07139`)
→ **Generate pairing code**. A short word-code appears. Then Dashboard →
Terminal → Readers → Register reader → enter the code → name → Location →
Register.

Either way you end up with a reader id starting **`tmr_`**. Copy it.

> Register the reader while your Dashboard is in **test mode** if you are using
> test keys. A reader registered in live mode is invisible to a `sk_test_` key
> and vice versa — this is the single most common "the diagnostic says no
> readers exist" cause.

### 1.4 Point the store's row at the Stripe Location

Only needed once, and only if it was never done. Check first — the diagnostic
(step 1.6) tells you whether it is already set.

```sql
-- Replace tml_xxx with the Location id from Dashboard → Terminal → Locations
UPDATE locations
   SET stripe_location_id = 'tml_xxx'
 WHERE active = true;
```

Run it against production with the Render External Database URL:

```bash
psql "<Render External Database URL>" -c "UPDATE locations SET stripe_location_id = 'tml_xxx' WHERE active = true;"
```

No trailing spaces. The diagnostic warns about stray whitespace, but it is
easier not to introduce it.

### 1.5 Bind the reader to the till

This is the step with no UI (Part 0, gap 1). The till is a **paired device** —
the tablet that runs Order Entry — and the binding says "this till drives that
reader".

First find the till's row:

```bash
psql "<Render External Database URL>" -c \
  "SELECT device_id, device_name, last_order_entry_at FROM device_pairings
    WHERE paired_at IS NOT NULL AND revoked_at IS NULL ORDER BY last_order_entry_at DESC NULLS LAST;"
```

Pick the one whose `device_name` matches the counter tablet, then:

```bash
psql "<Render External Database URL>" -c \
  "UPDATE device_pairings SET stripe_reader_id = 'tmr_xxx' WHERE device_name = 'Front Counter Tablet';"
```

Confirm exactly one row was updated (`UPDATE 1`).

A second till later is the same two lines with its own `tmr_` id — that is the
whole of "multi-till support". Stripe readers and device pairings stay separate
trust layers; this column binds them without merging them.

### 1.6 Verify with the diagnostic

Log into Back Office as owner/admin in a browser, then open this URL in the same
browser (the session cookie goes with it):

```
https://api.narcostacos.ca/api/backoffice/stripe/diagnostics
```

You should see JSON. Read it in this order:

| Field | Want to see | If it's wrong |
|---|---|---|
| `stripeConfigured` | `true` | `STRIPE_SECRET_KEY` missing on Render |
| `keyMode` | `"test"` (for now) | You are on live keys sooner than you meant to be |
| `reachable` | `true` | Read `error` — usually a bad key or a rejected API version |
| `account.country` | `"CA"` | Wrong Stripe account |
| `account.chargesEnabled` | `true` | Stripe onboarding is incomplete |
| `location.configured` | `true` | Step 1.4 didn't take |
| `readers[]` | your reader, `status: "online"` | See below |
| `readers[].matchesConfiguredLocation` | `true` | Reader is on a different Location than the store row |
| `tipping[].percentages` | `[15, 18, 20]` | Terminal Configuration missing or not CAD |
| `hints[]` | empty | **Read them — they are written to tell you exactly what to fix** |

`hints` is the part to actually read. The diagnostic deliberately lists **every**
reader on the account rather than filtering by Location, precisely so a
mismatch shows up as a mismatch instead of an empty list.

`status: "offline"` on a reader that is plugged in and on WiFi usually means it
hasn't checked in yet — give it a minute, then reboot it.

### 1.7 First payment on real hardware (still test mode)

1. Confirm `PAYMENTS_PROVIDER=stripe` **only if you are ready to route card
   payments through Stripe on test keys.** If production is serving customers on
   `mock`, do this on a staging environment or outside trading hours.
2. Ring up a small order on the till → **Pay → Card**.
3. The reader should wake and show the amount within a couple of seconds, then
   the tip screen.
4. Tap a Stripe **test card** (Stripe ships physical test cards with hardware
   orders; a real card will be declined on test keys).
5. Watch: tip screen → approved on reader → Order Entry shows the confirmation →
   the ticket appears on the KDS.
6. Print a receipt from the confirmation screen. Check the card brand and last4
   are on it.
7. Refund it from Order Recall with a manager PIN. Check the reversal appears in
   the Refunds Report.

If any step stalls, check `GET /api/backoffice/payments/reconcile/status` — a
non-zero `awaiting_payment` count means a webhook didn't arrive.

---

## Part 2 — Go-live checklist

Ordered. Do not skip ahead — several steps are only meaningful because an
earlier one passed.

### Before the day

- [ ] **1.** Part 1 complete: reader registered, bound to the till, diagnostic
      clean on test keys, one full test-mode payment + refund + receipt done on
      the physical reader.
- [ ] **2.** Stripe account fully activated for live payments — Dashboard →
      Settings → business details, bank account, identity verification all
      green. `account.chargesEnabled` must be `true` in **live** mode.
- [ ] **3.** Create the **live-mode Location** (Dashboard in live mode →
      Terminal → Locations). Test and live are separate object spaces; the
      `tml_` id will be different.
- [ ] **4.** Create the **live-mode Terminal Configuration** with CAD tipping at
      15 / 18 / 20 %, custom tip and no-tip enabled, attached to that Location.
- [ ] **5.** **Re-register the reader in live mode** against the live Location.
      A reader is registered per mode; its `tmr_` id will change.
- [ ] **6.** Register the **live webhook endpoint**: Dashboard (live) →
      Developers → Webhooks → Add endpoint →
      `https://api.narcostacos.ca/api/stripe/webhook`, subscribing to exactly:
      `payment_intent.succeeded`, `payment_intent.payment_failed`,
      `terminal.reader.action_succeeded`, `terminal.reader.action_failed`,
      `refund.created`, `refund.updated`, `refund.failed`, `charge.refunded`.
      Copy the new `whsec_…`.
- [ ] **7.** Confirm the migration state is clean against production:
      `cd backend && DATABASE_URL="<Render External Database URL>" npm run check:schema`
      → must print `Schema OK`. Exit 2 (cannot connect) is **not** a pass.
- [ ] **8.** Pick a quiet window. Not a Friday dinner rush.

### Switching over

- [ ] **9.** On Render, set the backend environment variables — all four
      together, in one save:
      - `STRIPE_SECRET_KEY` = the `sk_live_…` key
      - `STRIPE_WEBHOOK_SECRET` = the `whsec_…` from step 6
      - `STRIPE_API_VERSION` = unchanged (stays pinned)
      - `PAYMENTS_PROVIDER` = **leave on `mock` for now**

      These are backend vars, not `VITE_*` — no frontend rebuild is involved.
- [ ] **10.** Set the reconciliation sweep, which has never run unattended:
      - `RECONCILE_INTERVAL_MINUTES` = `5`
      - `RECONCILE_STALE_MINUTES` = `20` (the default; set it explicitly so it
        is visible)
- [ ] **11.** Update the two database values to their **live** equivalents:
      ```sql
      UPDATE locations SET stripe_location_id = 'tml_LIVE' WHERE active = true;
      UPDATE device_pairings SET stripe_reader_id = 'tmr_LIVE' WHERE device_name = 'Front Counter Tablet';
      ```
- [ ] **12.** Let Render redeploy. In the logs, confirm the boot line reads
      `Payments: provider=mock, stripeClient=configured, keyMode=live` and
      `Reconciliation scheduled every 5m`.
- [ ] **13.** Run the diagnostic again. `keyMode: "live"`, `reachable: true`,
      the live reader present and `online`, `matchesConfiguredLocation: true`,
      `hints: []`.
- [ ] **14.** **Now** flip the switch: set `PAYMENTS_PROVIDER=stripe` on Render
      and let it redeploy. Confirm the boot line says `provider=stripe`.

### Proving it with real money

- [ ] **15.** Ring the cheapest item on the menu. Pay with a **real personal
      card**. Choose a tip (any amount) so tipping is exercised on the first
      live charge.
- [ ] **16.** Confirm, in order: reader prompts → tip screen → approved →
      Order Entry confirmation → **ticket on the KDS**.
- [ ] **17.** In Stripe Dashboard (live) → Payments, the charge exists with the
      tip included, and Developers → Webhooks shows the delivery succeeded
      (`200`).
- [ ] **18.** Print the receipt. Card brand + last4 correct. Email it to
      yourself and confirm Stripe's receipt arrives.
- [ ] **19.** Do a second live sale with **Interac debit** if you accept it.
      Confirm `processor_payment_type` is `interac_present` (visible on the
      receipt as "Interac Debit").

### Proving the money still reconciles

- [ ] **20.** Back Office → Reports → **Sales Summary** for today. Gross, tax
      and **tips** must include the live sales. This is the first time these
      reports have ever seen a non-zero tip in production.
- [ ] **21.** **Transaction Log** shows both sales with the right payment
      method.
- [ ] **22.** Refund the credit-card sale **in full** from Order Recall with
      manager PIN approval. The tip must come back with it (full refunds return
      the tip; partials never do).
- [ ] **23.** Confirm the refund reaches Stripe: Dashboard → the payment shows
      refunded, and `order_refunds.status` moves `pending` → `completed` once
      the webhook lands. A refund stuck at `pending` means the refund webhooks
      are not subscribed — go back to step 6.
- [ ] **24.** Try to refund the **Interac** sale from **Back Office →
      Transaction Log**. It must be **rejected** with the message about
      returning to the counter with the card. That rejection is the feature
      working.
- [ ] **25.** **Refunds Report** and **Sales Summary** both reflect the
      reversal, and net sales still balance.
- [ ] **26.** Run `POST /api/backoffice/payments/reconcile` once by hand and
      confirm it reports zero orphans and zero stuck checkouts.

### Proving you can get back out

- [ ] **27.** **Kill-switch test.** Set `PAYMENTS_PROVIDER=mock` on Render, wait
      for the redeploy, and take one card order. It should complete instantly
      with no reader involvement — today's mocked behaviour, exactly.
- [ ] **28.** Set it back to `stripe`, redeploy, and take one more real card
      payment to confirm the switch works in both directions.
- [ ] **29.** Write the kill-switch procedure on paper and tape it inside the
      till drawer. Whoever is on shift at 8pm when the reader dies is not going
      to read this file.

### Afterwards

- [ ] **30.** Watch the first full trading day: check
      `GET /api/backoffice/payments/reconcile/status` at close. Anything in
      `orphaned` needs a human before the next day's numbers are trusted.
- [ ] **31.** Reconcile the day's Sales Summary against the Stripe Dashboard
      payout total. They should agree to the cent, less Stripe fees.
- [ ] **32.** Decide on the HST registration number
      (`BUSINESS_TAX_NUMBER` env var now, `locations.hst_number` migration
      later) — a Canadian receipt should carry it.

---

## Part 3 — Staff training

Five things. Anyone taking payments needs all five.

### 1. The card flow

Pay → **Card** → the reader wakes up and shows the amount. Hand the customer the
reader (or turn it toward them). They tip, tap or insert, and PIN if asked.

**The order does not exist until the payment succeeds.** Nothing reaches the
kitchen while the customer is still tapping. That is deliberate — a declined
card leaves no half-order behind — but it means the ticket appears a second or
two *after* the card is approved, not when you press Card.

### 2. The tip screen

The reader asks for the tip, not the POS. Options are 15 / 18 / 20 %, plus
custom and no tip. Percentages are calculated on the **food before tax**, not
the total — so the suggestions are honest.

Never tell a customer what to press. Turn the reader toward them and let them
choose.

### 3. When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "Reader is busy" | It is still finishing the last payment | Wait a few seconds, then **Cancel payment** and retry |
| "Reader offline" | It has lost WiFi or power | Check the cable and the network. Take **cash** meanwhile |
| "Declined" | The customer's card said no | **Try card again**, or **Pay with cash**. The cart is still there |
| Customer walks away mid-payment | Nothing was charged | **Cancel payment**. No order is created |

**The cart is never lost.** Any failed card attempt leaves the order on screen
ready to retry or switch to cash.

### 4. The Interac rule — the one that surprises people

**An Interac debit sale can only be refunded with the customer's physical card,
at the reader.**

That is a rule of the Interac network, not this system. So:

- Refunding Interac **from Back Office is blocked**, on purpose.
- The customer must come back to the counter **with the same card**.
- If they can't — lost card, not coming back — the refund has to be given as
  **cash from the till**.

⚠️ **Right now there is no button for the cash-out refund.** Until one is
built, that situation needs the owner or a manager, who will record it manually.
Do not promise a customer an Interac refund without the card.

Credit-card refunds have none of these restrictions — they can be issued
remotely from Back Office like always.

### 5. Receipts

Offered on the confirmation screen right after payment, and available for any
past order from **Recall / Refund Orders**.

- **Print** works for every sale, cash or card.
- **Email** only appears for card sales taken on the reader — Stripe sends it.
  Cash sales are print-only.

---

## Part 4 — If it breaks in service

**The one-line fix:** on Render, set `PAYMENTS_PROVIDER=mock` and save. After
the redeploy (~1 minute) the Card button goes back to today's instant, mocked
behaviour and the reader is out of the loop entirely. Cash is unaffected and has
never been part of this at any point.

Money is not lost by doing this. Anything already captured stays captured, and
the reconciliation sweep will still materialize an order for any payment whose
webhook was in flight.

**Then, in order:**

1. `GET /api/backoffice/stripe/diagnostics` — is Stripe reachable, is the reader
   online, do the `hints` say anything?
2. `GET /api/backoffice/payments/reconcile/status` — is anything stuck at
   `awaiting_payment` or, worse, `orphaned`?
3. `POST /api/backoffice/payments/reconcile` — sweeps now, materializes orders
   for any payment whose webhook was missed.
4. Stripe Dashboard → Developers → Webhooks — are deliveries failing? A run of
   `500`s means the handler is erroring; the response body and the Render logs
   will say why.

**`orphaned` means money was captured and no order was written.** It is rare and
it is loud in the logs on purpose. Do not let a day close with an orphan
outstanding — the customer paid for food nobody made.

---

## Remaining open items

Carried forward from the plan, plus what this runbook surfaced:

1. **No UI to bind a reader to a till** (`device_pairings.stripe_reader_id`) or
   to set `locations.stripe_location_id`. Both are SQL-only, and the error
   message points at a Back Office screen that cannot do it. Smallest, highest
   value thing to build next.
2. **No Interac cash-out button.** The server path exists; nothing calls it.
3. **T600 availability** for Canadian accounts — unconfirmed, not a blocker.
4. **HST registration number** has no home in the schema
   (`BUSINESS_TAX_NUMBER` env var is the stopgap).
5. **Receipt printer** not yet chosen. Printing works through the browser's
   print dialog, so any printer the tablet's OS can see will work.
6. **KDS device-pairing revocation is still not live-polled** — checked on page
   load only. Unchanged by this work, noted so it isn't assumed fixed.
7. **No Back Office UI for diagnostics or reconciliation** — both are API-only,
   reachable from a browser tab while logged in. Fine for an owner; worth a
   screen eventually.
