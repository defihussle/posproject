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
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
} catch (e) {
  console.warn("Could not load backend/.env:", e.message);
}

const { pool, applyRefund } = await import("../backend/server.js");

async function runTests() {
  const client = await pool.connect();
  try {
    console.log("Beginning POS Refund Slice 4 backend acceptance tests...");

    // Find active location and staff
    const { rows: locs } = await client.query("SELECT id FROM locations WHERE active = true LIMIT 1");
    const locationId = locs[0].id;

    const { rows: staff } = await client.query("SELECT id, name, role FROM staff WHERE active = true");
    const cashier = staff.find((s) => s.role === "cashier") || staff[0];
    const manager = staff.find((s) => s.role === "manager") || staff[0];
    const owner = staff.find((s) => s.role === "owner") || staff[0];

    console.log(`Using cashier=${cashier.name}, manager=${manager.name}, owner=${owner.name}`);

    await client.query("BEGIN");

    // 1. Create a test order ($150 total: $132.74 subtotal + $17.26 tax)
    const { rows: orderRows } = await client.query(
      `INSERT INTO orders (location_id, staff_id, subtotal, tax, total, status, completed_at)
       VALUES ($1, $2, 132.74, 17.26, 150.00, 'ready', now())
       RETURNING id, order_number`,
      [locationId, cashier.id]
    );
    const orderId = orderRows[0].id;
    console.log(`Created test order #${orderRows[0].order_number} (${orderId})`);

    // Insert payment capture row
    await client.query(
      `INSERT INTO payments (order_id, method, amount, status) VALUES ($1, 'card', 150.00, 'captured')`,
      [orderId]
    );

    // Insert order items
    const { rows: itemRows } = await client.query(
      `INSERT INTO order_items (order_id, quantity, unit_price)
       VALUES ($1, 2, 50.00), ($1, 1, 32.74)
       RETURNING id`,
      [orderId]
    );

    // 2. Test $100+ threshold rejection for Manager approver
    try {
      await applyRefund(client, {
        orderId,
        type: "refund",
        reason: "quality_issue",
        amount: 120.00,
        requestedBy: cashier.id,
        approvedBy: manager.id,
        approverRole: manager.role,
      });
      console.error("FAIL: Manager approved $120 refund when owner approval was required!");
      process.exit(1);
    } catch (err) {
      if (err.status === 403 && err.message.includes("owner/admin approval")) {
        console.log("PASS: Manager approval rejected for $120 refund (requires owner/admin).");
      } else {
        console.error("Unexpected error for threshold test:", err);
        process.exit(1);
      }
    }

    // 3. Test $100+ threshold acceptance for Owner approver (Partial refund of $40)
    const res1 = await applyRefund(client, {
      orderId,
      type: "refund",
      reason: "quality_issue",
      amount: 40.00,
      requestedBy: cashier.id,
      approvedBy: owner.id,
      approverRole: owner.role,
    });
    console.log(`PASS: Partial refund of $40 approved by owner. Remaining refundable: $${res1.remainingRefundable}`);

    // 4. Test Void rejection when partial refund already exists
    try {
      await applyRefund(client, {
        orderId,
        type: "void",
        reason: "wrong_order",
        requestedBy: cashier.id,
        approvedBy: owner.id,
        approverRole: owner.role,
      });
      console.error("FAIL: Void succeeded on order with prior partial refund!");
      process.exit(1);
    } catch (err) {
      if (err.status === 409 && err.message.includes("partial refunds")) {
        console.log("PASS: Void correctly rejected on order with partial refund.");
      } else {
        console.error("Unexpected error for void on partial refund test:", err);
        process.exit(1);
      }
    }

    // 5. Test Line-Item refund for remaining amount ($110)
    const res2 = await applyRefund(client, {
      orderId,
      type: "refund",
      reason: "kitchen_error",
      amount: 110.00,
      items: [
        { orderItemId: itemRows[0].id, quantity: 2, amount: 100.00 },
        { orderItemId: itemRows[1].id, quantity: 1, amount: 10.00 },
      ],
      requestedBy: cashier.id,
      approvedBy: owner.id,
      approverRole: owner.role,
    });
    console.log(`PASS: Line-item refund of remaining $110 processed. Remaining refundable: $${res2.remainingRefundable}`);

    // 6. Test refunding an already fully refunded order
    try {
      await applyRefund(client, {
        orderId,
        type: "refund",
        reason: "overcharge",
        amount: 10.00,
        requestedBy: cashier.id,
        approvedBy: owner.id,
        approverRole: owner.role,
      });
      console.error("FAIL: Refund succeeded on fully refunded order!");
      process.exit(1);
    } catch (err) {
      if (err.status === 409 || err.status === 400) {
        console.log(`PASS: Additional refund correctly rejected on fully refunded order: ${err.message}`);
      } else {
        console.error("Unexpected error for excess refund:", err);
        process.exit(1);
      }
    }

    // ---------------------------------------------------------------
    // 7. Line-item validation. A SEPARATE order so the per-line checks are
    //    isolated from the dollar ceiling — every rejection below is under the
    //    remaining refundable balance, so only the line-item rules can reject
    //    it. Order: $100.00 total (88.50 + 11.50 tax); line A = 2 @ $30.00,
    //    line B = 1 @ $28.50.
    // ---------------------------------------------------------------
    const { rows: order2Rows } = await client.query(
      `INSERT INTO orders (location_id, staff_id, subtotal, tax, total, status, completed_at)
       VALUES ($1, $2, 88.50, 11.50, 100.00, 'ready', now())
       RETURNING id, order_number`,
      [locationId, cashier.id]
    );
    const order2Id = order2Rows[0].id;
    await client.query(
      `INSERT INTO payments (order_id, method, amount, status) VALUES ($1, 'card', 100.00, 'captured')`,
      [order2Id]
    );
    const { rows: item2Rows } = await client.query(
      `INSERT INTO order_items (order_id, quantity, unit_price)
       VALUES ($1, 2, 30.00), ($1, 1, 28.50)
       RETURNING id`,
      [order2Id]
    );
    const lineA = item2Rows[0].id;
    console.log(`Created test order #${order2Rows[0].order_number} for line-item validation`);

    // 7a. An order_item belonging to a DIFFERENT order must be rejected.
    try {
      await applyRefund(client, {
        orderId: order2Id,
        type: "refund",
        reason: "quality_issue",
        amount: 20.0,
        items: [{ orderItemId: itemRows[0].id, quantity: 1, amount: 20.0 }],
        requestedBy: cashier.id,
        approvedBy: owner.id,
        approverRole: owner.role,
      });
      console.error("FAIL: accepted a line item belonging to another order!");
      process.exit(1);
    } catch (err) {
      if (err.status === 400 && err.message.includes("does not belong to this order")) {
        console.log("PASS: line item from a different order rejected.");
      } else {
        console.error("Unexpected error for foreign line-item test:", err);
        process.exit(1);
      }
    }

    // 7b. Quantity above the quantity ordered must be rejected (3 of 2).
    try {
      await applyRefund(client, {
        orderId: order2Id,
        type: "refund",
        reason: "quality_issue",
        amount: 60.0,
        items: [{ orderItemId: lineA, quantity: 3, amount: 60.0 }],
        requestedBy: cashier.id,
        approvedBy: owner.id,
        approverRole: owner.role,
      });
      console.error("FAIL: accepted refund of 3 units when only 2 were ordered!");
      process.exit(1);
    } catch (err) {
      if (err.status === 400 && err.message.includes("cannot refund")) {
        console.log("PASS: quantity above quantity-ordered rejected.");
      } else {
        console.error("Unexpected error for over-quantity test:", err);
        process.exit(1);
      }
    }

    // 7c. THE DOUBLE-REFUND CASE. Refund 1 of the 2 units on line A, then try
    //     to refund 2 more. Remaining balance is $70 and the attempt is $60, so
    //     the dollar ceiling does NOT catch it — only the per-line cumulative
    //     check can, which is exactly the gap this closes.
    await applyRefund(client, {
      orderId: order2Id,
      type: "refund",
      reason: "quality_issue",
      amount: 30.0,
      items: [{ orderItemId: lineA, quantity: 1, amount: 30.0 }],
      requestedBy: cashier.id,
      approvedBy: owner.id,
      approverRole: owner.role,
    });
    console.log("       (first partial: 1 of 2 units on line A refunded)");
    try {
      await applyRefund(client, {
        orderId: order2Id,
        type: "refund",
        reason: "quality_issue",
        amount: 60.0,
        items: [{ orderItemId: lineA, quantity: 2, amount: 60.0 }],
        requestedBy: cashier.id,
        approvedBy: owner.id,
        approverRole: owner.role,
      });
      console.error("FAIL: same line item refunded twice across two partial refunds!");
      process.exit(1);
    } catch (err) {
      if (err.status === 409 && err.message.includes("already refunded")) {
        console.log("PASS: double-refund of the same line item across two partials rejected.");
      } else {
        console.error("Unexpected error for double-refund test:", err);
        process.exit(1);
      }
    }

    // 7d. Not over-blocking: the 1 genuinely remaining unit still refunds.
    await applyRefund(client, {
      orderId: order2Id,
      type: "refund",
      reason: "quality_issue",
      amount: 30.0,
      items: [{ orderItemId: lineA, quantity: 1, amount: 30.0 }],
      requestedBy: cashier.id,
      approvedBy: owner.id,
      approverRole: owner.role,
    });
    console.log("PASS: the remaining 1 unit on line A still refunds (no over-blocking).");

    // 7e. Duplicates within ONE request are summed before checking, so they
    //     can't slip past the cumulative rule one entry at a time.
    try {
      await applyRefund(client, {
        orderId: order2Id,
        type: "refund",
        reason: "quality_issue",
        amount: 28.5,
        items: [
          { orderItemId: item2Rows[1].id, quantity: 1, amount: 14.25 },
          { orderItemId: item2Rows[1].id, quantity: 1, amount: 14.25 },
        ],
        requestedBy: cashier.id,
        approvedBy: owner.id,
        approverRole: owner.role,
      });
      console.error("FAIL: duplicate entries bypassed the per-line quantity check!");
      process.exit(1);
    } catch (err) {
      if (err.status === 400 || err.status === 409) {
        console.log(`PASS: duplicate line entries summed and rejected: ${err.message}`);
      } else {
        console.error("Unexpected error for duplicate-entry test:", err);
        process.exit(1);
      }
    }

    await client.query("ROLLBACK");
    console.log("All Slice 4 backend acceptance tests PASSED cleanly!");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Test suite failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runTests();
