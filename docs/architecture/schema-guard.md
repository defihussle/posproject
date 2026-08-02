# Schema Guard — stopping "deployed before the migration ran"

Companion to the **CRITICAL migration rule** in `CLAUDE.md`. This documents the
automated backstop behind it: what it checks, how it fails, and what to do when
it fires.

## The failure it exists to prevent

Deploying code that references a column or table its migration hasn't created
yet. Postgres rejects the query, so *every* request touching that table 500s
until someone notices and runs the SQL by hand. It has happened twice:

- **`is_upsell`** — code-first deploy took the entire menu down in production.
- **Refunds / KDS void** — the same mistake repeated on `orders.voided_from_status`
  and the `order_refunds` tables.

The written rule ("run migrations on prod first") was already in `CLAUDE.md`
the second time. A rule that depends on remembering is not a control; this is
the control.

## Why not a migration runner

The textbook fix — auto-apply pending migrations on deploy — is the wrong first
step for this repo:

- `database/*.sql` has **no ordering** (descriptive filenames, no numeric
  prefixes) and **no tracking table**, so "pending" isn't defined.
- Several files are **not idempotent** (`menu_ux_enhancements.sql`,
  `fix_a_la_carte_encoding.sql` have no guards at all).
- `schema.sql` creates the base tables outright — re-running it against
  production would be destructive.

Retrofitting an ordered, idempotent, tracked migration set is a large change
with real production risk. The guard below is small, fails closed, and can be
replaced by a real runner later without anything else changing.

## How it works

**The repo's migration files are the contract.** Anything `database/*.sql`
declares, the database must already have.

1. `backend/scripts/derive-schema-requirements.js` scans `database/*.sql` for
   `CREATE TABLE [IF NOT EXISTS] x` and `ALTER TABLE x ... ADD COLUMN [IF NOT
   EXISTS] y`, recording which file declares each object.
2. It writes `backend/schema-requirements.json` — **committed**, currently 23
   tables and 18 added columns.
3. `backend/scripts/check-schema.js` compares that manifest against
   `information_schema` in the live database and reports anything missing,
   named by the migration that provides it.

The manifest exists because Render's Root Directory for the API service is
`backend/` — **`database/` is not present on the deployed filesystem**, so the
check cannot read the SQL at deploy time.

Nothing else is parsed. Indexes, constraints and enum values are deliberately
out of scope: the failure mode is a missing column/table, and a narrow check
that never false-positives is worth more than a broad one that cries wolf.

## Where it runs

| Enforcement point | Effect on failure |
| --- | --- |
| Render **Pre-Deploy Command** (`npm run check:schema`) | Deploy fails; previous version keeps serving |
| **Server boot** (`assertSchemaCurrent()` in `server.js`) | `process.exit(1)`; health check fails, Render rolls back |
| **Local** (`npm run check:schema`) | Non-zero exit + the exact `psql` command to fix |

The boot check is the real backstop — it works regardless of dashboard
configuration, and it also catches a manual restart or a rollback onto a
database that has since moved on.

## Fail closed on drift, fail open on connectivity

A deliberate asymmetry:

- **Confirmed drift** (connected, object genuinely absent) → fatal. Exit 1.
- **Cannot connect** → loud warning, server starts anyway. Exit 2 from the CLI.

An unreachable database is already a broken deploy by other means. Turning a
transient connection blip at boot into a crash-loop would be an outage we
caused ourselves, so "could not verify" is never treated as "verified bad".

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Schema matches the manifest |
| `1` | Drift confirmed, **or** the committed manifest is stale vs `database/*.sql` |
| `2` | Could not verify (no `DATABASE_URL`, or database unreachable) |

## Adding a migration — the one habit this needs

```bash
# 1. write database/your_migration.sql, then:
cd backend && npm run schema:sync     # regenerates schema-requirements.json
git add database/your_migration.sql backend/schema-requirements.json

# 2. apply to PRODUCTION first
psql "$RENDER_EXTERNAL_DATABASE_URL" -f database/your_migration.sql

# 3. then push/deploy
```

If you skip step 1, `npm run check:schema` fails with *"schema-requirements.json
is out of date"* — the staleness check re-derives from `database/*.sql`
whenever that folder is present (i.e. locally, never on Render). That way a
forgotten `schema:sync` surfaces in dev rather than silently leaving a hole in
the net.

If you skip step 2, the deploy is blocked and you get:

```
  ============================================================
  DATABASE SCHEMA IS BEHIND THE CODE — DEPLOY/BOOT BLOCKED
  ============================================================

  upsell_items.sql
      missing column menu_items.is_upsell

  FIX — apply the migration(s) above to THIS database first, then redeploy:
    psql "$DATABASE_URL" -f database/<file>.sql
```

## Render dashboard setup

One field, on the **backend web service** only:

- **Settings → Build & Deploy → Pre-Deploy Command**: `npm run check:schema`

`DATABASE_URL` is already set on the service, and the Pre-Deploy Command runs
with the same environment, so nothing else is needed. Pre-Deploy is a paid-tier
feature; if it isn't available, the boot check alone still blocks the bad
version from serving — you lose the pre-deploy signal but not the protection.

## Known limits

- **Only tables and added columns.** A migration that only changes a constraint,
  index, enum value or default is invisible to the guard.
- **Columns declared in `schema.sql` itself** are covered only at table level.
- **It cannot detect a migration you never wrote.** The contract is
  repo-declares → database-must-have; code that references a column no
  migration declares is still on you (and on review).
- **Renames** read as "one missing, one extra" — the guard sees the missing
  side, which is the correct alarm, but the message names the migration file,
  not the rename.
