import { useState, useEffect, useCallback } from "react";
import { API_URL } from "../config";
import "./ReceiptModal.css";

// Customer receipt — print now, email optionally (plan Slice 8).
//
// Everything shown here comes from GET /api/orders/:id/receipt and is rendered
// verbatim: the component does no arithmetic of its own beyond formatting, so a
// receipt can never disagree with the order it was printed from.
//
// Printing is deliberately the browser's own print dialog rather than anything
// hardware-specific. Whatever receipt printer the tablet's OS can already see
// shows up in that dialog, so there is no driver, no printer config and no
// hardware dependency in this app — which is what lets receipts ship before the
// printer has even been bought.

const DISCOUNT_REASON_LABEL = {
  family: "Family",
  friend: "Friend",
  employee: "Employee",
  neighbouring_store: "Neighbouring Store",
};

const REFUND_REASON_LABEL = {
  wrong_order: "Wrong order rung",
  kitchen_error: "Kitchen error",
  quality_issue: "Quality issue",
  customer_cancelled: "Customer cancelled",
  overcharge: "Overcharge",
  duplicate: "Duplicate ticket",
  other: "Other",
};

const ENTRY_TYPE_LABEL = {
  card_present: "Credit",
  interac_present: "Interac Debit",
};

const money = (n) => `$${Number(n).toFixed(2)}`;

