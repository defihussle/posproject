-- ============================================================
-- Fix: "à la carte" stored as "?? la carte"
-- ------------------------------------------------------------
-- Same root cause as the earlier Consomé repair: the à (UTF-8 C3 A0) was
-- mangled into two literal '?' bytes when the original seed was piped in
-- through a non-UTF-8 codepage (see CLAUDE.md "Known Gotchas").
-- Applied by executing THIS FILE against the container (docker exec -i
-- narcos_tacos_db psql ... < file.sql) — never by pasting the accented text
-- inline through a shell string.
-- Matched by the corrupted value so it's idempotent (once fixed, matches
-- nothing). Verify afterward:
--   SELECT description, encode(convert_to(description,'UTF8'),'hex')
--   FROM menu_items WHERE description LIKE '%la carte%';
-- à must appear as c3a0.
-- ============================================================

UPDATE menu_items
SET description = 'One taco, à la carte'
WHERE description = 'One taco, ?? la carte';

UPDATE menu_items
SET description = 'One birria taco, à la carte'
WHERE description = 'One birria taco, ?? la carte';
