-- ============================================================
-- device_pairings — device-level trust layer under Order Entry/KDS
-- ------------------------------------------------------------
-- Orthogonal to staff PIN identity (see device-pairing-plan.md,
-- "Background"): pairing a device only proves "an owner/admin
-- authorized this physical tablet once," nothing about who's currently
-- using it. staffId/PIN login is completely unchanged by this table.
--
-- One row per pairing LIFECYCLE, covering both the pending-code stage
-- and the paired-device stage:
--   - A row is created the moment a code is generated (device_id is
--     pre-allocated then, since it's just a random UUID with nothing
--     device-specific about it yet) but device_name/paired_at stay NULL
--     until the code is actually redeemed — a device doesn't have a
--     name until a human sitting at it types one in.
--   - paired_at is set exactly once, at redemption. A code is single-use
--     by construction: once paired_at is set, the same code can never
--     validate again (the pairing endpoint's WHERE clause requires
--     paired_at IS NULL), regardless of code_expires_at.
--   - revoked_at/revoked_by mark a previously-paired device as no
--     longer trusted. Revocation is DB-driven, not cookie-expiry-driven
--     — the device's signed cookie stays cryptographically valid for a
--     long time (see issueDeviceCookie in server.js), but every
--     check-in re-queries this table, so a revoked device stops working
--     within one check-in cycle instead of only when its JWT expires.
--   - Rows are never deleted, including revoked ones — this table IS
--     the audit trail (who generated a code, when/whether it was
--     redeemed, who revoked it and when), same "never hard-delete
--     history" spirit as staff/shifts elsewhere in this schema.
--
-- Codes are stored hashed (SHA-256 of the raw code, same pattern as
-- staff.reset_token) — the raw code only ever exists in the HTTP
-- response at generation time and in the pairing request body; it's
-- never persisted.
-- ============================================================

CREATE TABLE IF NOT EXISTS device_pairings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id           UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
    device_name         TEXT,               -- NULL until paired (human-entered, not auto-detected — see plan)
    pairing_code_hash   TEXT NOT NULL,       -- SHA-256 hex digest of the raw code, never the raw code itself
    code_expires_at     TIMESTAMPTZ NOT NULL,
    paired_at           TIMESTAMPTZ,         -- NULL until the code is redeemed; single-use once set
    created_by          UUID NOT NULL REFERENCES staff(id),
    revoked_at          TIMESTAMPTZ,
    revoked_by          UUID REFERENCES staff(id),
    last_seen_at        TIMESTAMPTZ,         -- updated on every requireDevicePairing check-in
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every pairing attempt looks up by code hash — worth an index given
-- it's hit on every code entry, not just admin-facing queries.
CREATE INDEX IF NOT EXISTS idx_device_pairings_code_hash ON device_pairings(pairing_code_hash);
