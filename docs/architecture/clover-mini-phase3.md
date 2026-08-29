# Clover Mini — Phase 3: Cloud Pay Display checkout

**Scope:** Card checkout under `PAYMENTS_PROVIDER=clover` starts a real payment
on a Clover Mini through Clover's cloud. **No schema change.** Production is
untouched and still runs `mock`/`stripe`.

Plan: [plan.md](plan.md) · Checklist: [task.md](task.md) · Phase 1:
[clover-mini-phase1.md](clover-mini-phase1.md)

> Jargon, one line each:
> - **Cloud Pay Display** — the app that must be running on the Mini for it to
>   accept payments pushed from our server through Clover's cloud.
> - **Device serial** — the Mini's own serial number. This is the device id
>   Clover wants; it is **not** a Stripe `tmr_` reader id.
> - **Idempotency key** — a unique tag on a request so a retry can't charge twice.

---

## 1. Endpoints implemented, and where they came from

Base: `CLOVER_API_BASE` (default `https://apisandbox.dev.clover.com`).
REST Pay Display cloud base = that host **+ `/connect`**.

| Purpose | Method + URL | Doc page |
| --- | --- | --- |
| Create a payment | `POST {base}/connect/v1/payments` | [docs.clover.com/dev/reference/pay](https://docs.clover.com/dev/reference/pay), [Making a sale](https://docs.clover.com/dev/docs/making-a-sale) |
| Cancel current action | `POST {base}/connect/v1/device/cancel` | [Canceling the current action](https://docs.clover.com/dev/docs/canceling-the-current-action) |
| Connectivity check | `POST {base}/connect/v1/device/ping` | [Verifying connectivity](https://docs.clover.com/dev/docs/verifying-connectivity) |
| Refresh access token | `POST {base}/oauth/v2/refresh` | [Refresh access tokens](https://docs.clover.com/dev/docs/refresh-access-tokens) |
| List devices | `GET {base}/v3/merchants/{merchantId}/devices` | Clover Platform API |

### Required headers (from [docs.clover.com/dev/reference/pay](https://docs.clover.com/dev/reference/pay))

```
Authorization:      Bearer <OAuth access token from clover_oauth_tokens>
X-Clover-Device-Id: <the Mini's SERIAL number>
X-POS-Id:           <CLOVER_RAID — our Remote Application ID>
Idempotency-Key:    pc_<pending_checkout id, dashes stripped>
User-Agent:         NarcosTacosPOS/1.0
Content-Type:       application/json
```

### Request body we send

```json
{
  "amount":            225,
  "externalPaymentId": "cd0de6c5812046f799b843886a1dd628",
  "taxAmount":         26
}
```

`amount` is in **cents**, computed server-side from the frozen
`pending_checkouts` snapshot. The client never supplies it.

`externalPaymentId` is capped at 32 characters by Clover, and a UUID with its
dashes removed is exactly 32 — so it is derived from the pending checkout id.
That is deterministic and reproducible, which is **why no new column was
needed**: any reconcile sweep can recompute it from the pending row.

### Documented status codes, and what we do with each

| Clover | Meaning | Our outcome | Cart |
| --- | --- | --- | --- |
| 200 + `result: SUCCESS` | Paid | order written, KDS ticket | cleared |
| 200 + other `result` | Declined | `failed` | **kept** |
| 209 | Canceled on device | `cancelled` | **kept** |
| 400 / 415 | Invalid, do not retry | `failed` | **kept** |
| 401 | Bad token | refresh, else `failed` | **kept** |
| 500 | **Indeterminate** | `orphaned` | **kept** |
| 501 | Device doesn't support | `failed` (`reader_offline`) | **kept** |
| 503 | Device busy | `failed` (`reader_busy`) | **kept** |
| 504 | Device timeout | `failed` (`reader_offline`) | **kept** |
| network drop / our abort | Unknown | `orphaned` | **kept** |

**No order row is ever written except on 200 + SUCCESS.**

---

## 2. Tip flow — what we chose and why

**Chosen: single-call sale, tip collected on the Mini's own tip screen.** We
send **no** `tipAmount` and **no** `final`, then read `payment.tipAmount` back
from the response.

The [pay reference](https://docs.clover.com/dev/reference/pay) documents
`tipAmount` as *"only valid when `final=true`"* — i.e. only when the POS has
already decided the tip. Sending it is the opposite of on-device tipping, so we
don't.

**We did not use the `read-tip` pre-auth flow**, and there are two reasons:

1. **It's the wrong flow for this business.** The documented on-screen tip
   procedure ([Authorizing a tipped payment on
   screen](https://docs.clover.com/dev/docs/authorizing-a-tipped-payment-on-screen))
   is a **pre-auth then capture** sequence: `capture:false` → read-tip →
   `POST /v1/payments/{paymentId}/capture`. That is the restaurant tip-adjust
   model for table service. Narcos Tacos is counter-service (per `CLAUDE.md`) —
   the customer is standing at the Mini and taps once.
2. **The docs conflict on its path, so guessing would be unsafe.** Two Clover
   pages give different paths for the same endpoint:
   - [Requesting a tip](https://docs.clover.com/dev/docs/requesting-a-tip) →
     `/v1/device/read-tip`
   - [Authorizing a tipped payment on screen](https://docs.clover.com/dev/docs/authorizing-a-tipped-payment-on-screen) →
     `/device/v1/read-tip`

   Per the standing rule, that conflict is reported rather than guessed. Nothing
   in Phase 3 depends on it.

**Confirm on the first real Mini (Phase 5):** whether a plain sale actually
raises the Mini's tip screen depends on the merchant's tip configuration on the
device. If it doesn't prompt, `tipAmount` comes back absent and the sale still
balances at `tip = 0` — the money invariant holds either way — but tipping would
then need the pre-auth flow above, and the path conflict must be resolved first.

---

## 3. Environment variable names

Values go in `backend/.env` (git-ignored) or Render. **Never** in git.

| Name | Purpose |
| --- | --- |
| `CLOVER_APP_ID` | App ID / client_id (Phase 1) |
| `CLOVER_APP_SECRET` | App Secret — **secret** (Phase 1) |
| `CLOVER_MERCHANT_ID` | Merchant pin (Phase 1) |
| `CLOVER_API_BASE` | `https://apisandbox.dev.clover.com` |
| `CLOVER_RAID` | Remote Application ID → sent as `X-POS-Id`. **Now required to charge.** |
| `CLOVER_DEVICE_ID` | **New.** The Mini's **serial** → `X-Clover-Device-Id` |
| `CLOVER_PAY_TIMEOUT_SECONDS` | **New.** Default 135, clamped 0–300 per the docs |

---

## 4. Testing WITHOUT a Mini (what you can do today)

Run the backend with `PAYMENTS_PROVIDER=clover`. Everything below was verified
this way — three of the four calls reach the **real** Clover sandbox.

**a) List devices — proves the OAuth token works**

```
GET http://localhost:4000/api/clover/devices
```
```json
{"merchantId":"2N9FRNJANSV31","configuredDeviceId":null,"count":0,"devices":[]}
```
`count: 0` is correct — the sandbox test merchant owns no Mini. When you get
one, its `serial` appears here and goes into `CLOVER_DEVICE_ID`.

**b) No `CLOVER_DEVICE_ID` → Card checkout refuses, charges nothing**

HTTP **409**, `code: "clover_not_ready"`, the pending checkout is marked
`failed`, **no order row**, and Order Entry keeps the cart and shows the message.

**c) A serial that doesn't exist → real Clover error, mapped**

With `CLOVER_DEVICE_ID=C035FAKESERIAL01`, Clover sandbox answers:

```json
{"message":"An invalid device serial number [C035FAKESERIAL01] or token was provided.",
 "requestType":"PAY","type":"BAD_REQUEST"}
```

That `requestType: "PAY"` is the proof the URL, headers and token are all
correct — Clover parsed the request and objected only to the serial. Result:
pending `failed`, no order, cart kept.

**d) Unreachable host → `orphaned`, never a silent success**

Set `CLOVER_API_BASE=https://127.0.0.1:9`. The pending checkout becomes
`orphaned` with *"the card MAY have been charged"* — deliberately **not**
`failed`, because after a dropped connection nobody knows what the customer did.

**e) Ping** — `POST /api/clover/device/ping` returns 409 with no serial set.

---

## 5. Testing WITH a Mini (later)

1. On the Mini, install and **open Cloud Pay Display**. It must be the app on
   screen — the device only accepts pushed payments while it is running.
2. `GET /api/clover/devices` → copy the Mini's `serial`.
3. Put it in `backend/.env` as `CLOVER_DEVICE_ID`, set `CLOVER_RAID`, restart.
4. `POST /api/clover/device/ping` → expect `{"connected": true}`.
5. Ring a small order in Order Entry and tap **Card**. The Mini shows the amount;
   the till shows *"Waiting for customer on the Clover Mini…"* with a **Cancel
   payment** button.
6. Complete it. Exactly one order appears on KDS, `orders.total` is
   tip-inclusive, and `payments.amount == orders.total`.
7. Try a cancel: **Cancel payment** calls `POST /connect/v1/device/cancel`; the
   Mini returns to its welcome screen and **no order** is created.

---

## 6. Known gaps / TODO for Phase 4–5

- **Reconcile sweep for `orphaned` rows is NOT built.** An `orphaned` checkout
  is recorded honestly and surfaced to the cashier, but nothing automatically
  asks Clover afterwards what really happened. Clover needs its **own**
  completion path — a Stripe PaymentIntent retrieve is not applicable. The
  lookup key already exists (`externalPaymentId` = pending id, dashes stripped),
  so the sweep has everything it needs. Deferred deliberately: it is a Phase 4
  concern and was not small enough to bolt on safely here.
- **Interac detection is provisional.** `processorPaymentType` is derived from
  Clover's `cardTransaction.cardType`; anything unrecognised is recorded as
  `card_present`, not guessed as Interac. Confirm against a real Interac tap
  before the Phase 4 refund rules depend on it.
- **Tip prompt behaviour** — see §2.
- No Clover refunds (Phase 4). A Clover payment row is recognised and refused
  with a 501 by the Phase 2 dispatch.
