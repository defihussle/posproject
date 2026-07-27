// Refunds — reconciliation acceptance tests (docs/architecture/refunds-plan.md,
// "How we'll verify"). Proves the money invariant WITH refund and void data
// present, which the shipped reports had asserted but never demonstrated
// against persisted rows.
//
// Covers: partial refund, full refund, void, dual-control rejection (a cashier
// cannot approve a reversal), and the cross-surface check
//     Sales Summary "Total collected" == SUM(settled payments) == Transaction
//     Log net (gross − refunds)
//
// Everything runs inside one BEGIN … ROLLBACK on a SINGLE client connection —
// the established pattern. That connection scoping is also WHY the report SQL
// below is executed directly rather than over HTTP: the seeded rows are
// invisible to any other pool connection until commit, and we deliberately
// never commit. The queries are copied VERBATIM from the report endpoints
// (backend/server.js — reports/sales-summary and reports/transactions) so what
// is proven here is the same SQL those endpoints run. If an endpoint's query
// changes, update it here too.
//
// Seeded into a window far in the past (June 2020) so the assertions are
// unaffected by whatever live data the dev database happens to hold.

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

const { pool, applyRefund, requireStaffIdParam } = await import("../backend/server.js");

const WINDOW_START = "2020-06-01 00:00:00+00";
const WINDOW_END = "2020-07-01 00:00:00+00";
const COMPLETED_AT = "2020-06-15 12:00:00+00";

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => `$${n.toFixed(2)}`;

