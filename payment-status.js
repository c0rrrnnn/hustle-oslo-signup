/**
 * Checkout decisions shared by app.js and the node tests.
 * A paid order is booked as soon as GET /order says status "paid".
 * The spreadsheet write (appsScriptPosted) can still be running; the page
 * must not wait for it.
 * A succeeded or processing PaymentIntent from Stripe.js is booked immediately.
 * A pending order, including a Vipps return before anyone pays, is not a booking.
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

  /** How long a return page keeps asking. A succeeded PaymentIntent does not use this. */
  function confirmWaitMs(stripeSucceeded) {
    return stripeSucceeded ? 0 : 8000;
  }

  function pollDelayMs(attempt) {
    const delay = 250 * 2 ** Math.min(attempt, 4);
    return delay > 800 ? 800 : delay;
  }

  /** Vipps (and any other) return that is not yet paid. */
  function returnWaitMs() {
    return 30000;
  }

  function returnPollDelayMs(attempt) {
    const steps = [500, 1000, 2000, 4000, 5000];
    const index = attempt < 0 ? 0 : attempt;
    return steps[index < steps.length ? index : steps.length - 1];
  }

  function stripeConfirmOutcome(confirmed) {
    if (!confirmed || confirmed.error) {
      return { kind: "failed", message: (confirmed && confirmed.error && confirmed.error.message) || "" };
    }
    const intent = confirmed.paymentIntent || null;
    const status = intent && intent.status;
    if (status === "succeeded" || status === "processing") {
      return { kind: "paid-now", paymentIntentId: (intent && intent.id) || "" };
    }
    if (status === "requires_payment_method" || status === "canceled") {
      const last = intent && intent.last_payment_error;
      return { kind: "failed", message: (last && last.message) || "" };
    }
    return { kind: "pending", paymentIntentId: (intent && intent.id) || "" };
  }

  /** Immediate client result. Null means Stripe has not settled, so the page may poll. */
  function clientPaymentResult(confirmed) {
    const decision = stripeConfirmOutcome(confirmed);
    if (decision.kind === "failed") return { ok: false, message: decision.message || "" };
    if (decision.kind === "paid-now") {
      return {
        ok: true,
        transactionNumber: decision.paymentIntentId || "",
        booking: { ok: true, confirmationSent: false, paidByWorker: true },
      };
    }
    return null;
  }

  /**
   * Map a polled order onto a screen. Pending is never a booking, so a Vipps
   * return before payment cannot show a checkmark or calendar buttons.
   */
  function checkoutResult(orderData) {
    const order = outcomeFromOrder(orderData);
    if (order.kind === "paid") {
      return {
        ok: true,
        transactionNumber: order.transactionNumber,
        booking: { ok: true, confirmationSent: order.confirmationSent, paidByWorker: true },
      };
    }
    if (order.kind === "failed") return { ok: false, reason: "failed", failureReason: (orderData && orderData.failureReason) || "" };
    if (order.kind === "missing") return { ok: false, reason: "missing" };
    return {
      ok: false,
      reason: "pending",
      redirectUrl: (orderData && orderData.redirectUrl) || "",
      provider: (orderData && orderData.provider) || "",
    };
  }

  function returnScreen(orderData) {
    const result = checkoutResult(orderData);
    if (result.ok) {
      return {
        kind: "paid",
        transactionNumber: result.transactionNumber || "",
        confirmationSent: !!(result.booking && result.booking.confirmationSent),
      };
    }
    if (result.reason === "pending") {
      return { kind: "waiting", provider: result.provider || "", redirectUrl: result.redirectUrl || "" };
    }
    return { kind: "failed", reason: result.reason === "missing" ? "missing" : result.failureReason || "failed" };
  }

  const api = {
    outcomeFromOrder: outcomeFromOrder,
    pollSettled: pollSettled,
    confirmWaitMs: confirmWaitMs,
    pollDelayMs: pollDelayMs,
    returnWaitMs: returnWaitMs,
    returnPollDelayMs: returnPollDelayMs,
    stripeConfirmOutcome: stripeConfirmOutcome,
    clientPaymentResult: clientPaymentResult,
    checkoutResult: checkoutResult,
    returnScreen: returnScreen,
  };
  root.HustlePaymentStatus = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
