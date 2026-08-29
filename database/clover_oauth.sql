-- ============================================================
-- Clover Mini semi-integration — OAuth token store (Phase 1)
-- ------------------------------------------------------------
-- Implements Phase 1 of docs/architecture/plan.md /
-- docs/architecture/task.md. Schema ONLY for the OAuth handshake: no payment
-- code reads any of this, PAYMENTS_PROVIDER stays 'mock'|'stripe' (locked
-- decision L8/L9), and applying this migration changes nothing staff can see.
-- That is deliberate — CLAUDE.md's standing deploy-order rule wants the schema
-- in place BEFORE the code that reads it.
--
-- Everything here is a NEW table. Nothing existing is altered, no enum gains a
-- member, and no stripe_* column is renamed or touched (explicitly out of scope
-- for this slice).
--
-- WHY A NEW TABLE RATHER THAN A SETTINGS ROW
-- This repo has no generic settings/secrets/key-value table — every existing
-- table is a domain table (staff, orders, device_pairings, pending_checkouts,
-- stripe_events …). There was nothing to reuse, and inventing a general-purpose
-- "secrets" bucket to hold one integration's tokens would be a bigger and less
-- reviewable change than a purpose-built table whose columns are self-documenting.
--
-- WHY NOT A FILE ON DISK
-- Render's filesystem is ephemeral: a redeploy or a restart would silently drop
-- the token and the integration would look randomly broken. The database is the
-- only durable server-side store this app has, and it is already off-git.
--
-- SECURITY NOTES
--   * Rows here are bearer credentials for a merchant's Clover account. They are
--     never returned by any API response, never logged, and never rendered into
--     the OAuth callback's HTML page. GET /api/clover/status reports only
--     WHETHER a token exists.
--   * The token column is stored as plain text, exactly like staff.totp_secret
--     already is. Encrypting it at rest would need a key that itself lives in
--     the same environment, so it protects against a stolen DB dump but not a
--     compromised server. Worth revisiting before production go-live (Phase 5);
--     over-engineering it in a sandbox-only slice is not.
--   * api_base is stored alongside the token so a SANDBOX token can never be
--     mistaken for a PRODUCTION one. Clover issues both from the same app
--     shape, and the only thing distinguishing them is which host minted them.
-- ============================================================

CREATE TABLE IF NOT EXISTS clover_oauth_tokens (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Clover's merchant UUID (e.g. the sandbox test merchant). One row per
    -- merchant: re-connecting the app REPLACES the row rather than appending,
    -- so there is never an ambiguous "which token is current?" question.
    merchant_id                 TEXT NOT NULL UNIQUE,

    -- Which Clover host minted these tokens. Sandbox and production are
    -- different worlds; a token from one is useless (and dangerous to guess at)
    -- against the other.
    api_base                    TEXT NOT NULL,

    -- The bearer credentials. NEVER logged, NEVER returned by an API.
    access_token                TEXT NOT NULL,
    refresh_token               TEXT,                    -- NULL if Clover issued a non-expiring v1 token

    -- Clover returns these as epoch seconds; the server converts before insert.
    -- NULL means "no stated expiry" (the v1 token shape), not "expired".
    access_token_expires_at     TIMESTAMPTZ,
    refresh_token_expires_at    TIMESTAMPTZ,

    -- Which token endpoint actually answered ('v2' or 'v1'). Recorded because
    -- only the v2 exchange yields a refresh token, so this explains at a glance
    -- why refresh_token may be NULL.
    token_flow                  TEXT,

    -- Result of the read-only merchant ping, so GET /api/clover/status can
    -- answer ok | fail | never without making a live call on every request.
    -- NULL = never pinged.
    last_merchant_ping          TEXT CHECK (last_merchant_ping IN ('ok', 'fail')),
    last_merchant_ping_at       TIMESTAMPTZ,
    merchant_name               TEXT,                    -- cached from the last successful ping, display only

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The status endpoint and the callback both want "the most recently connected
-- merchant" when no explicit merchant id is configured.
CREATE INDEX IF NOT EXISTS clover_oauth_tokens_updated_idx
    ON clover_oauth_tokens (updated_at DESC);
