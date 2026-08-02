#!/usr/bin/env node
/**
 * Schema drift guard — refuses a deploy (and a boot) when the database is
 * behind the code.
 *
 * THE FAILURE THIS PREVENTS
 * Deploying code that selects a column/table its migration hasn't created yet.
 * Every query against that table then 500s until someone notices and runs the
 * SQL by hand. It has happened twice: `is_upsell` took the whole menu down,
 * and the Refunds/KDS void migrations repeated it.
 *
 * HOW IT WORKS
 * backend/schema-requirements.json lists every table and added column declared
 * by database/*.sql (regenerate with `npm run schema:sync`). This compares that
 * manifest against information_schema in the live database and reports anything
 * missing, naming the migration file that provides it.
 *
 * FAIL CLOSED ON DRIFT, FAIL OPEN ON CONNECTIVITY
 * Confirmed drift is fatal — that is the whole point. But a database we cannot
 * reach is reported as "could not verify" (exit 2) rather than drift: an
 * unreachable database is already a broken deploy by other means, and turning a
 * transient blip into a boot crash-loop would be a self-inflicted outage.
 *
 * USAGE
 *   npm run check:schema      # exit 0 ok · 1 drift/stale manifest · 2 unverifiable
 * Also invoked automatically at server boot (see server.js).
 */
const fs = require("fs");
const path = require("path");

const MANIFEST_FILE = path.resolve(__dirname, "..", "schema-requirements.json");
const DB_DIR = path.resolve(__dirname, "..", "..", "database");

function loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    throw new Error(
      `Missing ${MANIFEST_FILE}. Run \`npm run schema:sync\` from backend/ and commit the result.`
    );
  }
  return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
}

/**
 * Compares the manifest against the live database.
 * @param {import('pg').ClientBase} db  a connected client or pool
 * @returns {Promise<{missingTables: Array, missingColumns: Array}>}
 */
async function findMissingSchema(db, manifest = loadManifest()) {
  const { rows: tableRows } = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  const haveTables = new Set(tableRows.map((r) => r.table_name));

  const { rows: colRows } = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const haveColumns = new Set(colRows.map((r) => `${r.table_name}.${r.column_name}`));

  const missingTables = manifest.tables.filter((t) => !haveTables.has(t.table));
  const missingColumns = manifest.columns.filter(
    // A column on a table that is itself missing is already covered by the
    // table entry — reporting both just makes the output noisier.
    (c) => haveTables.has(c.table) && !haveColumns.has(`${c.table}.${c.column}`)
  );

  return { missingTables, missingColumns };
}

/** Human-readable failure report, grouped by the migration that fixes it. */
function formatFailure({ missingTables, missingColumns }) {
  const byMigration = new Map();
  const add = (migration, label) => {
    if (!byMigration.has(migration)) byMigration.set(migration, []);
    byMigration.get(migration).push(label);
  };
  for (const t of missingTables) add(t.migration, `table ${t.table}`);
  for (const c of missingColumns) add(c.migration, `column ${c.table}.${c.column}`);

  const lines = [
    "",
    "  ============================================================",
    "  DATABASE SCHEMA IS BEHIND THE CODE — DEPLOY/BOOT BLOCKED",
    "  ============================================================",
    "",
    "  The code expects objects this database does not have. Serving",
    "  traffic now would 500 every query against these tables.",
    "",
  ];
  for (const [migration, items] of byMigration) {
    lines.push(`  ${migration}`);
    for (const item of items) lines.push(`      missing ${item}`);
    lines.push("");
  }
  lines.push("  FIX — apply the migration(s) above to THIS database first, then redeploy:");
  lines.push("");
  lines.push("    # production (Render External Database URL)");
  lines.push(`    psql "$DATABASE_URL" -f database/<file>.sql`);
  lines.push("");
  lines.push("    # local docker");
  lines.push(
    "    docker exec -i narcos_tacos_db psql -U narcos -d narcos_tacos < database/<file>.sql"
  );
  lines.push("  ============================================================");
  lines.push("");
  return lines.join("\n");
}

/**
 * Dev-only guard: if database/ is present (it is not on Render, whose Root
 * Directory is backend/), confirm the committed manifest still matches the SQL.
 * Catches "added a migration but forgot to run schema:sync", which would leave
 * the safety net with a silent hole.
 */
function manifestStaleness(manifest) {
  if (!fs.existsSync(DB_DIR)) return null;
  const { derive } = require("./derive-schema-requirements");
  const fresh = derive();
  const key = (m) => JSON.stringify({ tables: m.tables, columns: m.columns });
  return key(fresh) === key(manifest) ? null : fresh;
}

async function main() {
  const { Pool } = require("pg");
  require("dotenv").config();

  const manifest = loadManifest();

  const stale = manifestStaleness(manifest);
  if (stale) {
    console.error(
      "\n  schema-requirements.json is out of date with database/*.sql." +
        "\n  Run `npm run schema:sync` from backend/ and commit the result.\n"
    );
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error("  DATABASE_URL is not set — cannot verify schema.");
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let result;
  try {
    result = await findMissingSchema(pool, manifest);
  } catch (err) {
    console.error(`  Could not verify schema (database unreachable): ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(2);
  }
  await pool.end().catch(() => {});

  if (result.missingTables.length || result.missingColumns.length) {
    console.error(formatFailure(result));
    process.exit(1);
  }

  console.log(
    `  Schema OK — ${manifest.tables.length} tables, ${manifest.columns.length} added columns present.`
  );
  process.exit(0);
}

module.exports = { findMissingSchema, formatFailure, loadManifest };

if (require.main === module) {
  main();
}
