import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { handleRequest } from "../src/handler.ts";
import { getOrder } from "../src/orders.ts";
import { decideStripe, payMethodLabel, stripePayMethod } from "../src/stripe.ts";
import { clearVippsTokenCache } from "../src/vipps.ts";
import { backgroundDeps, checkoutBody, jsonResponse, memoryKv, NOW, ORDER_ID, recordFetch, testEnv } from "./helpers.ts";

const SECRET = "whsec_test_secret";

function sign(payload: string, timestamp: string): string {
  const hex = createHmac("sha256", SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${hex}`;
}

function checkoutRequest(body: unknown) {
  return new Request("https://payments.test/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://hustleoslo.com" },
    body: JSON.stringify(body),
  });
}

function stripeCreate(orderId: string) {
  return jsonResponse({
    id: "pi_" + orderId.slice(0, 8),
    client_secret: "secret",
    amount: 22000,
    currency: "nok",
    status: "requires_payment_method",
    metadata: { orderId },
  });
}

test("phone is optional and must be digits, spaces, and an optional leading plus", async () => {
  const env = testEnv(memoryKv());
  const recorded = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) return stripeCreate("33333333");
    throw new Error("unexpected " + call.url);
  });
  const deps = { fetch: recorded.fetcher, now: () => NOW };

  const bad = await handleRequest(
    checkoutRequest(checkoutBody({
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      customer: { fullName: "Claire Wu", email: "claire@example.com", phone: "abc" },
    })),
    env,
    deps,
  );
  const badBody = await bad.json();
  assert.equal(bad.status, 400);
  assert.equal(badBody.error, "phone");
  assert.equal(badBody.message, "Enter a phone number, or leave it blank.");
  assert.equal(recorded.calls.length, 0);

  const short = await handleRequest(
    checkoutRequest(checkoutBody({
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      customer: { fullName: "Claire Wu", email: "claire@example.com", phone: "12" },
    })),
    env,
    deps,
  );
  assert.equal(short.status, 400);
  assert.equal((await short.json()).error, "phone");

  for (const [phone, key] of [
    ["", "33333333-3333-4333-8333-333333333333"],
    ["46862806", "55555555-5555-4555-8555-555555555555"],
    ["+47 468 62 806", "44444444-4444-4444-8444-444444444444"],
  ] as const) {
    const ok = await handleRequest(
      checkoutRequest(checkoutBody({
        idempotencyKey: key,
        customer: { fullName: "Claire Wu", email: "claire@example.com", phone },
      })),
      env,
      deps,
    );
    assert.equal(ok.status, 200, phone + " " + JSON.stringify(await ok.clone().json()));
  }
});

test("a wallet on the PaymentIntent is what the sheet records", () => {
  assert.equal(stripePayMethod({ payment_method: "pm_123" }), null);
  assert.equal(stripePayMethod({ payment_method: { type: "card", card: { wallet: { type: "apple_pay" } } } }), "apple");
  assert.equal(stripePayMethod({ payment_method: { type: "card", card: { wallet: { type: "google_pay" } } } }), "google");
  assert.equal(stripePayMethod({ payment_method: { type: "card", card: { wallet: null } } }), "card");
  assert.equal(payMethodLabel("apple"), "Apple Pay");
  assert.equal(payMethodLabel("google"), "Google Pay");
  assert.equal(payMethodLabel("card"), "Card");
  assert.equal(payMethodLabel("vipps"), "Vipps");
  const order = { orderId: ORDER_ID, amountMinor: 22000, paymentId: "pi_test_1" };
  assert.deepEqual(
    decideStripe({ id: "pi_test_1", amount: 22000, currency: "nok", status: "requires_payment_method", metadata: { orderId: ORDER_ID } }, order),
    { action: "pending", reason: "requires_payment_method" },
  );
  assert.deepEqual(
    decideStripe({
      id: "pi_test_1",
      amount: 22000,
      currency: "nok",
      status: "requires_payment_method",
      metadata: { orderId: ORDER_ID },
      last_payment_error: { decline_code: "insufficient_funds", code: "card_declined" },
    }, order),
    { action: "failed", reason: "insufficient_funds" },
  );
});

async function seedCard(orderId = ORDER_ID) {
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      return jsonResponse({
        id: "pi_test_1",
        client_secret: "pi_test_1_secret_abc",
        amount: 22000,
        currency: "nok",
        status: "requires_payment_method",
        metadata: { orderId },
      });
    }
    throw new Error("unexpected " + call.url);
  });
  const response = await handleRequest(
    checkoutRequest(checkoutBody({ idempotencyKey: orderId })),
    env,
    { fetch: recorded.fetcher, now: () => NOW },
  );
  assert.equal(response.status, 200);
  return { kv, env };
}

function intent(status: string, extra: Record<string, unknown> = {}) {
  return jsonResponse({
    id: "pi_test_1",
    amount: 22000,
    currency: "nok",
    status,
    metadata: { orderId: ORDER_ID },
    ...extra,
  });
}

test("GET /order marks a succeeded card paid and records Apple Pay once", async () => {
  const { kv, env } = await seedCard();
  const scriptBodies: Record<string, unknown>[] = [];
  const recorded = recordFetch((call) => {
    if (call.url.includes("/payment_intents/pi_test_1")) {
      return intent("succeeded", {
        payment_method: { type: "card", card: { wallet: { type: "apple_pay" } } },
      });
    }
    if (call.url === env.APPS_SCRIPT_URL) {
      scriptBodies.push(JSON.parse(call.body) as Record<string, unknown>);
      return jsonResponse({ ok: true, confirmationSent: true });
    }
    throw new Error("unexpected " + call.url);
  });
  const deps = backgroundDeps({ fetch: recorded.fetcher, now: () => NOW });
  const response = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), env, deps);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "paid");
  assert.equal(body.method, "Apple Pay");
  assert.equal(body.email, undefined);
  assert.equal(body.fullName, undefined);
  await deps.flush();
  assert.equal(scriptBodies.length, 1);
  assert.equal(scriptBodies[0].paymentMethod, "Apple Pay");
  assert.equal(scriptBodies[0].paymentStatus, "paid");
  assert.equal((await getOrder(kv, ORDER_ID))?.method, "Apple Pay");

  const now = new Date("2026-10-15T10:05:00.000Z");
  const payload = JSON.stringify({
    id: "evt_1",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_test_1", metadata: { orderId: ORDER_ID } } },
  });
  const webhookDeps = backgroundDeps({ fetch: recorded.fetcher, now: () => now });
  const again = await handleRequest(
    new Request("https://payments.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": sign(payload, String(Math.floor(now.getTime() / 1000))) },
      body: payload,
    }),
    env,
    webhookDeps,
  );
  assert.equal(again.status, 200);
  await webhookDeps.flush();
  assert.equal(scriptBodies.length, 1);
});

test("a declined card is failed from the webhook and from the order check", async () => {
  const { kv, env } = await seedCard();
  const declined = {
    payment_method: { type: "card", card: { wallet: null } },
    last_payment_error: { decline_code: "generic_decline", message: "Your card was declined." },
  };
  const recorded = recordFetch((call) => {
    if (call.url.includes("/payment_intents/pi_test_1")) return intent("requires_payment_method", declined);
    if (call.url === env.APPS_SCRIPT_URL) throw new Error("declined orders are not emailed");
    throw new Error("unexpected " + call.url);
  });
  const now = new Date("2026-10-15T10:05:00.000Z");
  const payload = JSON.stringify({
    id: "evt_fail",
    type: "payment_intent.payment_failed",
    data: { object: { id: "pi_test_1", metadata: { orderId: ORDER_ID } } },
  });
  const webhook = await handleRequest(
    new Request("https://payments.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": sign(payload, String(Math.floor(now.getTime() / 1000))) },
      body: payload,
    }),
    env,
    { fetch: recorded.fetcher, now: () => now },
  );
  const webhookBody = await webhook.json();
  assert.equal(webhook.status, 200);
  assert.equal(webhookBody.status, "failed");
  assert.equal(webhookBody.reason, "generic_decline");
  assert.equal((await getOrder(kv, ORDER_ID))?.status, "failed");
  assert.equal((await getOrder(kv, ORDER_ID))?.failureReason, "generic_decline");

  const { kv: kv2, env: env2 } = await seedCard();
  const checked = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), env2, {
    fetch: recorded.fetcher,
    now: () => NOW,
  });
  const checkedBody = await checked.json();
  assert.equal(checkedBody.status, "failed");
  assert.equal(checkedBody.failureReason, "generic_decline");
  assert.equal(checkedBody.redirectUrl, null);
  assert.equal((await getOrder(kv2, ORDER_ID))?.status, "failed");
});

test("a Vipps return before payment stays pending and keeps the redirect", async () => {
  clearVippsTokenCache();
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = recordFetch((call) => {
    if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "3600" });
    if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
      return jsonResponse({ redirectUrl: "https://apitest.vipps.no/pay/abc", reference: ORDER_ID });
    }
    if (call.method === "GET" && call.url.includes("/epayment/v1/payments/")) {
      return jsonResponse({
        reference: ORDER_ID,
        state: "CREATED",
        amount: { currency: "NOK", value: 22000 },
        aggregate: { authorizedAmount: { currency: "NOK", value: 0 }, capturedAmount: { currency: "NOK", value: 0 } },
      });
    }
    if (call.url.includes("/capture") || call.url === env.APPS_SCRIPT_URL) throw new Error("unpaid vipps must not capture or email");
    throw new Error("unexpected " + call.url);
  });
  const created = await handleRequest(
    checkoutRequest(checkoutBody({ method: "vipps" })),
    env,
    { fetch: recorded.fetcher, now: () => NOW },
  );
  assert.equal(created.status, 200);
  const response = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), env, {
    fetch: recorded.fetcher,
    now: () => NOW,
  });
  const body = await response.json();
  assert.equal(body.status, "pending");
  assert.equal(body.provider, "vipps");
  assert.equal(body.redirectUrl, "https://apitest.vipps.no/pay/abc");
  assert.equal(body.email, undefined);
  assert.equal(body.fullName, undefined);
  assert.equal(body.nights, undefined);
  // The cart comes back for a return in another browser: ids and tier only, no personal data.
  const stored = await getOrder(kv, ORDER_ID);
  assert.ok(body.cart && Array.isArray(body.cart.nights) && body.cart.nights.length > 0);
  assert.equal(body.cart.nights.length, stored?.nights.length);
  for (const night of body.cart.nights) assert.deepEqual(Object.keys(night).sort(), ["eventId", "priceTier", "ticketId"]);
  assert.equal(body.cart.nights[0].eventId, stored?.nights[0].eventId);
  const text = JSON.stringify(body);
  assert.equal(text.includes(stored?.customer.email || "@"), false);
  assert.equal(text.includes(stored?.customer.phone || "+47"), false);
  assert.equal(text.includes(stored?.customer.fullName || "name"), false);
  assert.equal((await getOrder(kv, ORDER_ID))?.status, "pending");
});

test("an aborted Vipps payment is failed and drops the redirect", async () => {
  clearVippsTokenCache();
  const env = testEnv(memoryKv());
  const recorded = recordFetch((call) => {
    if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "3600" });
    if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
      return jsonResponse({ redirectUrl: "https://apitest.vipps.no/pay/abc", reference: ORDER_ID });
    }
    if (call.method === "GET" && call.url.includes("/epayment/v1/payments/")) {
      return jsonResponse({
        reference: ORDER_ID,
        state: "ABORTED",
        amount: { currency: "NOK", value: 22000 },
        aggregate: { authorizedAmount: { currency: "NOK", value: 0 }, capturedAmount: { currency: "NOK", value: 0 } },
      });
    }
    if (call.url === env.APPS_SCRIPT_URL) throw new Error("aborted vipps must not email");
    throw new Error("unexpected " + call.url);
  });
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  assert.equal((await handleRequest(checkoutRequest(checkoutBody({ method: "vipps" })), env, deps)).status, 200);
  const response = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), env, deps);
  const body = await response.json();
  assert.equal(body.status, "failed");
  assert.equal(body.failureReason, "aborted");
  assert.equal(body.redirectUrl, null);
});

test("Apple Pay, Google Pay, a plain card, and Vipps use one label on the order and the sheet", async () => {
  const wallets = [
    { wallet: { type: "apple_pay" }, label: "Apple Pay" },
    { wallet: { type: "google_pay" }, label: "Google Pay" },
    { wallet: null, label: "Card" },
  ] as const;
  for (const item of wallets) {
    const { kv, env } = await seedCard();
    const scriptBodies: Record<string, unknown>[] = [];
    let retrieveUrl = "";
    const recorded = recordFetch((call) => {
      if (call.url.includes("/payment_intents/pi_test_1")) {
        retrieveUrl = call.url;
        return intent("succeeded", {
          payment_method: { type: "card", card: { wallet: item.wallet } },
        });
      }
      if (call.url === env.APPS_SCRIPT_URL) {
        scriptBodies.push(JSON.parse(call.body) as Record<string, unknown>);
        return jsonResponse({ ok: true, confirmationSent: true });
      }
      throw new Error("unexpected " + call.url);
    });
    const deps = backgroundDeps({ fetch: recorded.fetcher, now: () => NOW });
    const response = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), env, deps);
    const body = await response.json();
    assert.equal(body.method, item.label, item.label);
    assert.ok(retrieveUrl.includes("expand[]=payment_method"), item.label);
    await deps.flush();
    assert.equal(scriptBodies[0].paymentMethod, item.label);
    assert.equal((await getOrder(kv, ORDER_ID))?.method, item.label);
  }

  clearVippsTokenCache();
  const kv = memoryKv();
  const env = testEnv(kv);
  const scriptBodies: Record<string, unknown>[] = [];
  const recorded = recordFetch((call) => {
    if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "3600" });
    if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
      return jsonResponse({ redirectUrl: "https://apitest.vipps.no/pay/abc", reference: ORDER_ID });
    }
    if (call.method === "GET" && call.url.includes("/epayment/v1/payments/")) {
      return jsonResponse({
        reference: ORDER_ID,
        pspReference: "psp-1",
        state: "AUTHORIZED",
        amount: { currency: "NOK", value: 22000 },
        aggregate: {
          authorizedAmount: { currency: "NOK", value: 22000 },
          capturedAmount: { currency: "NOK", value: 22000 },
        },
      });
    }
    if (call.url === env.APPS_SCRIPT_URL) {
      scriptBodies.push(JSON.parse(call.body) as Record<string, unknown>);
      return jsonResponse({ ok: true, confirmationSent: true });
    }
    throw new Error("unexpected " + call.url);
  });
  const deps = backgroundDeps({ fetch: recorded.fetcher, now: () => NOW });
  assert.equal((await handleRequest(checkoutRequest(checkoutBody({ method: "vipps" })), env, deps)).status, 200);
  const paid = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), env, deps);
  const body = await paid.json();
  assert.equal(body.status, "paid");
  assert.equal(body.method, "Vipps");
  await deps.flush();
  assert.equal(scriptBodies[0].paymentMethod, "Vipps");
  assert.equal((await getOrder(kv, ORDER_ID))?.method, "Vipps");
});

test("a PaymentMethod that did not expand keeps the method the client reported", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  const created = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      return jsonResponse({
        id: "pi_test_1",
        client_secret: "pi_test_1_secret_abc",
        amount: 22000,
        currency: "nok",
        status: "requires_payment_method",
        metadata: { orderId: ORDER_ID },
      });
    }
    throw new Error("unexpected " + call.url);
  });
  const checkout = await handleRequest(
    checkoutRequest(checkoutBody({ method: "apple" })),
    env,
    { fetch: created.fetcher, now: () => NOW },
  );
  assert.equal(checkout.status, 200);
  const recorded = recordFetch((call) => {
    if (call.url.includes("/payment_intents/pi_test_1")) {
      return intent("succeeded", { payment_method: "pm_unexpanded" });
    }
    if (call.url === env.APPS_SCRIPT_URL) return jsonResponse({ ok: true, confirmationSent: true });
    throw new Error("unexpected " + call.url);
  });
  const deps = backgroundDeps({ fetch: recorded.fetcher, now: () => NOW });
  const response = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), env, deps);
  const body = await response.json();
  assert.equal(body.method, "Apple Pay");
  await deps.flush();
  assert.equal((await getOrder(kv, ORDER_ID))?.method, "Apple Pay");

  const card = await seedCard();
  const cardFetch = recordFetch((call) => {
    if (call.url.includes("/payment_intents/pi_test_1")) {
      return intent("succeeded", { payment_method: "pm_unexpanded" });
    }
    if (call.url === card.env.APPS_SCRIPT_URL) return jsonResponse({ ok: true, confirmationSent: true });
    throw new Error("unexpected " + call.url);
  });
  const cardDeps = backgroundDeps({ fetch: cardFetch.fetcher, now: () => NOW });
  const cardResponse = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), card.env, cardDeps);
  const cardBody = await cardResponse.json();
  assert.equal(cardBody.method, "Card");
  await cardDeps.flush();
  assert.equal((await getOrder(card.kv, ORDER_ID))?.method, "Card");
});
