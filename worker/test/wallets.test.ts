import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("wallet buttons are Stripe's and exist only after the PaymentIntent", () => {
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /id="bk-express-checkout"/);
  assert.match(js, /if \(paymentsLive\(\)\) return \["vipps", "card"\]/);
  assert.match(js, /applePay: "auto"/);
  assert.match(js, /googlePay: googlePayMode\(\)/);
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

test("wallet buttons are the plain 42px brand buttons and the other options are never taller", () => {
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const ece = js.slice(js.indexOf('elements.create("expressCheckout"'), js.indexOf('element.on("ready"'));
  assert.match(ece, /buttonHeight: 42,/);
  assert.match(ece, /buttonType: \{ applePay: "plain", googlePay: "plain" \}/);
  assert.match(ece, /buttonTheme: \{ applePay: "white", googlePay: "white" \}/);
  assert.equal(ece.includes("buttonHeight: 48"), false);
  const row = css.match(/\n\.bk-mrow \{[^}]+\}/);
  assert.ok(row);
  assert.match(row[0], /padding: 7px 14px;/);
  assert.match(row[0], /min-height: 42px;/);
  assert.match(row[0], /box-sizing: border-box;/);
  assert.match(row[0], /font-weight: 600;/, "option font unchanged");
  assert.match(css, /\.bk-it \{[^}]*width: 26px;[^}]*height: 26px;/, "26px icon + 2x7px padding + 2x1px border = 42px");
});
