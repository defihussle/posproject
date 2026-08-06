// Pending-refund acceptance tests (Stripe Terminal audit blockers 1–4).
//
// Slice 7 introduced a reversal that is written 'pending' and only promoted to
// 'completed' by the webhook confirming the processor actually returned the
// money. The reporting layer was never taught about that state: it filtered
// order_refunds with `status <> 'failed'`, which INCLUDES pending, while the
// payments side already excluded the matching pending negative row. The two
// halves of the same reconciliation disagreed by the value of any refund still
// in flight — dropping net sales and under-stating HST before the customer was
// out of pocket.
//
// Covers:
//   1. a PENDING reversal changes no report total, and reconciliation holds
//   2. promoting it to 'completed' moves every total together, still reconciled
//   3. failing it leaves the books exactly as if it never happened
//   4. over-refund protection STILL counts a pending reversal (the one place
//      `<> 'failed'` is correct — money on its way back must not be re-refunded)
//   5. a failed VOID restores the order, so a still-captured sale cannot vanish
//
// Same pattern as refund_reconciliation_acceptance.mjs: everything runs inside
// one BEGIN … ROLLBACK on a SINGLE client connection, and the report SQL is
// copied VERBATIM from backend/server.js rather than called over HTTP, because
// the seeded rows are invisible to any other pool connection until commit and
// we deliberately never commit. If an endpoint's query changes, update it here.
//
// Seeded into a window far in the past (May 2020) so live dev data can't affect
// the assertions.

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

const WINDOW_START = "2020-05-01 00:00:00+00";
const WINDOW_END = "2020-06-01 00:00:00+00";
const COMPLETED_AT = "2020-05-15 12:00:00+00";

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => `$${n.toFixed(2)}`;

let failures = 0;
function check(label, actual, expected) {
  const ok = Math.round(actual * 100) === Math.round(expected * 100);
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label} — got ${money(actual)}, expected ${money(expected)}`);
  if (!ok) failures += 1;
}
function checkText(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label} — got "${actual}", expected "${expected}"`);
  if (!ok) failures += 1;
}

// ---- report SQL, verbatim from backend/server.js -----------------------------
const settledPayments = (a = "p") => `${a}.status IN ('captured', 'refunded')`;
const settledRefunds = (a = "r") => `${a}.status = 'completed'`;

async function salesSummary(client, locationId) {
  const { rows: sumRows } = await client.query(
    `SELECT COALESCE(SUM(subtotal),0) AS gross, COALESCE(SUM(discount),0) AS discount,
            COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(tip),0) AS tips,
            COALESCE(SUM(total),0) AS total
       FROM orders
      WHERE location_id = $1 AND status = 'ready'
        AND completed_at >= $2 AND completed_at < $3`,
    [locationId, WINDOW_START, WINDOW_END]
  );
  const { rows: refRows } = await client.query(
    `SELECT COALESCE(SUM(r.amount),0) AS refund_total, COALESCE(SUM(r.tax_amount),0) AS refund_tax
       FROM order_refunds r
       JOIN orders o ON o.id = r.order_id
      WHERE o.location_id = $1 AND o.status = 'ready'
        AND o.completed_at >= $2 AND o.completed_at < $3
        AND ${settledRefunds("r")}`,
    [locationId, WINDOW_START, WINDOW_END]
  );
  const { rows: mixRows } = await client.query(
    `SELECT COALESCE(SUM(p.amount),0) AS amount
       FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE o.location_id = $1 AND o.status = 'ready'
        AND o.completed_at >= $2 AND o.completed_at < $3
        AND ${settledPayments("p")}`,
    [locationId, WINDOW_START, WINDOW_END]
  );
  const total = parseFloat(sumRows[0].total);
  const tax = parseFloat(sumRows[0].tax);
  const refundTotal = parseFloat(refRows[0].refund_total);
  const refundTax = parseFloat(refRows[0].refund_tax);
  return {
    refundTotal,
    taxCollected: round2(tax - refundTax),
    totalCollected: round2(total - refundTotal),
    settledPaymentsSum: parseFloat(mixRows[0].amount),
  };
}

