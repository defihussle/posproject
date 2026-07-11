-- ============================================================
-- Narcos Tacos — Initial Owner Staff Seed
-- Temporary PINs (1234/1235/1236) — owners should change these
-- via the "Change My PIN" flow once that's built.
--
-- PINs are hashed using pgcrypto's bcrypt-compatible crypt() function,
-- never stored as plain text. location_id is NULL for owners since
-- they have access across all locations (per schema design).
-- ============================================================

INSERT INTO staff (location_id, name, title, pin_hash, role, active)
VALUES
    (NULL, 'Ali Barakat',   'Owner', crypt('1234', gen_salt('bf')), 'owner', true),
    (NULL, 'Umran Hanifi',  'Owner', crypt('1235', gen_salt('bf')), 'owner', true),
    (NULL, 'Saif Omar',     'Owner', crypt('1236', gen_salt('bf')), 'owner', true);

-- Manager not yet provided — add here when ready, following the same pattern
-- but with a real location_id (managers are scoped to one location):
-- INSERT INTO staff (location_id, name, title, pin_hash, role, active)
-- VALUES (
--     (SELECT id FROM locations WHERE name = 'Narcos Tacos - Lawrence East'),
--     '[Manager Name]', 'Manager', crypt('[PIN]', gen_salt('bf')), 'manager', true
-- );
