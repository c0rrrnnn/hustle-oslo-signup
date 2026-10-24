import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const stripeTs = readFileSync(new URL("../src/stripe.ts", import.meta.url), "utf8");

function api() {
  const sandbox = {
    window: {} as Record<string, unknown>,
    document: { readyState: "loading", addEventListener() {} },
    console,
  };
  sandbox.window = sandbox as unknown as Record<string, unknown>;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../../payment-status.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(js, sandbox, { filename: "app.js" });
  return sandbox.window.HustleOslo as {
    walletLikely: (env: unknown) => boolean;
    deferredElementsOptions: (kr: number) => Record<string, unknown>;
  };
}

function section(from: string, to: string) {
  const a = js.indexOf(from);
  const b = js.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, from + " … " + to);
  return js.slice(a, b);
}

test("deferred Elements options match the PaymentIntent the Worker creates", () => {
  const opts = api().deferredElementsOptions(450);
  assert.equal(opts.mode, "payment");
  assert.equal(opts.amount, 45000); // kr → øre
  assert.equal(opts.currency, "nok");
  assert.deepEqual(JSON.parse(JSON.stringify(opts.paymentMethodTypes)), ["card"]);
  assert.equal(opts.captureMethod, "automatic");
  assert.equal(api().deferredElementsOptions(149.5).amount, 14950);
  assert.match(stripeTs, /"payment_method_types\[0\]": "card"/);
  assert.match(stripeTs, /capture_method: "automatic"/);
  assert.match(stripeTs, /currency: "nok"/);
  assert.equal(stripeTs.includes("setup_future_usage"), false);
});

test("deferred wallet confirm: submit, then create the PaymentIntent, then confirm with its clientSecret", () => {
  const fn = section("async function confirmWalletDeferred", "async function payCardDeferred");
  const submit = fn.indexOf("elements.submit()");
  const create = fn.indexOf('postCheckout("card")');
  const confirm = fn.indexOf("confirmPayment(");
  assert.ok(submit > 0 && submit < create && create < confirm);
  assert.match(fn, /clientSecret: created\.clientSecret/);
  assert.match(fn, /paymentUi\.walletElements/);
  assert.match(fn, /paymentUi\.orderId = created\.orderId;\s*savePaymentSession\(created\.orderId\)/);
  assert.match(fn, /"\?order=" \+ encodeURIComponent\(created\.orderId\)/);
  assert.match(fn, /redirect: "if_required"/);
  assert.match(fn, /status === "paid" \|\| created\.status === "reserved"/);
  assert.match(fn, /walletPaymentFailed\(walletEvent/);
  assert.match(fn, /finally \{\s*state\.submitting = false;/);
  // the click handler itself never waits for the network (Apple Pay user gesture)
  const click = section('element.on("click"', 'element.on("confirm"');
  assert.equal(/await|fetch|postCheckout/.test(click), false);
});

test("deferred card pay: card form validated before any order is created", () => {
  const fn = section("async function payCardDeferred", "function resultFromOrder");
  const submit = fn.indexOf("elements.submit()");
  const create = fn.indexOf("postCheckout(method)");
  const confirm = fn.indexOf("confirmPayment(");
  assert.ok(submit > 0 && submit < create && create < confirm);
  assert.match(fn, /reason: "needs-details"/);
  assert.match(fn, /clientSecret: created\.clientSecret/);
  assert.match(fn, /billing_details: \{ name: person\.fullName, email: person\.email \}/);
  const start = section("async function startPayment", "function buildOrder");
  assert.match(start, /if \(method !== "vipps" && paymentUi\.cfg\) return payCardDeferred\(method\);/);
  // Vipps is untouched: still a POST /checkout then redirect
  assert.ok(start.indexOf("payCardDeferred") < start.indexOf("const created = await postCheckout(method)"));
  assert.match(start, /window\.location\.assign\(created\.redirectUrl\)/);
});

test("deferred mount uses /config, separate wallet/card groups, and falls back to the old flow", () => {
  const mount = section("async function mountDeferredNow", "function loadStripeJs");
  assert.match(mount, /const walletElements = stripe\.elements\(deferredElementsOptions\(amountKr\)\)/);
  assert.match(mount, /const cardElements = stripe\.elements\(deferredElementsOptions\(amountKr\)\)/);
  assert.equal(mount.includes("clientSecret"), false);
  assert.equal(mount.includes("postCheckout"), false);
  assert.match(mount, /paymentUi\.nightsKey = nightsKey\(\)/);
  const cfg = section("function loadPaymentConfig", "function preconnectWorker");
  assert.match(cfg, /workerUrl\("\/config"\)/);
  assert.match(cfg, /publishableKeyOk\(data\.publishableKey\)/);
  const prep = section("async function prepareStripeElement", "async function postCheckout");
  assert.ok(prep.indexOf("if (cfg)") < prep.indexOf('postCheckout("card")'), "fallback keeps the old prepare");
  assert.match(js, /function unmountStripeElements[\s\S]*?paymentUi\.walletElements = null;[\s\S]*?paymentUi\.deferred = false;/);
  // reaching checkout or editing the cart re-uses / re-mounts with the new amount
  assert.match(js, /function deferredKey\(\) \{\s*return nightsKey\(\) \+ "\|" \+ currentAmount\(\);/);
  assert.match(js, /warmPayments\(\);\s*go\(state\.submitted/);
});

test("wallet placeholder: 42px same shape, only where a wallet is likely, button fades in", () => {
  assert.match(html, /<div id="bk-wallet-placeholder" class="bk-wallet-ph" aria-hidden="true"><\/div>\s*<div id="bk-express-checkout">/);
  assert.match(html, /rel="preconnect" href="https:\/\/js\.stripe\.com"/);
  assert.match(html, /rel="preconnect" href="https:\/\/api\.stripe\.com" crossorigin/);
  const ph = css.match(/\n\.bk-wallet-ph \{[^}]+\}/);
  assert.ok(ph);
  assert.match(ph[0], /height: 42px;/);
  assert.match(ph[0], /border-radius: 12px;/);
  assert.match(ph[0], /margin: 4px 0;/); // 42 + 4 + 4 = the 50px Stripe iframe, so nothing shifts
  assert.match(css, /\.bk-wallet-host\.is-loading #bk-express-checkout \{[^}]*opacity: 0;/);
  assert.match(css, /#bk-express-checkout \{\s*transition: opacity/);

  const likely = api().walletLikely;
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  assert.equal(likely({ navigator: { userAgent: android }, PaymentRequest: function () {} }), true);
  assert.equal(likely({ navigator: { userAgent: android } }), false);
  assert.equal(likely({ navigator: { userAgent: android.replace("Chrome/", "SamsungBrowser/25 Chrome/") }, PaymentRequest: function () {} }), false);
  assert.equal(likely({ navigator: { userAgent: iphone }, ApplePaySession: { canMakePayments: () => true } }), true);
  assert.equal(likely({ navigator: { userAgent: iphone }, ApplePaySession: { canMakePayments: () => false } }), false);
  assert.equal(likely({ navigator: { userAgent: iphone } }), false);
  assert.equal(likely({ navigator: { userAgent: iphone.replace("Version/18.0", "CriOS/130") }, PaymentRequest: function () {} }), false);
  const place = section("function placeWalletHost", "function walletLikely");
  assert.match(place, /host\.classList\.toggle\("is-loading", loading\)/);
  assert.match(js, /element\.on\("loaderror"/);
});
