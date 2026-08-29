-- ============================================================
-- Clover Mini semi-integration — refund id column (Phase 4)
-- ------------------------------------------------------------
-- Implements Phase 4 of docs/architecture/plan.md / task.md.
-- ONE additive, nullable column. No existing column is altered, no enum gains
-- a member, no constraint changes, and nothing is backfilled — so applying
-- this changes nothing staff can see and nothing that currently runs.
--
-- WHY A NEW COLUMN AND NOT A REUSED ONE
-- order_refunds already carries `stripe_refund_id`, and it is tempting to put
-- a Clover refund id there. That is explicitly rejected:
--
--   * It would make the column lie. `stripe_refund_id` is indexed and is read
--     by the Stripe webhook resolver (resolveLocalRefundId) to match an
--     incoming Stripe event to a local refund row. A Clover id sitting in it
--     is a value that resolver could match against by accident, and it makes
--     every future "is this a Stripe refund?" query wrong.
--   * The repo already has one class of this bug on record — see plan.md §5,
--     "the schema is stripe-shaped" — and Phase 2's whole point was removing
--     env-flag-versus-row confusion from the money path. Reintroducing it in
--     the schema would undo that.
--
-- WHY NOT A NEUTRAL `processor_refund_id`
-- Considered, and it is the tidier long-term shape. Rejected for THIS slice
-- because it would leave two columns meaning the same thing (the existing
-- stripe_refund_id plus the new one) with no migration of the old data, which
-- is a worse and less reviewable state than one clearly-named column per
-- processor. Consolidating both into a neutral pair
-- (processor, processor_refund_id) is a separate, deliberate migration and
-- belongs with the rest of the stripe_* renaming in plan.md §5 — not smuggled
-- in behind a refund feature.
--
-- NOTE ON THE SCHEMA GUARD
-- backend/schema-requirements.json is regenerated from this file by
-- `npm run schema:sync`. Once that manifest lists this column, the backend
-- REFUSES TO BOOT until the column exists in the database it connects to.
-- That is deliberate (docs/architecture/schema-guard.md) and it is exactly why
-- this migration must reach PRODUCTION *before* the code that reads it is
-- deployed. See the Schema Change Checklist in CLAUDE.md.
-- ============================================================

-- Clover's own id for the reversal, returned by
--   POST {connectBase}/v1/payments/{paymentId}/refunds
-- NULL on every existing row, on every cash/internal reversal, and on every
-- Stripe reversal — exactly as stripe_refund_id is NULL on a Clover one.
ALTER TABLE order_refunds
    ADD COLUMN IF NOT EXISTS clover_refund_id TEXT;

-- Mirrors idx_order_refunds_stripe_refund_id. Partial, because the column is
-- NULL on the overwhelming majority of rows and only the non-null ones are
-- ever looked up by processor id.
CREATE INDEX IF NOT EXISTS idx_order_refunds_clover_refund_id
    ON order_refunds (clover_refund_id)
    WHERE clover_refund_id IS NOT NULL;