let failures = 0;
function check(label, actual, expected) {
  const ok = Math.round(actual * 100) === Math.round(expected * 100);
  console.log(
    `  ${ok ? "PASS" : "FAIL"}: ${label} — got ${money(actual)}, expected ${money(expected)}`
  );
  if (!ok) failures += 1;
  return ok;
}

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
    console.log(`Using cashier=${cashier.name}, owner=${owner.name}\n`);

    await client.query("BEGIN");

    // ---------------------------------------------------------------
    // Seed four orders in the window. Each has one captured payment equal
    // to its total, exactly as checkout writes them.
    //   A $100.00 → partial refund $30      (stays 'ready')
    //   B  $50.00 → full refund             (stays 'ready', nets to 0)
    //   C  $75.00 → VOID                    (becomes 'cancelled')
    //   D  $40.00 → untouched control
    // ---------------------------------------------------------------
    const seed = async (subtotal, tax, total) => {
      const { rows } = await client.query(
        `INSERT INTO orders (location_id, staff_id, subtotal, tax, total, status, completed_at)
         VALUES ($1, $2, $3, $4, $5, 'ready', $6::timestamptz)
         RETURNING id, order_number`,
        [locationId, cashier.id, subtotal, tax, total, COMPLETED_AT]
      );
      await client.query(
        `INSERT INTO payments (order_id, method, amount, status)
         VALUES ($1, 'card', $2, 'captured')`,
        [rows[0].id, total]
      );
      return rows[0];
    };

    const A = await seed(88.5, 11.5, 100.0);
    const B = await seed(44.25, 5.75, 50.0);
    const C = await seed(66.37, 8.63, 75.0);
    const D = await seed(35.4, 4.6, 40.0);
    console.log(
      `Seeded orders #${A.order_number} $100, #${B.order_number} $50, ` +
        `#${C.order_number} $75, #${D.order_number} $40 (gross $265.00)\n`
    );

    // --- 1. Partial refund -------------------------------------------------
    console.log("1. Partial refund ($30 of $100 on order A)");
    const r1 = await applyRefund(client, {
      orderId: A.id, type: "refund", reason: "quality_issue", amount: 30.0,
      requestedBy: cashier.id, approvedBy: owner.id, approverRole: owner.role,
    });
    check("remaining refundable on A", r1.remainingRefundable, 70.0);
    check("refunded tax portion (30 × 11.50/100)", r1.refund.taxAmount, 3.45);

    // --- 2. Full refund ----------------------------------------------------
    console.log("\n2. Full refund (order B, amount omitted → full remaining)");
    const r2 = await applyRefund(client, {
      orderId: B.id, type: "refund", reason: "kitchen_error",
      requestedBy: cashier.id, approvedBy: owner.id, approverRole: owner.role,
    });
    check("full refund amount", r2.refund.amount, 50.0);
    check("remaining refundable on B", r2.remainingRefundable, 0.0);

    // --- 3. Void -----------------------------------------------------------
    console.log("\n3. Void (order C — erases the sale entirely)");
    const r3 = await applyRefund(client, {
      orderId: C.id, type: "void", reason: "wrong_order",
      requestedBy: cashier.id, approvedBy: owner.id, approverRole: owner.role,
    });
    check("void amount == order total", r3.refund.amount, 75.0);
    const voidOk = r3.orderStatus === "cancelled";
    console.log(`  ${voidOk ? "PASS" : "FAIL"}: order C status is now 'cancelled' (got '${r3.orderStatus}')`);
    if (!voidOk) failures += 1;
    const { rows: cPay } = await client.query(
      "SELECT COALESCE(SUM(amount),0) AS net FROM payments WHERE order_id = $1",
      [C.id]
    );
    check("voided order's payments net to zero", parseFloat(cPay[0].net), 0.0);

    // --- 4. Dual-control rejection ----------------------------------------
    console.log("\n4. Dual-control: a cashier cannot approve a reversal");
    try {
      await requireStaffIdParam(cashier.id, ["owner", "admin", "manager"]);
      console.log("  FAIL: cashier was accepted as an approver!");
      failures += 1;
    } catch (err) {
      const ok = err.status === 403;
      console.log(
        `  ${ok ? "PASS" : "FAIL"}: cashier rejected as approver — ${err.status} "${err.message}"`
      );
      if (!ok) failures += 1;
    }

    // ---------------------------------------------------------------
    // 5. CROSS-SURFACE RECONCILIATION — the point of this suite.
    // ---------------------------------------------------------------
    console.log("\n5. Cross-surface reconciliation (with refunds + a void present)");

    // --- Sales Summary (verbatim from reports/sales-summary) ---
    const { rows: sumRows } = await client.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS gross,
              COALESCE(SUM(discount), 0) AS discount,
              COALESCE(SUM(tax), 0)      AS tax,
              COALESCE(SUM(tip), 0)      AS tips,
              COALESCE(SUM(total), 0)    AS total,
              COUNT(*)                   AS orders
         FROM orders
        WHERE location_id = $1 AND status = 'ready'
          AND completed_at >= $2 AND completed_at < $3`,
      [locationId, WINDOW_START, WINDOW_END]
    );
    const s = sumRows[0];
    const gross = parseFloat(s.gross), discount = parseFloat(s.discount);
    const tax = parseFloat(s.tax), tips = parseFloat(s.tips), total = parseFloat(s.total);

    const { rows: refRows } = await client.query(
      `SELECT COALESCE(SUM(r.amount), 0) AS refund_total,
              COALESCE(SUM(r.tax_amount), 0) AS refund_tax
         FROM order_refunds r
         JOIN orders o ON o.id = r.order_id
        WHERE o.location_id = $1 AND o.status = 'ready'
          AND o.completed_at >= $2 AND o.completed_at < $3
          AND r.status <> 'failed'`,
      [locationId, WINDOW_START, WINDOW_END]
    );
    const refundTotal = parseFloat(refRows[0].refund_total);
    const refundTax = parseFloat(refRows[0].refund_tax);
    const refundsPreTax = round2(refundTotal - refundTax);
    const netSales = round2(gross - discount - refundsPreTax);
    const taxCollected = round2(tax - refundTax);
    const totalCollected = round2(total - refundTotal);

    const { rows: voidRows } = await client.query(
      `SELECT COUNT(*) AS void_count, COALESCE(SUM(r.amount), 0) AS void_total
         FROM order_refunds r
         JOIN orders o ON o.id = r.order_id
        WHERE o.location_id = $1 AND r.type = 'void' AND r.status <> 'failed'
          AND r.created_at >= $2 AND r.created_at < $3`,
      [locationId, WINDOW_START, WINDOW_END]
    );

    console.log("\n  Sales Summary lines (voided order C excluded throughout):");
    check("gross sales (A+B+D subtotals)", gross, 168.15);
    check("refunds (tax-inclusive)", refundTotal, 80.0);
    check("refunded tax portion", refundTax, 9.2);
    check("net sales (gross − discounts − refunds pre-tax)", netSales, 97.35);
    check("tax collected (net of refunded tax)", taxCollected, 12.65);
    check("TOTAL COLLECTED (net)", totalCollected, 110.0);
    const lineSum = round2(netSales + taxCollected + tips);
    check("P&L lines add up (net + tax + tips == total collected)", lineSum, totalCollected);

    // Voids memo — scoped by when the void happened, so it uses created_at
    // (now()), not the 2020 window. Assert against an order-scoped query.
    const { rows: voidMemo } = await client.query(
      `SELECT COUNT(*) AS c, COALESCE(SUM(r.amount),0) AS t
         FROM order_refunds r WHERE r.order_id = $1 AND r.type = 'void'`,
      [C.id]
    );
    check("voids memo value (excluded from P&L, surfaced for audit)", parseFloat(voidMemo[0].t), 75.0);
    console.log(
      `  NOTE: the Sales Summary voids-memo query is scoped by r.created_at (when the` +
        `\n        void happened = now()), so it reports ${voidRows[0].void_count} void(s) for the 2020 window` +
        `\n        rather than 1 — correct by design, not a failure.`
    );

    // --- Settled payments (the reconciliation anchor) ---
    const { rows: payRows } = await client.query(
      `SELECT COALESCE(SUM(p.amount), 0) AS settled
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE o.location_id = $1 AND o.status = 'ready'
          AND o.completed_at >= $2 AND o.completed_at < $3
          AND p.status IN ('captured', 'refunded')`,
      [locationId, WINDOW_START, WINDOW_END]
    );
    const settled = parseFloat(payRows[0].settled);

    // --- Transaction Log (verbatim from reports/transactions) ---
    const { rows: txRows } = await client.query(
      `SELECT o.order_number, o.status,
              COALESCE((SELECT SUM(r.amount) FROM order_refunds r
                          WHERE r.order_id = o.id AND r.status <> 'failed'), 0) AS refunded
         FROM orders o
        WHERE o.location_id = $1
          AND ( (o.status = 'ready'     AND o.completed_at >= $2 AND o.completed_at < $3)
             OR (o.status = 'cancelled' AND COALESCE(o.completed_at, o.created_at) >= $2
                                        AND COALESCE(o.completed_at, o.created_at) < $3) )`,
      [locationId, WINDOW_START, WINDOW_END]
    );
    const { rows: totRows } = await client.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total,
              COALESCE((SELECT SUM(r.amount) FROM order_refunds r
                          JOIN orders o3 ON o3.id = r.order_id
                         WHERE o3.location_id = $1 AND o3.status = 'ready'
                           AND o3.completed_at >= $2 AND o3.completed_at < $3
                           AND r.status <> 'failed'), 0) AS refunded_total,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                          JOIN orders o2 ON o2.id = p.order_id
                         WHERE o2.location_id = $1 AND o2.status = 'ready'
                           AND o2.completed_at >= $2 AND o2.completed_at < $3
                           AND p.status IN ('captured','refunded')), 0) AS payments_total
         FROM orders o
        WHERE o.location_id = $1 AND o.status = 'ready'
          AND o.completed_at >= $2 AND o.completed_at < $3`,
      [locationId, WINDOW_START, WINDOW_END]
    );
    const t = totRows[0];
    const txGross = parseFloat(t.total);
    const txRefunded = parseFloat(t.refunded_total);
    const txNet = round2(txGross - txRefunded);
    const txPayments = parseFloat(t.payments_total);

    console.log("\n  Transaction Log:");
    const voided = txRows.filter((r) => r.status === "cancelled");
    const rowsOk = txRows.length === 4 && voided.length === 1;
    console.log(
      `  ${rowsOk ? "PASS" : "FAIL"}: ${txRows.length} rows returned (3 ready + 1 voided), ` +
        `voided row #${voided[0]?.order_number} present and flagged`
    );
    if (!rowsOk) failures += 1;
    check("gross total (ready only — void contributes nothing)", txGross, 190.0);
    check("refunded total", txRefunded, 80.0);
    check("NET total (gross − refunds)", txNet, 110.0);
    const balanced = Math.round(txNet * 100) === Math.round(txPayments * 100);
    console.log(`  ${balanced ? "PASS" : "FAIL"}: reconciliation badge 'balanced' == ${balanced}`);
    if (!balanced) failures += 1;

    // --- THE INVARIANT: three surfaces, one number ---
    console.log("\n  ══ THE INVARIANT ══");
    console.log(`  Sales Summary total collected : ${money(totalCollected)}`);
    console.log(`  SUM(settled payments)         : ${money(settled)}`);
    console.log(`  Transaction Log net           : ${money(txNet)}`);
    check("Sales Summary == settled payments", totalCollected, settled);
    check("settled payments == Transaction Log net", settled, txNet);
    check("Transaction Log net == Sales Summary", txNet, totalCollected);

    await client.query("ROLLBACK");
    console.log("\nRolled back — no rows persisted.");

    if (failures > 0) {
      console.error(`\n${failures} CHECK(S) FAILED.`);
      process.exit(1);
    }
    console.log("All reconciliation acceptance checks PASSED.");
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