export default function ReceiptModal({ orderId, onClose }) {
  const [receipt, setReceipt] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Email panel — closed until asked for, so the common case (print and go)
  // stays a single tap.
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [emailState, setEmailState] = useState(null); // 'sending' | 'sent' | error string

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/orders/${orderId}/receipt`, {
          credentials: "include",
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || "Could not load this receipt");
        setReceipt(data.receipt);
      } catch (err) {
        if (!cancelled) setLoadError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const sendEmail = useCallback(
    async (e) => {
      e.preventDefault();
      setEmailState("sending");
      try {
        const res = await fetch(`${API_URL}/api/orders/${orderId}/receipt/email`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not send the receipt");
        setEmailState("sent");
      } catch (err) {
        setEmailState(err.message);
      }
    },
    [orderId, email]
  );

  return (
    <div className="rcpt-backdrop" onClick={onClose}>
      <div className="rcpt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rcpt-header">
          <h2 className="rcpt-header-title">Receipt</h2>
          <button className="rcpt-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="rcpt-scroll">
          {loadError && <div className="rcpt-error">{loadError}</div>}
          {!receipt && !loadError && <div className="rcpt-loading">Loading receipt…</div>}

          {receipt && (
            /* The ONLY element the print stylesheet keeps visible. Everything
               outside it — modal chrome, the app behind it — is hidden at
               print time so a thermal printer gets the paper, not the UI. */
            <div className="rcpt-paper" id="rcpt-print-area">
              <div className="rcpt-brand">{receipt.business.name}</div>
              {receipt.business.address && (
                <div className="rcpt-brand-line">{receipt.business.address}</div>
              )}
              {receipt.business.phone && (
                <div className="rcpt-brand-line">{receipt.business.phone}</div>
              )}
              {receipt.business.taxNumber && (
                <div className="rcpt-brand-line">HST# {receipt.business.taxNumber}</div>
              )}

              {receipt.order.voided && <div className="rcpt-void">*** VOIDED ***</div>}

              <div className="rcpt-rule" />

              <div className="rcpt-meta">
                <div className="rcpt-order-no">ORDER #{receipt.order.number}</div>
                <div>{new Date(receipt.order.placedAt).toLocaleString()}</div>
                <div>Served by {receipt.order.servedBy}</div>
              </div>

              <div className="rcpt-rule" />

              <div className="rcpt-lines">
                {receipt.lines.map((line) => (
                  <div key={line.id} className="rcpt-line">
                    <div className="rcpt-line-main">
                      <span className="rcpt-line-qty">{line.quantity}×</span>
                      <span className="rcpt-line-name">
                        {line.name}
                        {line.variantName ? ` (${line.variantName})` : ""}
                      </span>
                      <span className="rcpt-line-amt">{money(line.lineTotal)}</span>
                    </div>

                    {/* Descriptive only — the line amount above already
                        includes every modifier and paid add-on. */}
                    {line.choices.map((c, i) => (
                      <div key={`c${i}`} className="rcpt-sub">{c.choice}</div>
                    ))}
                    {line.added.map((a, i) => (
                      <div key={`a${i}`} className="rcpt-sub">
                        + {a.name}
                        {a.quantity > 1 ? ` ×${a.quantity}` : ""}
                      </div>
                    ))}
                    {line.removed.map((r, i) => (
                      <div key={`r${i}`} className="rcpt-sub">NO {r}</div>
                    ))}
                    {line.addons.map((ad, i) => (
                      <div key={`ad${i}`} className="rcpt-sub">
                        + {ad.name}
                        {ad.quantity > 1 ? ` ×${ad.quantity}` : ""}
                        {ad.complimentary ? " (incl.)" : ""}
                      </div>
                    ))}
                    {line.notes && <div className="rcpt-sub rcpt-sub--note">“{line.notes}”</div>}
                  </div>
                ))}
              </div>

              <div className="rcpt-rule" />

              <div className="rcpt-totals">
                <div className="rcpt-total-row">
                  <span>Subtotal</span>
                  <span>{money(receipt.totals.subtotal)}</span>
                </div>
                {receipt.totals.discount > 0 && (
                  <div className="rcpt-total-row">
                    <span>
                      Discount
                      {receipt.totals.discountPercent ? ` ${receipt.totals.discountPercent}%` : ""}
                      {receipt.totals.discountReason
                        ? ` — ${DISCOUNT_REASON_LABEL[receipt.totals.discountReason] || receipt.totals.discountReason}`
                        : ""}
                    </span>
                    <span>−{money(receipt.totals.discount)}</span>
                  </div>
                )}
                <div className="rcpt-total-row">
                  <span>HST {receipt.totals.taxRatePercent}%</span>
                  <span>{money(receipt.totals.tax)}</span>
                </div>
                {receipt.totals.tip > 0 && (
                  <div className="rcpt-total-row">
                    <span>Tip</span>
                    <span>{money(receipt.totals.tip)}</span>
                  </div>
                )}
                <div className="rcpt-total-row rcpt-total-row--grand">
                  <span>TOTAL</span>
                  <span>{money(receipt.totals.total)}</span>
                </div>
              </div>

              <div className="rcpt-rule" />

              <div className="rcpt-pay">
                {receipt.payment ? (
                  <>
                    <div className="rcpt-total-row">
                      <span>
                        {receipt.payment.method === "cash"
                          ? "Cash"
                          : ENTRY_TYPE_LABEL[receipt.payment.entryType] || "Card"}
                        {receipt.payment.cardBrand
                          ? ` — ${receipt.payment.cardBrand.toUpperCase()}`
                          : ""}
                        {receipt.payment.cardLast4 ? ` ••••${receipt.payment.cardLast4}` : ""}
                      </span>
                      <span>{money(receipt.payment.amount)}</span>
                    </div>
                    {receipt.payment.processorTxnId && (
                      <div className="rcpt-txn">Ref {receipt.payment.processorTxnId}</div>
                    )}
                  </>
                ) : (
                  <div className="rcpt-txn">No payment recorded</div>
                )}
              </div>

              {/* A reprint after a reversal has to say so, or the paper claims
                  the customer paid money they have since had back. */}
              {receipt.refunds.length > 0 && (
                <>
                  <div className="rcpt-rule" />
                  <div className="rcpt-totals">
                    {receipt.refunds.map((r) => (
                      <div key={r.id} className="rcpt-total-row">
                        <span>
                          {r.type === "void" ? "Void" : "Refund"} —{" "}
                          {REFUND_REASON_LABEL[r.reason] || r.reason}
                        </span>
                        <span>−{money(r.amount)}</span>
                      </div>
                    ))}
                    <div className="rcpt-total-row rcpt-total-row--grand">
                      <span>NET PAID</span>
                      <span>{money(receipt.netPaid)}</span>
                    </div>
                  </div>
                </>
              )}

              <div className="rcpt-rule" />
              <div className="rcpt-footer">
                <div>¡Gracias!</div>
                <div>Narcos Tacos</div>
              </div>
            </div>
          )}
        </div>

        {receipt && (
          <div className="rcpt-actions">
            <button className="rcpt-btn rcpt-btn--primary" onClick={() => window.print()}>
              Print
            </button>
            {receipt.email.available ? (
              <button className="rcpt-btn" onClick={() => setEmailOpen((v) => !v)}>
                Email
              </button>
            ) : (
              <span className="rcpt-actions-note" title={receipt.email.reason}>
                Print only
              </span>
            )}
          </div>
        )}

        {receipt?.email.available && emailOpen && (
          <form className="rcpt-email" onSubmit={sendEmail}>
            <input
              className="rcpt-email-input"
              type="email"
              required
              placeholder="customer@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailState(null);
              }}
              disabled={emailState === "sending"}
            />
            <button
              className="rcpt-btn rcpt-btn--primary"
              type="submit"
              disabled={emailState === "sending" || !email}
            >
              {emailState === "sending" ? "Sending…" : "Send"}
            </button>
            {emailState === "sent" && <div className="rcpt-email-ok">✓ Receipt sent</div>}
            {emailState && emailState !== "sending" && emailState !== "sent" && (
              <div className="rcpt-email-err">{emailState}</div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
