-- ============================================================
-- Narcos Tacos — Test Staff Seed (non-owner roles)
-- Adds Manager / Cashier / Kitchen accounts at Lawrence East so
-- non-owner role behaviour can be tested end-to-end.
--
-- Same pattern as seed_staff.sql: PINs hashed with pgcrypto's
-- bcrypt-compatible crypt() (never stored as plain text). Unlike
-- owners (location_id NULL = all locations), these are scoped to
-- the single Lawrence East location.
--
-- Test PINs: Manager 2001, Cashier 3001, Kitchen 4001.
-- Kitchen does NOT use PIN login (KDS is a no-auth screen) but the
-- record still exists for future payroll/reporting.
--
-- Idempotent: re-running will not create duplicates.
-- ============================================================

INSERT INTO staff (location_id, name, title, pin_hash, role, active)
SELECT loc.id, v.name, v.title, crypt(v.pin, gen_salt('bf')), v.role::staff_role, true
FROM (VALUES
    ('Test Manager', 'Manager', '2001', 'manager'),
    ('Test Cashier', 'Cashier', '3001', 'cashier'),
    ('Test Kitchen', 'Kitchen', '4001', 'kitchen')
) AS v(name, title, pin, role)
CROSS JOIN (
    SELECT id FROM locations WHERE name = 'Narcos Tacos - Lawrence East'
) AS loc
WHERE NOT EXISTS (
    SELECT 1 FROM staff s WHERE s.name = v.name
);
