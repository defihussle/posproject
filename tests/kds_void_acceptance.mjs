// Refunds Slice 5 — KDS voided-ticket handling acceptance tests.
//
// Proves the board/history state machine:
//   fired + voided + unacknowledged  -> on the KDS board as a VOIDED ticket
//   voided while still 'open'        -> never on the board, never in history
//                                       (it never reached the kitchen)
//   acknowledged                     -> leaves the board, appears in history
//                                       still marked voided
//
// Same BEGIN … ROLLBACK / single-connection pattern as the other suites, and
// for the same reason the report SQL is run directly: seeded rows in an
// uncommitted transaction are invisible to any other pool connection, so an
// HTTP round-trip could not see them. The queries below are copied VERBATIM
// from the KDS poll (GET /api/orders), the history endpoint
// (GET /api/orders/history) and the acknowledge endpoint
// (POST /api/orders/:id/acknowledge-void) in backend/server.js.

import fs from "fs";
import path from "path";

try {
  const envContent = fs.readFileSync(path.resolve("backend/.env"), "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) {
  console.warn("Could not load backend/.env:", e.message);
}

const { pool, applyRefund } = await import("../backend/server.js");

let failures = 0;
function ok(label, condition, detail = "") {
  console.log(`  ${condition ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

// Verbatim from GET /api/orders (status=open,preparing,cancelled)
const POLL_SQL = `
  SELECT id FROM orders
   WHERE location_id = $1
     AND ( ($2::text[] <> '{}' AND status::text = ANY($2::text[]))
        OR ($3::boolean
            AND status = 'cancelled'
            AND voided_from_status IN ('preparing', 'ready')
            AND void_acknowledged_at IS NULL) )
   ORDER BY created_at ASC`;

// Verbatim from GET /api/orders/history
const HISTORY_SQL = `
  SELECT id, status FROM orders
   WHERE location_id = $1
     AND ( ( status = 'ready'
             AND completed_at >= now() - ($2::numeric * interval '1 hour') )
        OR ( status = 'cancelled'
             AND voided_from_status IN ('preparing', 'ready')
             AND void_acknowledged_at IS NOT NULL
             AND COALESCE(completed_at, created_at)
                   >= now() - ($2::numeric * interval '1 hour') ) )
   ORDER BY COALESCE(completed_at, created_at) DESC`;

async function run() {
  const client = await pool.connect();
  try {
    const { rows: locs } = await client.query(
      "SELECT id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
    );
    const locationId = locs[0].id;
    const { rows: staff } = await client.query(
      "SELECT id, name, role FROM staff WHERE active = true"
    );
    const cashier = staff.find((s) => s.role === "cashier");
    const owner = staff.find((s) => s.role === "owner");

    await client.query("BEGIN");

    // Seed one order per lifecycle position. 'ready' needs completed_at, which
    // is what checkout/KDS would have stamped.
    const seed = async (status) => {
      const { rows } = await client.query(
        `INSERT INTO orders (location_id, staff_id, subtotal, tax, total, status, completed_at)
         VALUES ($1, $2, 44.25, 5.75, 50.00, $3::order_status,
                 CASE WHEN $3::text = 'ready' THEN now() ELSE NULL END)
         RETURNING id, order_number`,
        [locationId, cashier.id, status]
      );
      await client.query(
        `INSERT INTO payments (order_id, method, amount, status)
         VALUES ($1, 'card', 50.00, 'captured')`,
        [rows[0].id]
      );
      return rows[0];
    };

    const P = await seed("preparing"); // voided mid-prep  -> ticket expected
    const O = await seed("open"); //      voided pre-fire  -> no ticket
    const R = await seed("ready"); //     voided post-prep -> ticket expected
    const L = await seed("preparing"); // never voided     -> normal ticket
    console.log(
      `Seeded #${P.order_number} preparing, #${O.order_number} open, ` +
        `#${R.order_number} ready, #${L.order_number} preparing (control)\n`
    );

    const voidIt = (id) =>
      applyRefund(client, {
        orderId: id, type: "void", reason: "wrong_order",
        requestedBy: cashier.id, approvedBy: owner.id, approverRole: owner.role,
      });

    console.log("1. voided_from_status records how far each order had got");
    await voidIt(P.id);
    await voidIt(O.id);
    await voidIt(R.id);
    const { rows: vf } = await client.query(
      `SELECT id, status, voided_from_status FROM orders WHERE id = ANY($1::uuid[])`,
      [[P.id, O.id, R.id]]
    );
    const byId = Object.fromEntries(vf.map((r) => [r.id, r]));
    ok("preparing order voided_from_status = 'preparing'", byId[P.id].voided_from_status === "preparing", byId[P.id].voided_from_status);
    ok("open order voided_from_status = 'open'", byId[O.id].voided_from_status === "open", byId[O.id].voided_from_status);
    ok("ready order voided_from_status = 'ready'", byId[R.id].voided_from_status === "ready", byId[R.id].voided_from_status);
    ok("all three are now status='cancelled'", vf.every((r) => r.status === "cancelled"));

    console.log("\n2. KDS board shows fired voids only");
    const poll = async () => {
      const { rows } = await client.query(POLL_SQL, [locationId, ["open", "preparing"], true]);
      return new Set(rows.map((r) => r.id));
    };
    let board = await poll();
    ok("voided-while-preparing IS on the board", board.has(P.id));
    ok("voided-while-ready IS on the board", board.has(R.id));
    ok("voided-while-open is NOT on the board (never reached the kitchen)", !board.has(O.id));
    ok("the untouched preparing order is still on the board", board.has(L.id));

    console.log("\n3. Voided tickets are NOT in history until acknowledged");
    const history = async () => {
      const { rows } = await client.query(HISTORY_SQL, [locationId, 6]);
      return new Set(rows.map((r) => r.id));
    };
    let hist = await history();
    ok("unacknowledged void is absent from history", !hist.has(P.id));

    console.log("\n4. Acknowledge clears it from the board (manual dismiss)");
    // Verbatim from POST /api/orders/:id/acknowledge-void
    const ackSql = `UPDATE orders
                       SET void_acknowledged_at = COALESCE(void_acknowledged_at, now())
                     WHERE id = $1 AND status = 'cancelled'
                     RETURNING id, void_acknowledged_at`;
    const { rows: ack1 } = await client.query(ackSql, [P.id]);
    ok("acknowledge returned the row", ack1.length === 1);
    ok("void_acknowledged_at is now set", ack1[0].void_acknowledged_at !== null);

    board = await poll();
    ok("acknowledged void has LEFT the board", !board.has(P.id));
    ok("the other, unacknowledged void is still on the board", board.has(R.id));

    console.log("\n5. …and remains in history, marked as voided");
    hist = await history();
    ok("acknowledged void appears in history", hist.has(P.id));
    ok("voided-while-open still never appears in history", !hist.has(O.id));
    ok("unacknowledged void still absent from history", !hist.has(R.id));

    console.log("\n6. Acknowledge is idempotent (double-tap is harmless)");
    const firstAt = ack1[0].void_acknowledged_at;
    const { rows: ack2 } = await client.query(ackSql, [P.id]);
    ok(
      "second acknowledge keeps the original timestamp",
      new Date(ack2[0].void_acknowledged_at).getTime() === new Date(firstAt).getTime()
    );

    console.log("\n7. Acknowledging a non-voided order is rejected");
    const { rows: ack3 } = await client.query(ackSql, [L.id]);
    ok("no row updated for a live order (endpoint would 404)", ack3.length === 0);

    await client.query("ROLLBACK");
    console.log("\nRolled back — no rows persisted.");

    if (failures > 0) {
      console.error(`\n${failures} CHECK(S) FAILED.`);
      process.exit(1);
    }
    console.log("All KDS void acceptance checks PASSED.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Test suite failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