async function transactionLogTotals(client, locationId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(total),0) AS total,
            COALESCE((SELECT SUM(r.amount) FROM order_refunds r
                        JOIN orders o3 ON o3.id = r.order_id
                       WHERE o3.location_id = $1 AND o3.status = 'ready'
                         AND o3.completed_at >= $2 AND o3.completed_at < $3
                         AND ${settledRefunds("r")}), 0) AS refunded_total,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                        JOIN orders o2 ON o2.id = p.order_id
                       WHERE o2.location_id = $1 AND o2.status = 'ready'
                         AND o2.completed_at >= $2 AND o2.completed_at < $3
                         AND ${settledPayments("p")}), 0) AS payments_total
       FROM orders o
      WHERE o.location_id = $1 AND o.status = 'ready'
        AND o.completed_at >= $2 AND o.completed_at < $3`,
    [locationId, WINDOW_START, WINDOW_END]
  );
  const t = rows[0];
  return {
    net: round2(parseFloat(t.total) - parseFloat(t.refunded_total)),
    paymentsTotal: parseFloat(t.payments_total),
  };
}

// Verbatim from restoreVoidedOrderAfterFailedReversal() in backend/server.js.
async function restoreVoidedOrder(client, refundId) {
  const { rows } = await client.query(
    `UPDATE orders o
        SET status = o.voided_from_status,
            voided_from_status = NULL,
            void_acknowledged_at = NULL
       FROM order_refunds r
      WHERE r.id = $1 AND r.type = 'void' AND o.id = r.order_id
        AND o.status = 'cancelled' AND o.voided_from_status IS NOT NULL
      RETURNING o.id, o.status`,
    [refundId]
  );
  return rows[0] || null;
}

// A tipped card sale: subtotal 100, tax 13, tip 10, total 123.
// refundableBase = total − tip = 113.
async function seedOrder(client, locationId, staffId, { status = "ready" } = {}) {
  const { rows } = await client.query(
    `INSERT INTO orders (location_id, staff_id, status, subtotal, tax, tip, total,
                         discount, created_at, completed_at)
     VALUES ($1, $2, $3, 100, 13, 10, 123, 0, $4, $4)
     RETURNING id, order_number`,
    [locationId, staffId, status, COMPLETED_AT]
  );
  const order = rows[0];
  const { rows: itemRows } = await client.query(
    `INSERT INTO order_items (order_id, item_id, quantity, unit_price)
     SELECT $1, id, 1, 100 FROM menu_items WHERE active = true LIMIT 1
     RETURNING id`,
    [order.id]
  );
  await client.query(
    `INSERT INTO payments (order_id, method, amount, status, processor_txn_id, processor_payment_type)
     VALUES ($1, 'card', 123, 'captured', $2, 'card_present')`,
    [order.id, `pi_test_${order.id}`]
  );
  return { ...order, orderItemId: itemRows[0]?.id };
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: locRows } = await client.query(
      "SELECT id FROM locations WHERE active = true ORDER BY created_at LIMIT 1"
    );
    const locationId = locRows[0].id;
    const { rows: staffRows } = await client.query(
      "SELECT id, role FROM staff WHERE active = true AND role IN ('owner','admin') LIMIT 1"
    );
    const staffId = staffRows[0].id;
    const staffRole = staffRows[0].role;

    // ---------------------------------------------------------------------
    console.log("\n1. A PENDING reversal must not move any report total");
    const order = await seedOrder(client, locationId, staffId);

    const baseline = await salesSummary(client, locationId);
    check("baseline total collected", baseline.totalCollected, 123);
    check("baseline settled payments", baseline.settledPaymentsSum, 123);

    // A reversal exactly as applyRefund writes one for a Stripe settlement:
    // audit row 'pending' + negative payments row 'pending'.
    const { rows: pr } = await client.query(
      `INSERT INTO order_refunds (order_id, type, amount, tax_amount, reason,
                                  requested_by, approved_by, status)
       VALUES ($1, 'refund', 50, 5.75, 'quality_issue', $2, $2, 'pending')
       RETURNING id`,
      [order.id, staffId]
    );
    const pendingRefundId = pr[0].id;
    await client.query(
      `INSERT INTO payments (order_id, method, amount, status, refund_id)
       VALUES ($1, 'card', -50, 'pending', $2)`,
      [order.id, pendingRefundId]
    );

    const withPending = await salesSummary(client, locationId);
    check("refund total ignores pending", withPending.refundTotal, 0);
    check("total collected unchanged", withPending.totalCollected, 123);
    check("tax collected unchanged (CRA-facing)", withPending.taxCollected, 13);
    check("settled payments unchanged", withPending.settledPaymentsSum, 123);

    const txPending = await transactionLogTotals(client, locationId);
    check("transaction log net == settled payments", txPending.net, txPending.paymentsTotal);

    // ---------------------------------------------------------------------
    console.log("\n2. Promoting it to 'completed' moves every total together");
    await client.query("UPDATE order_refunds SET status = 'completed' WHERE id = $1", [pendingRefundId]);
    await client.query("UPDATE payments SET status = 'refunded' WHERE refund_id = $1", [pendingRefundId]);

    const settled = await salesSummary(client, locationId);
    check("refund total now counts it", settled.refundTotal, 50);
    check("total collected drops", settled.totalCollected, 73);
    check("tax collected nets the refunded tax", settled.taxCollected, round2(13 - 5.75));
    check("settled payments drop to match", settled.settledPaymentsSum, 73);

    const txSettled = await transactionLogTotals(client, locationId);
    check("transaction log still reconciles", txSettled.net, txSettled.paymentsTotal);

    // ---------------------------------------------------------------------
    console.log("\n3. Failing it leaves the books as if it never happened");
    await client.query("UPDATE order_refunds SET status = 'failed' WHERE id = $1", [pendingRefundId]);
    await client.query("UPDATE payments SET status = 'failed' WHERE refund_id = $1", [pendingRefundId]);

    const failed = await salesSummary(client, locationId);
    check("failed reversal returns nothing", failed.refundTotal, 0);
    check("total collected restored", failed.totalCollected, 123);
    check("settled payments restored", failed.settledPaymentsSum, 123);

    // ---------------------------------------------------------------------
    console.log("\n4. Over-refund protection STILL counts a pending reversal");
    const order2 = await seedOrder(client, locationId, staffId);
    const { rows: pr2 } = await client.query(
      `INSERT INTO order_refunds (order_id, type, amount, tax_amount, reason,
                                  requested_by, approved_by, status)
       VALUES ($1, 'refund', 60, 6.90, 'quality_issue', $2, $2, 'pending')
       RETURNING id`,
      [order2.id, staffId]
    );
    await client.query(
      `INSERT INTO payments (order_id, method, amount, status, refund_id)
       VALUES ($1, 'card', -60, 'pending', $2)`,
      [order2.id, pr2[0].id]
    );

    // refundableBase 113 − 60 pending = 53 left. Asking for 70 must be refused,
    // or money already on its way back could be returned a second time.
    let rejected = false;
    let rejectionMessage = "";
    try {
      await applyRefund(client, {
        orderId: order2.id, type: "refund", reason: "quality_issue", amount: 70,
        requestedBy: staffId, approvedBy: staffId, approverRole: staffRole,
        surface: "backoffice", refundMethod: "cash",
      });
    } catch (err) {
      rejected = true;
      rejectionMessage = err.message;
    }
    console.log(
      `  ${rejected ? "PASS" : "FAIL"}: second refund over the cap rejected` +
        (rejected ? ` — "${rejectionMessage}"` : " — IT WAS ALLOWED")
    );
    if (!rejected) failures += 1;

    // ---------------------------------------------------------------------
    console.log("\n5. A failed VOID restores the order (sale cannot vanish)");
    const order3 = await seedOrder(client, locationId, staffId);
    const voidResult = await applyRefund(client, {
      orderId: order3.id, type: "void", reason: "wrong_order",
      requestedBy: staffId, approvedBy: staffId, approverRole: staffRole,
      surface: "backoffice",
    });
    checkText("void settles through Stripe (pending)", voidResult.refund.status, "pending");
    checkText("order is cancelled immediately", voidResult.orderStatus, "cancelled");

    const beforeRestore = await salesSummary(client, locationId);
    // The void dropped the order out of the 'ready' rollups entirely.
    check("voided sale is out of the books", beforeRestore.totalCollected, 123 * 2);

    const restored = await restoreVoidedOrder(client, voidResult.refund.id);
    checkText("order restored to its pre-void status", restored?.status || "NOT RESTORED", "ready");

    const { rows: vfs } = await client.query(
      "SELECT voided_from_status FROM orders WHERE id = $1",
      [order3.id]
    );
    checkText(
      "voided_from_status cleared",
      vfs[0].voided_from_status === null ? "null" : String(vfs[0].voided_from_status),
      "null"
    );

    // Mark the reversal failed the way failStripeRefund does, then confirm the
    // sale is back in the books with its capture intact.
    await client.query("UPDATE order_refunds SET status = 'failed' WHERE id = $1", [voidResult.refund.id]);
    await client.query("UPDATE payments SET status = 'failed' WHERE refund_id = $1", [voidResult.refund.id]);

    const afterRestore = await salesSummary(client, locationId);
    check("restored sale is back in the books", afterRestore.totalCollected, 123 * 3);
    check("and still reconciles", afterRestore.settledPaymentsSum, afterRestore.totalCollected);

    await client.query("ROLLBACK");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\nTest run failed:", err);
    failures += 1;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
