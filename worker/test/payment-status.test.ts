import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const status = require("../../payment-status.js") as {
  outcomeFromOrder: (data: unknown) => { kind: string; confirmationSent?: boolean };
  pollSettled: (data: unknown) => boolean;
  confirmWaitMs: (stripeSucceeded: boolean) => number;
  pollDelayMs: (attempt: number) => number;
  stripeConfirmOutcome: (confirmed: unknown) => { kind: string; message?: string; succeeded?: boolean };
  checkoutResult: (order: unknown, confirm: unknown) => {
    ok: boolean;
    reason?: string;
    booking?: { ok?: boolean; pendingConfirmation?: boolean; confirmationSent?: boolean };
  };
};

test("a paid order is booked before the sheet post finishes", () => {
  const paid = {
    status: "paid",
    paymentId: "pi_test_1",
    appsScriptPosted: false,
    confirmationSent: false,
  };
  assert.equal(status.outcomeFromOrder(paid).kind, "paid");
  assert.equal(status.pollSettled(paid), true);
  const view = status.checkoutResult(paid, null);
  assert.equal(view.ok, true);
  assert.equal(view.booking && view.booking.ok, true);
  assert.equal(view.booking && view.booking.pendingConfirmation, undefined);
  assert.equal(view.booking && view.booking.confirmationSent, false);
});

test("a succeeded card waits briefly for the webhook and does not wait on the sheet", () => {
  assert.equal(status.confirmWaitMs(true), 1500);
  assert.equal(status.confirmWaitMs(false), 8000);
  assert.deepEqual([0, 1, 2, 3].map((attempt) => status.pollDelayMs(attempt)), [250, 500, 800, 800]);
});

test("polling keeps waiting only while the order is still pending", () => {
  assert.equal(status.pollSettled({ status: "pending", appsScriptPosted: false }), false);
  assert.equal(status.pollSettled({ status: "failed" }), true);
  assert.equal(status.pollSettled({ status: "unknown", error: "not-found" }), true);
  assert.equal(status.checkoutResult({ status: "pending" }, null).booking?.pendingConfirmation, true);
});

test("a card decline is shown immediately and is not polled", () => {
  const declined = status.stripeConfirmOutcome({ error: { message: "Your card has been declined." } });
  assert.equal(declined.kind, "failed");
  assert.equal(declined.message, "Your card has been declined.");
  const fromIntent = status.stripeConfirmOutcome({
    paymentIntent: {
      status: "requires_payment_method",
      last_payment_error: { message: "Your card has been declined." },
    },
  });
  assert.equal(fromIntent.kind, "failed");
  assert.equal(fromIntent.message, "Your card has been declined.");
});

test("a succeeded PaymentIntent still becomes the booked screen if the poll is still pending", () => {
  const confirmed = status.stripeConfirmOutcome({ paymentIntent: { id: "pi_test_1", status: "succeeded" } });
  assert.equal(confirmed.kind, "await-webhook");
  assert.equal(confirmed.succeeded, true);
  const view = status.checkoutResult({ status: "pending", appsScriptPosted: false }, confirmed);
  assert.equal(view.ok, true);
  assert.equal(view.booking && view.booking.ok, true);
  assert.equal(view.booking && view.booking.pendingConfirmation, undefined);
});

test("the pay button loader is static when motion is reduced", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  assert.match(html, /id="bk-pay"[^>]*aria-busy="false"/);
  assert.match(html, /class="bk-pay-spinner"/);
  assert.match(css, /@keyframes bk-pay-spin/);
  assert.match(css, /\.bk-pay-spinner \{[^}]*animation: none !important;/);
});

test("confirmation and organiser subjects are plain ASCII", () => {
  const src = readFileSync(new URL("../../apps-script/Code.gs", import.meta.url), "utf8");
  assert.match(src, /return "Hustle Oslo - signup received";/);
  assert.equal(src.includes("Hustle Oslo — signup received"), false);
  assert.match(src, /\[Hustle Oslo\] Signup - /);
  assert.equal(src.includes("Signup —"), false);
});
