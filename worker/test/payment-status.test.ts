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
  returnWaitMs: () => number;
  returnPollDelayMs: (attempt: number) => number;
  stripeConfirmOutcome: (confirmed: unknown) => { kind: string; message?: string };
  clientPaymentResult: (confirmed: unknown) => { ok: boolean; transactionNumber?: string; booking?: { ok?: boolean } } | null;
  checkoutResult: (order: unknown) => {
    ok: boolean;
    reason?: string;
    redirectUrl?: string;
    provider?: string;
    booking?: { ok?: boolean; confirmationSent?: boolean };
  };
  returnScreen: (order: unknown) => { kind: string; provider?: string; redirectUrl?: string; reason?: string };
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

test("a succeeded card is booked immediately and does not wait on the sheet", () => {
  assert.equal(status.confirmWaitMs(true), 0);
  assert.equal(status.confirmWaitMs(false), 8000);
  assert.deepEqual([0, 1, 2, 3].map((attempt) => status.pollDelayMs(attempt)), [250, 500, 800, 800]);
  const succeeded = status.clientPaymentResult({ paymentIntent: { id: "pi_test_1", status: "succeeded" } });
  assert.equal(succeeded && succeeded.ok, true);
  assert.equal(succeeded && succeeded.transactionNumber, "pi_test_1");
  assert.equal(succeeded && succeeded.booking && succeeded.booking.ok, true);
  const processing = status.clientPaymentResult({ paymentIntent: { id: "pi_test_2", status: "processing" } });
  assert.equal(processing && processing.ok, true);
  assert.equal(status.clientPaymentResult({ paymentIntent: { status: "requires_action" } }), null);
});

test("a pending order is not a booking", () => {
  assert.equal(status.pollSettled({ status: "pending", appsScriptPosted: false }), false);
  assert.equal(status.pollSettled({ status: "failed" }), true);
  assert.equal(status.pollSettled({ status: "unknown", error: "not-found" }), true);
  const pending = status.checkoutResult({ status: "pending", provider: "vipps", redirectUrl: "https://apitest.vipps.no/pay/abc" });
  assert.equal(pending.ok, false);
  assert.equal(pending.reason, "pending");
  assert.equal(pending.booking, undefined);
  const screen = status.returnScreen({ status: "pending", provider: "vipps", redirectUrl: "https://apitest.vipps.no/pay/abc" });
  assert.equal(screen.kind, "waiting");
  assert.equal(screen.provider, "vipps");
  assert.equal(screen.redirectUrl, "https://apitest.vipps.no/pay/abc");
  assert.equal(status.returnScreen({ status: "reserved" }).kind, "waiting");
  assert.equal(status.returnWaitMs(), 30000);
  assert.deepEqual([0, 1, 4, 9].map((attempt) => status.returnPollDelayMs(attempt)), [500, 1000, 5000, 5000]);
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

test("aborted and expired Vipps returns are the failed screen", () => {
  assert.equal(status.returnScreen({ status: "failed", failureReason: "aborted" }).kind, "failed");
  assert.equal(status.returnScreen({ status: "failed", failureReason: "expired" }).reason, "expired");
  assert.equal(status.checkoutResult({ status: "pending" }).ok, false);
});

test("the return page offers Vipps again and the card form defaults to card", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  assert.match(html, /id="bk-step-waiting"/);
  assert.match(html, /id="bk-vipps-again"[^>]*>Open Vipps again/);
  assert.match(html, /data-action="start-over"/);
  assert.match(css, /a\.bk-btn \{[^}]*text-decoration: none;/);
  assert.equal(app.includes('paymentMethod: "apple"'), false);
  assert.match(app, /paymentMethod: "card"/);
  assert.match(app, /locale: "en"/);
  assert.match(app, /clientPaymentResult/);
  assert.match(app, /returnScreen/);
  assert.match(app, /Open Vipps again|bk-vipps-again/);
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
