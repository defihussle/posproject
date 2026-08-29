# Clover Mini — Phase 4: refunds + orphan reconcile

**Scope:** a Clover-shaped payment row refunds through Clover; a Stripe-shaped
row still refunds through Stripe; an orphaned checkout can be resolved by asking
Clover what really happened.

**⚠️ This slice adds a database column.** It is **not** applied to production and
the code is **not** pushed. See §5.

Plan: [plan.md](plan.md) · Checklist: [task.md](task.md) ·
Phase 3: [clover-mini-phase3.md](clover-mini-phase3.md)

---

## 1. Endpoints, copied from the docs

Base `CLOVER_API_BASE` (`https://apisandbox.dev.clover.com`).
REST Pay cloud base = that **+ `/connect`**.

| Purpose | Method + URL | Doc page |
| --- | --- | --- |
| **Refund a payment** | `POST {base}/connect/v1/payments/{paymentId}/refunds` | [Refunding a charge](https://docs.clover.com/dev/docs/refunding-a-charge) |
| **Find a payment by our id** | `GET {base}/v3/merchants/{mId}/payments?filter=externalPaymentId={id}` | [Get all payments](https://docs.clover.com/dev/docs/get-all-payments), [reference](https://docs.clover.com/dev/reference/paygetpayments) |

### Refund request body

```json
{ "amount": 500 }
```

Documented alternatives are `{"amount": <cents>}` (partial) and
`{"fullRefund": true}` (full).

**We always send an explicit `amount`, never `fullRefund`.** `fullRefund` means
*the whole payment*, which **includes the tip** — and this product's refund math
is deliberately tip-aware (`refundableBase = total − tip`). Letting Clover decide
what "full" means would silently hand back the tip and diverge from what every
report says was returned.

### Headers

Same set as the pay call, including the mandatory `Idempotency-Key`, derived
from **our** `order_refunds.id` so a retry after a timeout can't refund twice:

```
Authorization:      Bearer <token>
X-Clover-Device-Id: <the Mini's serial>
X-POS-Id:           <CLOVER_RAID>
Idempotency-Key:    rf_<order_refunds.id>
```

### On the payment-lookup endpoint

Retrieving a payment by `externalPaymentId` on REST Pay Display is
**Android-Intent only** —
[Payment retrieval operations](https://docs.clover.com/dev/docs/payment-retrieval-operations)
gives `RetrievePaymentRequestIntentBuilder().externalPaymentId(...)` and **no
REST endpoint**. So, as instructed, the Platform REST list endpoint is used
instead. The [reference](https://docs.clover.com/dev/reference/paygetpayments)
lists the filterable fields as:

> `modifiedTime, device.id, externalReferenceId, result, offline, createdTime,`
> `externalPaymentId, voided, id, tender.id, employee.id, order.modifiedTime,`
> `amount, cardType, clientCreatedTime`

`externalPaymentId` is filterable **and** is returned on the payment object.
(The [Applying filters](https://docs.clover.com/dev/docs/applying-filters) page
doesn't enumerate fields — it defers to the reference. Not a conflict.)

**No doc conflicts found on the endpoints implemented here.** For the record,
the read-tip path conflict reported in Phase 3 is unrelated and still unresolved
— nothing here touches it.

---

## 2. How a refund is routed

`decideRefundSettlement()` reads the **payment row**, never `PAYMENTS_PROVIDER`.

| Sale row | Settlement | Goes to |
| --- | --- | --- |
| `processor_txn_id` NULL (cash / mock) | `internal` | nothing — settles instantly |
| starts `pi_` | `stripe_api` / `stripe_reader` | **Stripe**, even when the env is `clover` |
| anything else (Clover) | `clover_api` | **Clover** |
| `refundMethod: 'cash'` | `internal_cash` | cash out of the drawer |

### Clover refunds need the Mini

Clover documents the REST Pay refund's prerequisites as *"Clover device is
idle"* and *"POS is connected to the device"* — it is a **device-attached** API,
unlike `stripe_api`, which settles server-side with no reader. Consequences:

- **Back Office cannot issue a Clover refund.** `surface !== 'pos'` → **409**
  telling staff to refund at the till or issue cash. This is stricter than
  Stripe, where only Interac is POS-only.
- **No `CLOVER_DEVICE_ID` → 409** naming the variable, refused **before any row
  is written**. No fake completed refund, ever.
- **Cash-out still works everywhere.** `refundMethod: 'cash'` returns
  `internal_cash` and never reaches any of this, so an Interac customer who
  can't return with their card is still made whole in notes.

### Interac detection is unchanged

The Interac branch reads the `processor_payment_type` that **Phase 3 already
stored** from Clover's own `cardType`. No new detection was added. A missing or
unrecognised `cardType` was stored as `card_present` and is **never guessed** as
Interac.

### Unchanged from before

Dual-control, PIN approval, the **$100 owner/admin threshold**, and
`refundableBase = total − tip` all sit above this and are untouched. A Clover
refund starts `pending` on both the audit row and the negative ledger row, and
only becomes visible to reports once Clover confirms — the same rule Stripe
follows, through the same `settledPaymentsWhere()` predicate.

### Indeterminate refunds stay pending

HTTP 500, 504, or a dropped connection leave the refund **`pending`** with a
`processor_status` of `indeterminate_*` — never `failed`. Marking it failed
would restore a voided order and invite a second refund for money that may
already be back with the customer.

---

## 3. Orphan reconcile

An `orphaned` pending checkout is one where the Phase 3 pay call gave no usable
answer. Nothing else in the system would ever find out what happened.

`POST /api/clover/reconcile` — **owner/admin only** (it can create an order, so
it is gated like other payment-admin surfaces; the read-only `status`/`devices`
endpoints are not). Optional body `{"limit": 25}`.

For each orphan it recomputes the **same** `externalPaymentId` the pay call sent
(the pending UUID with dashes stripped — no column needed to remember it) and
asks Clover:

| Clover says | We do |
| --- | --- |
| a payment exists, `result: SUCCESS` | materialize the order **once**, through the same locked path a live success uses |
| no payment found | mark the checkout `failed` — nothing was charged |
| a payment exists but not SUCCESS | mark `failed`, recording Clover's result |
| unreachable / unreadable | **leave it `orphaned`** — never guess |

**Not scheduled.** There is no cron and no interval variable: nothing sweeps
unattended until someone decides it should, the same stance
`RECONCILE_INTERVAL_MINUTES` takes for the Stripe sweep (default `0` = never).

---

## 4. Verified without a Mini

| Test | Result |
| --- | --- |
| Boot `mock` / `stripe` / `clover` | all OK; `clovr` still throws |
| Refund a `pi_` row while env is `clover` | `stripe_api` → **Stripe**, as required by plan L7 |
| Refund a Clover row at the POS | `clover_api` → real call to Clover sandbox |
| Clover refund from Back Office | **409**, nothing written |
| Clover Interac from Back Office | **409** with the Interac wording |
| Clover refund, no `CLOVER_DEVICE_ID` | **409**, nothing written |
| Reconcile an orphan Clover has never seen | marked `failed`, **0 orders created** |
| `mock` card + cash checkout | both still **201** |
| `POST /api/clover/reconcile` unauthenticated | **401** |

The fake-id refund returned, from the **real sandbox**:

```json
{"message":"An invalid device serial number [C035FAKESERIAL01] or token was provided.",
 "requestId":"5fa82bc7-77051","type":"BAD_REQUEST"}
```

That is **proof of wiring, not of success** — Clover parsed our request, read
our headers, and objected only to the fake serial. The refund row correctly went
to `failed` with `clover_refund_id` still NULL.

---

## 5. ⚠️ Outstanding: the migration

`database/clover_refunds.sql` adds **one nullable column**,
`order_refunds.clover_refund_id`, plus a partial index.

**Why a new column:** `order_refunds` has no generic processor-refund-id column
— only `stripe_refund_id`, which is indexed and is read by the Stripe webhook
resolver to match incoming Stripe events. Putting a Clover id there would make
that lookup wrong. The migration file explains why a neutral
`processor_refund_id` was also rejected for this slice.

**Not applied to production, and the code is not pushed.** Once
`backend/schema-requirements.json` lists this column, the backend **refuses to
boot** without it — so pushing first would take the live API down.

Run these yourself when ready (**ask me first / your call**):

```powershell
psql "<Render External Database URL>" -f database/clover_refunds.sql
```

```powershell
cd backend
$env:DATABASE_URL="<Render External Database URL>"; npm run check:schema
```

The second must print **`Schema OK`**. Only then is it safe to push.

Applying it early is harmless on its own: the column is nullable and additive,
nothing reads it until the new code deploys, and production stays on
`mock`/`stripe` regardless.

---

## 6. Still open for Phase 5

- **Interac on real hardware** — the refund rule is coded but has never seen an
  actual Interac tap. Confirm `cardType` before trusting it.
- **Remote (Back-Office) Clover refunds.** Clover also has a Platform REST
  refund under `/v3`, which would not need the device. Not implemented: you
  asked for the REST Pay refund, and mixing the two without hardware to test
  against would be guesswork. Worth revisiting if refunding from Back Office
  turns out to matter.
- **Scheduling the reconcile sweep** — deliberately manual for now.
- Clover refund **response shape** is read defensively (`refund.id` or `id`)
  because Clover publishes the success body only as a screenshot. Confirm
  against a real refund and tighten.
