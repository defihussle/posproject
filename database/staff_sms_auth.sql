-- ============================================================
-- Staff SMS auth - P3 Slice 1 (schema only)
-- ------------------------------------------------------------
-- Groundwork for staff phone verification: first-time PIN setup, forgot-PIN,
-- owner Back Office SMS login/reset. THIS FILE SENDS NOTHING and adds no
-- route that sends anything. Slice 1 code only stores staff.phone and lets a
-- staff row exist without a PIN.
--
-- 1. staff.pin_hash becomes nullable
--    A new hire can be created with a phone and no PIN; they will set their
--    own PIN later by SMS (a later slice). NULL means "no PIN yet". Every
--    place that bcrypt-compares against pin_hash (PIN login,
--    assertPinAvailable, Back Office setup-start, verifyStaffPin, PIN change)
--    must skip or reject NULL rows - see backend/server.js.
--
-- 2. staff.phone is unique among rows that have one
--    It will identify the account for SMS codes, so two rows sharing a number
--    would make "which account is this code for?" ambiguous. The app writes
--    it normalized to E.164 (+1XXXXXXXXXX, backend/lib/phone.js); blank is
--    stored as NULL, and NULLs never collide.
--    This is SEPARATE from orders.customer_phone and order_notifications,
--    which are customer data and are not touched here.
--
-- 3. staff_auth_codes
--    One row per code issued to a staff member. Only the hash of the code is
--    stored. A code is usable while consumed_at IS NULL, now() < expires_at
--    and attempts < max_attempts. Deliberately NOT order_notifications: that
--    table is order-scoped customer messaging with its own UNIQUE lock.
--
-- NOTE ON THE SCHEMA GUARD
-- `npm run schema:sync` adds staff_auth_codes to
-- backend/schema-requirements.json. From then on the Render pre-deploy check
-- and the server boot check REFUSE to run until the table exists. Apply this
-- file to PRODUCTION before pushing the manifest or any code that depends on
-- it. See the Schema Change Checklist in CLAUDE.md. (The guard does not check
-- nullability or indexes, so steps 1-2 are only verified by applying the file.)
--
-- Re-runnable: every statement is IF NOT EXISTS, catalog-guarded, or
-- idempotent.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- 1. No-PIN staff rows.
ALTER TABLE staff ALTER COLUMN pin_hash DROP NOT NULL;

-- 2. Unique phone. Blank strings become NULL first so they don't collide,
-- then refuse loudly (instead of a bare unique-violation) if two rows already
-- share a number - someone must fix those rows by hand before this can apply.
UPDATE staff SET phone = NULL WHERE phone IS NOT NULL AND btrim(phone) = '';

DO $$
DECLARE
    dup TEXT;
BEGIN
    SELECT phone INTO dup FROM staff
     WHERE phone IS NOT NULL
     GROUP BY phone HAVING count(*) > 1
     LIMIT 1;
    IF dup IS NOT NULL THEN
        RAISE EXCEPTION 'staff_sms_auth.sql: two or more staff rows share a phone number - clear or fix the duplicates, then re-run';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS staff_phone_unique
    ON staff (phone) WHERE phone IS NOT NULL;

-- 3. Staff verification codes.
CREATE TABLE IF NOT EXISTS staff_auth_codes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id      UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    purpose       TEXT NOT NULL,
    -- Hash of the code, never the code itself.
    code_hash     TEXT NOT NULL,
    -- E.164 number the code was sent to (may differ from staff.phone for
    -- phone_change).
    to_phone      TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 5,
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'staff_auth_codes_purpose_check'
           AND conrelid = 'staff_auth_codes'::regclass
    ) THEN
        ALTER TABLE staff_auth_codes
            ADD CONSTRAINT staff_auth_codes_purpose_check
            CHECK (purpose IN ('pin_setup', 'pin_reset', 'bo_login', 'bo_reset', 'phone_change'));
    END IF;
END $$;

-- Lookups are "latest live code for this staff member + purpose", and send
-- throttling counts recent rows per staff member.
CREATE INDEX IF NOT EXISTS staff_auth_codes_staff_purpose_idx
    ON staff_auth_codes (staff_id, purpose, created_at DESC);
