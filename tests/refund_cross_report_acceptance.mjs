// Refunds — cross-report agreement.
//
// The other suites prove Sales Summary == settled payments == Transaction Log
// net. This one adds the fifth report: does the REFUNDS REPORT agree with them
// on how much was reversed?
//
// It does NOT agree for an arbitrary window, and that is by design:
//   - Sales Summary / Transaction Log attribute a refund back to the ORIGINAL
//     sale's period (scoped by orders.completed_at), so their money reconciles
//     with settled payments.
//   - The Refunds Report is an ACTIVITY view, scoped by order_refunds.created_at
//     — "what was reversed this period", regardless of when the sale happened.
// So for a window containing both the sale and its reversal the three must
// agree exactly; for a window containing only one of the two they legitimately
// diverge. Both cases are asserted below so the distinction stays locked in.
//
// Same BEGIN … ROLLBACK single-connection pattern as the sibling suites; the
// report SQL is copied verbatim from the endpoints for the same reason (seeded
// rows in an open transaction are invisible to any other pool connection).
// Assertions are on DELTAS against a pre-seed baseline, so live dev data in the
// same window cannot affect the result.

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

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => `$${n.toFixed(2)}`;

let failures = 0;
function check(label, actual, expected) {
  const ok = Math.round(actual * 100) === Math.round(expected * 100);
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label} — ${money(actual)} vs ${money(expected)}`);
  if (!ok) failures += 1;
}

// Window = a wide band around now, so both the seeded sales and their
// reversals fall inside it.
const WIN_START = "now() - interval '1 hour'";
const WIN_END = "now() + interval '1 hour'";

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

    // --- Sales Summary refunds (scoped by the ORDER's completed_at) ---
    const salesSummaryRefunds = async () => {
      const { rows } = await client.query(
        `SELECT COALESCE(SUM(r.amount), 0) AS refund_total,
                COALESCE(SUM(r.tax_amount), 0) AS refund_tax
           FROM order_refunds r
           JOIN orders o ON o.id = r.order_id
          WHERE o.location_id = $1 AND o.status = 'ready'
            AND o.completed_at >= ${WIN_START} AND o.completed_at < ${WIN_END}
            AND r.status = 'completed'`,
        [locationId]
      );
      return parseFloat(rows[0].refund_total);
    };

    // --- Transaction Log refunded total (same scoping as Sales Summary) ---
    const transactionLogRefunded = async () => {
      const { rows } = await client.query(
        `SELECT COALESCE(SUM(r.amount), 0) AS refunded
           FROM order_refunds r
           JOIN orders o3 ON o3.id = r.order_id
          WHERE o3.location_id = $1 AND o3.status = 'ready'
            AND o3.completed_at >= ${WIN_START} AND o3.completed_at < ${WIN_END}
            AND r.status = 'completed'`,
        [locationId]
      );
      return parseFloat(rows[0].refunded);
    };

    // --- Refunds Report (scoped by the REFUND's created_at) ---
    // Mirrors the endpoint: refunds and voids are totalled separately.
    const refundsReport = async () => {
      const { rows } = await client.query(
        `SELECT r.type, r.amount
           FROM order_refunds r
           JOIN orders o ON o.id = r.order_id
          WHERE o.location_id = $1 AND r.status = 'completed'
            AND r.created_at >= ${WIN_START} AND r.created_at < ${WIN_END}`,
        [locationId]
      );
      let refundTotal = 0, voidTotal = 0;
      for (const r of rows) {
        if (r.type === "void") voidTotal = round2(voidTotal + parseFloat(r.amount));
        else refundTotal = round2(refundTotal + parseFloat(r.amount));
      }
      return { refundTotal, voidTotal, reversedTotal: round2(refundTotal + voidTotal) };
    };

    // Baseline before seeding, so live dev data in the window is cancelled out.
    await client.query("BEGIN");
    const base = {
      ss: await salesSummaryRefunds(),
      tx: await transactionLogRefunded(),
      rr: await refundsReport(),
    };
    console.log(
      `Baseline in window — SalesSummary ${money(base.ss)}, TxLog ${money(base.tx)}, ` +
        `RefundsReport refunds ${money(base.rr.refundTotal)} / voids ${money(base.rr.voidTotal)}\n`
    );

    const seed = async (subtotal, tax, total) => {
      const { rows } = await client.query(
        `INSERT INTO orders (location_id, staff_id, subtotal, tax, total, status, completed_at)
         VALUES ($1, $2, $3, $4, $5, 'ready', now())
         RETURNING id, order_number`,
        [locationId, cashier.id, subtotal, tax, total]
      );
      await client.query(
        `INSERT INTO payments (order_id, method, amount, status)
         VALUES ($1, 'card', $2, 'captured')`,
        [rows[0].id, total]
      );
      return rows[0];
    };

    // A partial refund, a full refund, and a void — all inside the window.
    const A = await seed(88.5, 11.5, 100.0);
    const B = await seed(44.25, 5.75, 50.0);
    const C = await seed(66.37, 8.63, 75.0);
    console.log(`Seeded #${A.order_number} $100, #${B.order_number} $50, #${C.order_number} $75`);

    await applyRefund(client, {
      orderId: A.id, type: "refund", reason: "quality_issue", amount: 30.0,
      requestedBy: cashier.id, approvedBy: owner.id, approverRole: owner.role,
    });
    await applyRefund(client, {
      orderId: B.id, type: "refund", reason: "kitchen_error",
      requestedBy: cashier.id, approvedBy: owner.id, approverRole: owner.role,
    });
    await applyRefund(client, {
      orderId: C.id, type: "void", reason: "wrong_order",
      requestedBy: cashier.id, approvedBy: owner.id, approverRole: owner.role,
    });
    console.log("Applied: $30 partial on A, full $50 on B, void $75 on C\n");

    const after = {
      ss: await salesSummaryRefunds(),
      tx: await transactionLogRefunded(),
      rr: await refundsReport(),
    };
    const dSs = round2(after.ss - base.ss);
    const dTx = round2(after.tx - base.tx);
    const dRefund = round2(after.rr.refundTotal - base.rr.refundTotal);
    const dVoid = round2(after.rr.voidTotal - base.rr.voidTotal);

    console.log("1. Refund totals agree across all three reports for the same window");
    // $30 + $50 = $80 of REFUNDS. The $75 void is not a refund: order C left
    // 'ready' for 'cancelled', so Sales Summary and Transaction Log exclude it
    // entirely, and the Refunds Report books it under voids, not refunds.
    check("Sales Summary refunds", dSs, 80.0);
    check("Transaction Log refunded", dTx, 80.0);
    check("Refunds Report — refunds", dRefund, 80.0);
    check("Sales Summary == Refunds Report", dSs, dRefund);
    check("Transaction Log == Refunds Report", dTx, dRefund);

    console.log("\n2. The void is reported as a void, not folded into refunds");
    check("Refunds Report — voids", dVoid, 75.0);
    check("Refunds Report — total reversed", round2(dRefund + dVoid), 155.0);
    console.log(
      "  NOTE: Sales Summary/Transaction Log deliberately exclude the $75 void from\n" +
        "        refunds — a voided order leaves 'ready' entirely. It surfaces there as\n" +
        "        the Voids memo / a flagged $0-net row instead."
    );

    console.log("\n3. Scoping difference is real and intentional");
    // A sale completed OUTSIDE the window, refunded INSIDE it: the Refunds
    // Report (activity) counts it; Sales Summary/Transaction Log (attributed to
    // the sale's period) do not.
    const { rows: oldRows } = await client.query(
      `INSERT INTO orders (location_id, staff_id, subtotal, tax, total, status, completed_at)
       VALUES ($1, $2, 88.50, 11.50, 100.00, 'ready', now() - interval '30 days')
       RETURNING id`,
      [locationId, cashier.id]
    );
    await client.query(
      `INSERT INTO payments (order_id, method, amount, status) VALUES ($1, 'card', 100.00, 'captured')`,
      [oldRows[0].id]
    );
    await applyRefund(client, {
      orderId: oldRows[0].id, type: "refund", reason: "overcharge", amount: 25.0,
      requestedBy: cashier.id, approvedBy: owner.id, approverRole: owner.role,
    });

    const late = {
      ss: await salesSummaryRefunds(),
      tx: await transactionLogRefunded(),
      rr: await refundsReport(),
    };
    check("Sales Summary unchanged by a refund of an older sale",
      round2(late.ss - after.ss), 0.0);
    check("Transaction Log unchanged by a refund of an older sale",
      round2(late.tx - after.tx), 0.0);
    check("Refunds Report DOES count it (activity view)",
      round2(late.rr.refundTotal - after.rr.refundTotal), 25.0);

    await client.query("ROLLBACK");
    console.log("\nRolled back — no rows persisted.");

    if (failures > 0) {
      console.error(`\n${failures} CHECK(S) FAILED.`);
      process.exit(1);
    }
    console.log("All cross-report acceptance checks PASSED.");
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
