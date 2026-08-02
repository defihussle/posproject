#!/usr/bin/env node
/**
 * Regenerates backend/schema-requirements.json from the migration files in
 * database/ (repo root).
 *
 * WHY THIS EXISTS
 * The Render service's Root Directory is `backend`, so database/*.sql is NOT
 * present on the deployed filesystem. The deploy-time and boot-time schema
 * checks therefore read a committed JSON manifest instead of the SQL. This
 * script is what keeps that manifest honest: run it whenever you add a
 * migration (`npm run schema:sync`) and commit the result alongside the .sql.
 *
 * WHAT IT EXTRACTS
 * Every object a migration declares:
 *   - CREATE TABLE [IF NOT EXISTS] <table>
 *   - ALTER TABLE <table> ... ADD COLUMN [IF NOT EXISTS] <column>
 * Each is recorded with the file that declares it, so a failure can name the
 * exact migration to run. Nothing else is parsed — indexes, constraints and
 * enum values are deliberately out of scope: the failure mode this guards
 * against is code selecting a column/table that does not exist yet, which is
 * what took the menu down (is_upsell) and what the Refunds/KDS void
 * migrations repeated.
 */
const fs = require("fs");
const path = require("path");

const DB_DIR = path.resolve(__dirname, "..", "..", "database");
const OUT_FILE = path.resolve(__dirname, "..", "schema-requirements.json");

// Strip -- line comments and /* */ blocks so commented-out DDL is not treated
// as a requirement. Dollar-quoted bodies ($$ … $$) are left alone: an ALTER
// inside a DO block still terminates with ';' and should still be picked up.
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function derive() {
  if (!fs.existsSync(DB_DIR)) {
    throw new Error(`Cannot find migrations directory: ${DB_DIR}`);
  }
  const files = fs.readdirSync(DB_DIR).filter((f) => f.endsWith(".sql")).sort();

  const tables = new Map(); // name -> declaring file
  const columns = new Map(); // "table.column" -> declaring file

  for (const file of files) {
    const sql = stripComments(fs.readFileSync(path.join(DB_DIR, file), "utf8"));

    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi;
    for (const m of sql.matchAll(createRe)) {
      if (!tables.has(m[1])) tables.set(m[1], file);
    }

    // ALTER TABLE <t> … ; may span lines and carry several comma-separated
    // ADD COLUMN clauses, so capture the statement body then scan within it.
    const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?([a-zA-Z_][\w]*)([\s\S]*?);/gi;
    for (const m of sql.matchAll(alterRe)) {
      const table = m[1];
      const addRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi;
      for (const c of m[2].matchAll(addRe)) {
        const key = `${table}.${c[1]}`;
        if (!columns.has(key)) columns.set(key, file);
      }
    }
  }

  return {
    // Regenerate with: npm run schema:sync  (from backend/)
    generatedFrom: "database/*.sql",
    tables: [...tables.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, migration]) => ({ table, migration })),
    columns: [...columns.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, migration]) => {
        const [table, column] = key.split(".");
        return { table, column, migration };
      }),
  };
}

module.exports = { derive };

if (require.main === module) {
  const manifest = derive();
  fs.writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `Wrote ${path.relative(process.cwd(), OUT_FILE)} — ` +
      `${manifest.tables.length} tables, ${manifest.columns.length} added columns.`
  );
}
