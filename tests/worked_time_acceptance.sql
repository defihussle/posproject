-- ============================================================
-- Worked-time acceptance tests (rolled-back; changes NOTHING).
-- ------------------------------------------------------------
-- Locks the three shipped worked-time behaviors before the canonical
-- worked-time helper refactor (see docs/architecture/reports-plan.md,
-- "Refactor approach & test-first acceptance cases"). Each is the exact
-- case a specific commit fixed:
--   Case 1  d56b6d8  My Hours "Today" includes a pre-midnight open shift
--                    -> worked = hours since today's midnight (not 0)
--   Case 2  6b3cf9e  clock-status subtracts break time (breakSeconds=1800,
--                    worked-if-subtracted = 12600)
--   Case 3  8ad8fbe  clock-out returns worked/break = 12600 / 1800
--
-- Run:
--   docker exec -i narcos_tacos_db psql -U narcos -d narcos_tacos < tests/worked_time_acceptance.sql
--
-- Each case is its own BEGIN…ROLLBACK, so it is safe against any database
-- (local or prod) and leaves no trace. now() is constant within a
-- transaction, so the arithmetic below is exact (gross = 4h = 14400s, etc.).
-- The `result` column is PASS/FAIL; the refactor must keep all three PASS.
-- ============================================================

\set L 0baa9930-cefb-4830-8746-c1bbd8a24442
\set A a652d012-0066-43e6-8b1c-cda5157527c7
\set TZ America/Toronto

-- ---- Case 1 (d56b6d8): My Hours "Today" — pre-midnight open shift ----
-- Open shift clocked in 2h before today's local midnight, still open.
-- Expect: NOT selected by the old `clock_in >= today` filter, IS selected
-- by the overlap filter, and worked = seconds since midnight (> 0).
BEGIN;
CREATE TEMP TABLE _s (id uuid) ON COMMIT DROP;
WITH ins AS (
  INSERT INTO shifts (location_id, staff_id, clock_in, clock_out)
  VALUES (:'L', :'A', (date_trunc('day', now() AT TIME ZONE :'TZ') - interval '2 hours') AT TIME ZONE :'TZ', NULL)
  RETURNING id
) INSERT INTO _s SELECT id FROM ins;
WITH b AS (
  SELECT (date_trunc('day', now() AT TIME ZONE :'TZ') AT TIME ZONE :'TZ') AS rs,
         ((date_trunc('day', now() AT TIME ZONE :'TZ') + interval '1 day') AT TIME ZONE :'TZ') AS re
),
calc AS (
  SELECT
    GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(s.clock_out, now()), b.re) - GREATEST(s.clock_in, b.rs)))
      - COALESCE((SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM
            (LEAST(COALESCE(bk.break_end, now()), b.re) - GREATEST(bk.break_start, b.rs)))))
          FROM shift_breaks bk WHERE bk.shift_id = s.id), 0)) AS worked_s,
    (s.clock_in >= b.rs) AS old_filter_includes,
    (s.clock_in < b.re AND (s.clock_out IS NULL OR s.clock_out > b.rs)) AS overlap_includes,
    round(EXTRACT(EPOCH FROM (now() - b.rs))) AS since_midnight_s
  FROM shifts s CROSS JOIN b WHERE s.id IN (SELECT id FROM _s)
)
SELECT 'case1_pre_midnight_open_shift' AS test,
  CASE WHEN round(worked_s) = since_midnight_s AND worked_s > 0
            AND overlap_includes AND NOT old_filter_includes
       THEN 'PASS' ELSE 'FAIL' END AS result,
  round(worked_s) AS got_worked_s, since_midnight_s AS expected_worked_s,
  overlap_includes, old_filter_includes
FROM calc;
ROLLBACK;

-- ---- Case 2 (6b3cf9e): break time subtracted (clock-status) ----
-- Open 4h shift with one completed 30m break. clock-status returns
-- breakSeconds (completed breaks); the live timer shows elapsed - breaks.
BEGIN;
CREATE TEMP TABLE _s (id uuid) ON COMMIT DROP;
WITH ins AS (
  INSERT INTO shifts (location_id, staff_id, clock_in, clock_out)
  VALUES (:'L', :'A', now() - interval '4 hours', NULL) RETURNING id
) INSERT INTO _s SELECT id FROM ins;
INSERT INTO shift_breaks (shift_id, break_start, break_end)
SELECT id, now() - interval '3 hours', now() - interval '2 hours 30 minutes' FROM _s;
WITH calc AS (
  SELECT
    COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (bk.break_end - bk.break_start)))
                FROM shift_breaks bk WHERE bk.shift_id = s.id AND bk.break_end IS NOT NULL), 0) AS break_s,
    EXTRACT(EPOCH FROM (now() - s.clock_in)) AS gross_s
  FROM shifts s WHERE s.id IN (SELECT id FROM _s)
)
SELECT 'case2_break_subtracted' AS test,
  CASE WHEN break_s = 1800 AND (gross_s - break_s) = 12600 THEN 'PASS' ELSE 'FAIL' END AS result,
  break_s AS got_break_s, 1800 AS expected_break_s,
  (gross_s - break_s) AS got_worked_if_subtracted_s, 12600 AS expected_worked_s
FROM calc;
ROLLBACK;

-- ---- Case 3 (8ad8fbe): clock-out returns worked/break ----
-- Same 4h shift + 30m break, then clocked out now. Expect worked = elapsed
-- minus breaks = 12600s (3.5h), break = 1800s (30m).
BEGIN;
CREATE TEMP TABLE _s (id uuid) ON COMMIT DROP;
WITH ins AS (
  INSERT INTO shifts (location_id, staff_id, clock_in, clock_out)
  VALUES (:'L', :'A', now() - interval '4 hours', NULL) RETURNING id
) INSERT INTO _s SELECT id FROM ins;
INSERT INTO shift_breaks (shift_id, break_start, break_end)
SELECT id, now() - interval '3 hours', now() - interval '2 hours 30 minutes' FROM _s;
UPDATE shifts SET clock_out = now() WHERE id IN (SELECT id FROM _s);
WITH calc AS (
  SELECT
    EXTRACT(EPOCH FROM (s.clock_out - s.clock_in)) AS gross_s,
    COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (bk.break_end - bk.break_start)))
                FROM shift_breaks bk WHERE bk.shift_id = s.id), 0) AS break_s
  FROM shifts s WHERE s.id IN (SELECT id FROM _s)
)
SELECT 'case3_clock_out_worked_break' AS test,
  CASE WHEN GREATEST(0, gross_s - break_s) = 12600 AND break_s = 1800 THEN 'PASS' ELSE 'FAIL' END AS result,
  GREATEST(0, gross_s - break_s) AS got_worked_s, 12600 AS expected_worked_s,
  break_s AS got_break_s, 1800 AS expected_break_s
FROM calc;
ROLLBACK;
