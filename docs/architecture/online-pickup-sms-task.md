# Online Pickup SMS — Task Checklist

Plan: `online-pickup-sms-plan.md`

- Current slice: **3 — done locally, not pushed**
- `ORDER_ENABLED=false`
- No Flex / Cloud Pay Display involvement
- Email later
- **Do not set `ONLINE_SMS_ENABLED=true` on Render yet.**

| Slice | Work                                          | Status      |
|-------|-----------------------------------------------|-------------|
| Start | Docs only                                     | DONE        |
| 0     | Read-only scan                                | DONE        |
| 1     | Schema `order_notifications` + phone normalize | DONE in repo + local Docker — Render apply pending |
| 2     | Placed SMS on new ingest                      | DONE locally — not pushed |
| 3     | Started + ready on KDS PATCH                  | DONE locally — not pushed |
| 4     | Website phone validation / copy               | not started |
| 5     | Render SQL + Twilio env + one test phone      | not started |

## Slice 1 detail

- [x] `database/online_order_sms.sql` — `order_notifications`, `UNIQUE (order_id, event)`, re-runnable
- [x] `npm run schema:sync` → `backend/schema-requirements.json` lists `order_notifications`
- [x] `backend/lib/phone.js` — `normalizePhone()`
- [x] `tests/phone_normalize_acceptance.mjs` passes
- [x] Applied to local Docker (twice, clean)
- [ ] Human: apply `online_order_sms.sql` to Render
- [ ] Human: `npm run check:schema` against Render prints `Schema OK`

## Slice 2 detail

- [x] `backend/lib/onlineSms.js` — `notifyOnlineOrderPlaced()`, Twilio REST via `fetch`, 8 s timeout, no retry
- [x] `backend/server.js` — one require + one un-awaited call after ingest COMMIT (201 path only)
- [x] `backend/.env.example` — `TWILIO_*` names, `ONLINE_SMS_ENABLED` blank
- [x] `tests/online_sms_acceptance.mjs` passes (fake pool + stubbed fetch)
- [x] Local ingest: flag off → 201, no row; replay → 200, no row; flag on + no Twilio → `skipped`; bad phone → `skipped`
- [ ] Push only after Render has the Slice 1 SQL and `Schema OK`

## Slice 3 detail

- [x] `onlineSms.js` — `notifyOnlineOrder(pool, event, …)`; `SMS_COPY` holds placed / started / ready
- [x] `PATCH /api/orders/:id/status` — locked select widened to `source, customer_phone, order_number`; un-awaited call after COMMIT, `source = 'online'` only
- [x] `/status/revert` — no SMS call (comment only)
- [x] `tests/online_sms_acceptance.mjs` — started / ready copy, second call no send, flag off, unknown event
- [x] Local PATCH run: online #377 preparing → one `started` row; repeat → 400, still one; ready → one `ready` row; revert + ready → still one; pos #376 → no rows
- [ ] Push only after Render has the Slice 1 SQL and `Schema OK`
