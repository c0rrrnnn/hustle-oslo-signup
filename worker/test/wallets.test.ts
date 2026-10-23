import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("wallet buttons are Stripe's and exist only after the PaymentIntent", () => {
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /id="bk-express-checkout"/);
  assert.match(js, /if \(paymentsLive\(\)\) return \["vipps", "card"\]/);
  assert.match(js, /applePay: "auto"/);
  assert.match(js, /googlePay: "auto"/);
  assert.match(js, /wallets: \{ applePay: "never", googlePay: "never", link: "never" \}/);
  assert.match(js, /layout: \{ maxColumns: 1, maxRows: 0, overflow: "never" \}/);
  assert.equal(js.includes('maxRows: 2, overflow: "never"'), false);
  assert.match(js, /address:\s*\{\s*country:\s*"NO"\s*\}/);
  assert.match(js, /availablePaymentMethods/);
  assert.match(js, /postCheckout\("card"\)/);

  const click = js.slice(js.indexOf('element.on("click"'), js.indexOf('element.on("confirm"'));
  assert.match(click, /event\.resolve\(\)/);
  assert.equal(click.includes("await"), false);
  assert.equal(click.includes("postCheckout"), false);
  assert.equal(click.includes("fetch"), false);

  const confirm = js.slice(js.indexOf("function walletPaymentFailed"), js.indexOf("function resultFromOrder"));
  assert.equal(confirm.includes("postCheckout"), false);
  assert.match(confirm, /confirmPayment/);
  assert.match(confirm, /paymentFailed/);
  assert.match(js, /paymentUi\.nightsKey === nightsKey\(\)/);

  const start = js.slice(js.indexOf("async function startPayment"), js.indexOf("function buildOrder"));
  const walletReturn = start.indexOf('method === "apple" || method === "google"');
  const firstAwait = start.indexOf("await ");
  assert.ok(walletReturn > 0 && walletReturn < firstAwait);
});
