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

    // 5. Line-item refund, priced by the SERVER. Order is $132.74 + $17.26 tax
    //    = $150.00, so the collected/list ratio is 150/132.74. Refunding the
    //    second line (1 × $32.74) is worth 32.74 × 1.13003 = $37.00 collected,
    //    NOT its $32.74 list price. No amount is sent — the client no longer
    //    supplies one.
    const res2 = await applyRefund(client, {
      orderId,
      type: "refund",
      reason: "kitchen_error",
      items: [{ orderItemId: itemRows[1].id, quantity: 1 }],
      requestedBy: cashier.id,
      approvedBy: owner.id,
      approverRole: owner.role,
    });
    if (Math.round(res2.refund.amount * 100) !== 3700) {
      console.error(`FAIL: line priced at $${res2.refund.amount.toFixed(2)}, expected $37.00`);
      process.exit(1);
    }
    console.log(
      `PASS: server priced the $32.74 line at $${res2.refund.amount.toFixed(2)} tax-inclusive. ` +
        `Remaining refundable: $${res2.remainingRefundable.toFixed(2)}`
    );

    // 5b. Exhaust the order with a partial-$ refund so the fully-refunded
    //     rejection below is exercised on a genuinely exhausted order.
    const res2b = await applyRefund(client, {
      orderId,
      type: "refund",
      reason: "overcharge",
      amount: res2.remainingRefundable,
      requestedBy: cashier.id,
      approvedBy: owner.id,
      approverRole: owner.role,
    });
    console.log(
      `PASS: partial-$ refund of $${res2b.refund.amount.toFixed(2)} exhausts the order. ` +
        `Remaining refundable: $${res2b.remainingRefundable.toFixed(2)}`
    );

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

    // ---------------------------------------------------------------
    // 8. TAX-INCLUSIVE LINE PRICING. The regression this locks: the client
    //    used to send Σ(qty × unit_price) — a PRE-TAX figure — as the
    //    tax-inclusive refund amount, so refunding every line of a
    //    $10.00 + 13% HST = $11.30 order returned $10.00 and booked $1.15 of
    //    tax instead of $1.30. The customer was short the tax while the
    //    ledger still reconciled perfectly, which is why no reconciliation
    //    test caught it. The server now prices the lines itself.
    // ---------------------------------------------------------------
    const { rows: order3Rows } = await client.query(
      `INSERT INTO orders (location_id, staff_id, subtotal, tax, total, status, completed_at)
       VALUES ($1, $2, 10.00, 1.30, 11.30, 'ready', now())
       RETURNING id, order_number`,
      [locationId, cashier.id]
    );
    const order3Id = order3Rows[0].id;
    await client.query(
      `INSERT INTO payments (order_id, method, amount, status) VALUES ($1, 'card', 11.30, 'captured')`,
      [order3Id]
    );
    const { rows: item3Rows } = await client.query(
      `INSERT INTO order_items (order_id, quantity, unit_price)
       VALUES ($1, 1, 10.00)
       RETURNING id`,
      [order3Id]
    );

    const taxRes = await applyRefund(client, {
      orderId: order3Id,
      type: "refund",
      reason: "quality_issue",
      // No amount sent — mirrors the client, which no longer supplies one.
      items: [{ orderItemId: item3Rows[0].id, quantity: 1 }],
      requestedBy: cashier.id,
      approvedBy: owner.id,
      approverRole: owner.role,
    });
    const amtOk = Math.round(taxRes.refund.amount * 100) === 1130;
    console.log(
      `  ${amtOk ? "PASS" : "FAIL"}: $10.00 + 13% HST line refunds $${taxRes.refund.amount.toFixed(2)} ` +
        `(expected $11.30, was $10.00 before the fix)`
    );
    if (!amtOk) process.exit(1);
    const taxOk = Math.round(taxRes.refund.taxAmount * 100) === 130;
    console.log(
      `  ${taxOk ? "PASS" : "FAIL"}: booked tax $${taxRes.refund.taxAmount.toFixed(2)} ` +
        `(expected $1.30, was $1.15 before the fix)`
    );
    if (!taxOk) process.exit(1);
    const remOk = Math.round(taxRes.remainingRefundable * 100) === 0;
    console.log(
      `  ${remOk ? "PASS" : "FAIL"}: order fully refunded — remaining $${taxRes.remainingRefundable.toFixed(2)}`
    );
    if (!remOk) process.exit(1);

    // order_refunds.amount must equal SUM(order_refund_items.amount) exactly,
    // so the audit detail can never disagree with the headline.
    const { rows: sumRows } = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM order_refund_items WHERE refund_id = $1`,
      [taxRes.refund.id]
    );
    const lineSumOk =
      Math.round(parseFloat(sumRows[0].s) * 100) === Math.round(taxRes.refund.amount * 100);
    console.log(
      `  ${lineSumOk ? "PASS" : "FAIL"}: line detail sums to the refund total ` +
        `($${parseFloat(sumRows[0].s).toFixed(2)} == $${taxRes.refund.amount.toFixed(2)})`
    );
    if (!lineSumOk) process.exit(1);

    // 8b. A client-supplied dollar figure must be IGNORED, not trusted.
    const { rows: order4Rows } = await client.query(
      `INSERT INTO orders (location_id, staff_id, subtotal, tax, total, status, completed_at)
       VALUES ($1, $2, 10.00, 1.30, 11.30, 'ready', now())
       RETURNING id`,
      [locationId, cashier.id]
    );
    await client.query(
      `INSERT INTO payments (order_id, method, amount, status) VALUES ($1, 'card', 11.30, 'captured')`,
      [order4Rows[0].id]
    );
    const { rows: item4Rows } = await client.query(
      `INSERT INTO order_items (order_id, quantity, unit_price) VALUES ($1, 1, 10.00) RETURNING id`,
      [order4Rows[0].id]
    );
    const forged = await applyRefund(client, {
      orderId: order4Rows[0].id,
      type: "refund",
      reason: "overcharge",
      amount: 0.01, // forged — must be ignored for a line-item refund
      items: [{ orderItemId: item4Rows[0].id, quantity: 1, amount: 0.01 }],
      requestedBy: cashier.id,
      approvedBy: owner.id,
      approverRole: owner.role,
    });
    const forgedOk = Math.round(forged.refund.amount * 100) === 1130;
    console.log(
      `  ${forgedOk ? "PASS" : "FAIL"}: forged $0.01 line amount ignored — server priced it at ` +
        `$${forged.refund.amount.toFixed(2)}`
    );
    if (!forgedOk) process.exit(1);

    // 8c. Discounted order: a line refund returns what was actually PAID for
    //     that line, not its undiscounted list price.
    const { rows: order5Rows } = await client.query(
      `INSERT INTO orders (location_id, staff_id, subtotal, discount, discount_percent,
                           discount_reason, tax, total, status, completed_at)
       VALUES ($1, $2, 10.00, 2.00, 20, 'friend', 1.04, 9.04, 'ready', now())
       RETURNING id`,
      [locationId, cashier.id]
    );
    await client.query(
      `INSERT INTO payments (order_id, method, amount, status) VALUES ($1, 'card', 9.04, 'captured')`,
      [order5Rows[0].id]
    );
    const { rows: item5Rows } = await client.query(
      `INSERT INTO order_items (order_id, quantity, unit_price) VALUES ($1, 1, 10.00) RETURNING id`,
      [order5Rows[0].id]
    );
    const disc = await applyRefund(client, {
      orderId: order5Rows[0].id,
      type: "refund",
      reason: "quality_issue",
      items: [{ orderItemId: item5Rows[0].id, quantity: 1 }],
      requestedBy: cashier.id,
      approvedBy: owner.id,
      approverRole: owner.role,
    });
    const discOk = Math.round(disc.refund.amount * 100) === 904;
    console.log(
      `  ${discOk ? "PASS" : "FAIL"}: 20%-discounted $10 line refunds ` +
        `$${disc.refund.amount.toFixed(2)} (expected $9.04 — what was actually paid)`
    );
    if (!discOk) process.exit(1);

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
