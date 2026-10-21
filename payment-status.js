/**
 * Checkout decisions shared by app.js and the node tests.
 * A paid order is booked as soon as GET /order says status "paid".
 * The spreadsheet write (appsScriptPosted) can still be running; the page
 * must not wait for it or show "still confirming".
 * A card decline is a Stripe error, not a pending order, so it never polls.
 */
(function (root) {
  "use strict";

  function outcomeFromOrder(data) {
    if (!data || data.status === "unknown" || data.error === "not-found") return { kind: "missing" };
    if (data.status === "paid") {
      return {
        kind: "paid",
        transactionNumber: data.paymentId || "",
        confirmationSent: data.confirmationSent === true,
      };
    }
    if (data.status === "failed" || data.status === "cancelled") return { kind: "failed" };
    if (data.status === "reserved") return { kind: "reserved" };
    return { kind: "pending" };
  }

  function pollSettled(data) {
    const kind = outcomeFromOrder(data).kind;
    return kind === "paid" || kind === "failed" || kind === "reserved" || kind === "missing";
  }

  function stripeConfirmOutcome(confirmed) {
    if (!confirmed || confirmed.error) {
      return { kind: "failed", message: (confirmed && confirmed.error && confirmed.error.message) || "" };
    }
    const intent = confirmed.paymentIntent || null;
    const status = intent && intent.status;
    if (status === "succeeded" || status === "processing" || status === "requires_capture") {
      return {
        kind: "await-webhook",
        succeeded: status === "succeeded",
        paymentIntentId: (intent && intent.id) || "",
      };
    }
    const last = intent && intent.last_payment_error;
    return { kind: "failed", message: (last && last.message) || "" };
  }

  /**
   * Map a polled order, plus what Stripe already told the browser, onto the
   * confirmation screen. succeeded on the client covers a webhook that is a
   * moment late; a decline never becomes "still confirming".
   */
  function checkoutResult(orderData, confirmOutcome) {
    const order = outcomeFromOrder(orderData);
    if (order.kind === "paid") {
      return {
        ok: true,
        transactionNumber: order.transactionNumber,
        booking: { ok: true, confirmationSent: order.confirmationSent, paidByWorker: true },
      };
    }
    if (order.kind === "failed") return { ok: false, reason: "failed" };
    if (order.kind === "missing") return { ok: false, reason: "missing" };
    if (order.kind === "reserved") {
      return {
        ok: true,
        transactionNumber: "",
        booking: { ok: false, pendingConfirmation: true, reserved: true, confirmationSent: false },
      };
    }
    if (confirmOutcome && confirmOutcome.succeeded) {
      return {
        ok: true,
        transactionNumber: confirmOutcome.paymentIntentId || "",
        booking: { ok: true, confirmationSent: false, paidByWorker: true },
      };
    }
    return {
      ok: true,
      transactionNumber: "",
      booking: { ok: false, pendingConfirmation: true, confirmationSent: false },
    };
  }

  const api = { outcomeFromOrder: outcomeFromOrder, pollSettled: pollSettled, stripeConfirmOutcome: stripeConfirmOutcome, checkoutResult: checkoutResult };
  root.HustlePaymentStatus = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
