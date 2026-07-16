-- ============================================================
-- Back Office login: email + password + TOTP 2FA (owner/admin only)
-- ------------------------------------------------------------
-- Replaces PIN login for the Back Office ONLY. Order Entry/KDS PIN login
-- (pin_hash, /api/auth/login) is completely untouched — every role,
-- including owner/admin, keeps using their PIN there.
--
-- `email` already existed on staff (schema.sql) but was unused and had no
-- uniqueness constraint. This migration adds a case-insensitive unique
-- index on it (so "Ali@x.com" and "ali@x.com" can't collide) plus the new
-- columns needed for password + TOTP + password-reset:
--
--   password_hash       — bcrypt, same hashing pattern as pin_hash
--   totp_secret          — base32 TOTP secret (otplib), set the moment a
--                           2FA setup begins, confirmed via totp_enabled
--   totp_enabled          — flips true only after one correct code is
--                           verified against totp_secret (first-time setup
--                           or a resumed/interrupted setup)
--   reset_token           — SHA-256 hex digest of the emailed reset token,
--                           NOT the raw token itself (same principle as
--                           never storing PINs/passwords in plaintext) —
--                           the raw token only ever exists in the emailed
--                           link and briefly in the request body
--   reset_token_expiry    — 1 hour from issuance; checked server-side
--
-- ONLY owner/admin ever have email/password_hash/totp_* set — manager/
-- cashier/kitchen have no Back Office access at all, so the app never
-- writes these columns for them (enforced server-side, not by a DB
-- constraint, since the schema stays role-agnostic like the rest of the
-- staff table).
-- ============================================================

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS password_hash TEXT,
    ADD COLUMN IF NOT EXISTS totp_secret TEXT,
    ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS reset_token TEXT,
    ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE indexname = 'staff_email_unique_ci'
    ) THEN
        CREATE UNIQUE INDEX staff_email_unique_ci ON staff (lower(email))
            WHERE email IS NOT NULL;
    END IF;
END $$;
