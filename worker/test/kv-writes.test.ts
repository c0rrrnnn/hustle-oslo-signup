import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleRequest } from "../src/handler.ts";
import { CHECKOUT_OK_TTL_SEC, PENDING_VIPPS_TTL_SEC, UNPOSTED_TTL_SEC } from "../src/orders.ts";
import { clearVippsTokenCache, vippsWebhookAuthorization } from "../src/vipps.ts";
import { backgroundDeps, checkoutBody, jsonResponse, memoryKv, NOW, ORDER_ID, recordFetch, testEnv } from "./helpers.ts";

const SECRET = "whsec_test_secret";
const SERVER_FAIL = "Something went wrong on our side. You haven\u2019t been charged. Try again in a moment.";

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

function countingKv() {
  const kv = memoryKv();
  const puts: { key: string; options?: { expirationTtl?: number } }[] = [];
  const deletes: string[] = [];
  return {
    kv: {
      get: (key: string) => kv.get(key),
      list: (options: { prefix?: string; cursor?: string }) => kv.list(options),
      async put(key: string, value: string, options?: { expirationTtl?: number }) {
        puts.push({ key, options });
        await kv.put(key, value, options);
      },
      async delete(key: string) {
        deletes.push(key);
        await kv.delete(key);
      },
    },
    puts,
    deletes,
    reset() {
      puts.length = 0;
      deletes.length = 0;
    },
  };
}

function installCache() {
  const store = new Map<string, string>();
  const previous = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: { default: unknown } }).caches = {
    default: {
      async match(request: Request) {
        const body = store.get(request.url);
        return body === undefined ? undefined : new Response(body);
      },
      async put(request: Request, response: Response) {
        store.set(request.url, await response.text());
      },
    },
  };
  return () => {
    if (previous === undefined) delete (globalThis as { caches?: unknown }).caches;
    else (globalThis as { caches?: unknown }).caches = previous;
  };
}

function stripeCreate() {
  return jsonResponse({
    id: "pi_test_1",
    client_secret: "pi_test_1_secret_abc",
    amount: 22000,
    currency: "nok",
    status: "requires_payment_method",
    metadata: { orderId: ORDER_ID },
  });
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

function vippsPayment(state: string, captured: number) {
  const amount = 22000;
  return {
    reference: ORDER_ID,
    pspReference: "psp-1",
    state,
    amount: { currency: "NOK", value: amount },
    aggregate: {
      authorizedAmount: { currency: "NOK", value: state === "AUTHORIZED" || captured > 0 ? amount : 0 },
      capturedAmount: { currency: "NOK", value: captured },
    },
  };
}

async function vippsWebhook(body: unknown, when = NOW) {
  const raw = JSON.stringify(body);
  const dateHeader = when.toUTCString();
  const proof = await vippsWebhookAuthorization({
    secret: "vipps-webhook-secret",
    method: "POST",
    pathAndQuery: "/webhooks/vipps",
    host: "payments.test",
    dateHeader,
    rawBody: raw,
  });
  return new Request("https://payments.test/webhooks/vipps", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-ms-date": dateHeader,
      "x-ms-content-sha256": proof.contentHash,
      authorization: proof.authorization,
    },
  });
}

function count(puts: { key: string }[], prefix: string) {
  return puts.filter((put) => put.key.startsWith(prefix)).length;
}

test("card success, decline, and Vipps approve or cancel skip polls, rate-limit keys, and repeat status writes", async () => {
  const restore = installCache();
  try {
    const card = countingKv();
    const cardEnv = testEnv(card.kv);
    let cardState = "requires_payment_method";
    let retrieves = 0;
    const cardFetch = recordFetch((call) => {
      if (call.method === "POST" && call.url.endsWith("/payment_intents")) return stripeCreate();
      if (call.url.includes("/payment_intents/pi_test_1")) {
        retrieves += 1;
        return intent(cardState, { payment_method: { type: "card", card: { wallet: null } } });
      }
      if (call.url === cardEnv.APPS_SCRIPT_URL) return jsonResponse({ ok: true, confirmationSent: true });
      throw new Error("unexpected " + call.url);
    });
    const cardDeps = backgroundDeps({ fetch: cardFetch.fetcher, now: () => NOW });
    assert.equal((await handleRequest(checkoutRequest(checkoutBody()), cardEnv, cardDeps)).status, 200);
    const afterCheckout = card.puts.length;
    assert.equal(afterCheckout, 3);
    assert.equal(count(card.puts, "rl:"), 0);
    assert.equal(count(card.puts, "checkout-ok:"), 1);
    assert.equal(card.puts.find((put) => put.key.startsWith("checkout-ok:"))?.options?.expirationTtl, CHECKOUT_OK_TTL_SEC);

    const pending = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), cardEnv, cardDeps);
    assert.equal((await pending.json()).status, "pending");
    assert.equal(card.puts.length, afterCheckout);
    assert.equal(retrieves, 1);
    const pendingAgain = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), cardEnv, cardDeps);
    assert.equal((await pendingAgain.json()).status, "pending");
    assert.equal(card.puts.length, afterCheckout);
    assert.equal(retrieves, 1);

    cardState = "succeeded";
    const later = new Date(NOW.getTime() + 6000);
    const paidDeps = backgroundDeps({ fetch: cardFetch.fetcher, now: () => later });
    const paid = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), cardEnv, paidDeps);
    assert.equal((await paid.json()).status, "paid");
    await paidDeps.flush();
    assert.equal(card.puts.length, 7);
    assert.equal(count(card.puts, "order:"), 5);
    assert.equal(count(card.puts, "unposted:"), 1);
    assert.equal(card.puts.find((put) => put.key.startsWith("unposted:"))?.options?.expirationTtl, UNPOSTED_TTL_SEC);
    assert.deepEqual(card.deletes, [`unposted:${ORDER_ID}`]);
    card.reset();
    const paidAgain = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), cardEnv, paidDeps);
    assert.equal((await paidAgain.json()).status, "paid");
    assert.equal(card.puts.length, 0);
    assert.equal(card.deletes.length, 0);

    const declined = countingKv();
    const declinedEnv = testEnv(declined.kv);
    const declinedFetch = recordFetch((call) => {
      if (call.method === "POST" && call.url.endsWith("/payment_intents")) return stripeCreate();
      if (call.url.includes("/payment_intents/pi_test_1")) {
        return intent("requires_payment_method", {
          payment_method: { type: "card", card: { wallet: null } },
          last_payment_error: { decline_code: "generic_decline", code: "card_declined" },
        });
      }
      if (call.url === declinedEnv.APPS_SCRIPT_URL) throw new Error("declined orders are not emailed");
      throw new Error("unexpected " + call.url);
    });
    const now = new Date(NOW.getTime() + 5 * 60 * 1000);
    const payload = JSON.stringify({
      id: "evt_fail",
      type: "payment_intent.payment_failed",
      data: { object: { id: "pi_test_1", metadata: { orderId: ORDER_ID } } },
    });
    const webhookRequest = () =>
      new Request("https://payments.test/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": sign(payload, String(Math.floor(now.getTime() / 1000))) },
        body: payload,
      });
    assert.equal((await handleRequest(checkoutRequest(checkoutBody()), declinedEnv, { fetch: declinedFetch.fetcher, now: () => NOW })).status, 200);
    const webhook = await handleRequest(webhookRequest(), declinedEnv, { fetch: declinedFetch.fetcher, now: () => now });
    assert.equal((await webhook.json()).status, "failed");
    assert.equal(declined.puts.length, 4);
    assert.equal(count(declined.puts, "rl:"), 0);
    assert.equal(declined.deletes.length, 0);
    declined.reset();
    const webhookAgain = await handleRequest(webhookRequest(), declinedEnv, { fetch: declinedFetch.fetcher, now: () => now });
    assert.equal((await webhookAgain.json()).status, "failed");
    assert.equal(declined.puts.length, 0);

    clearVippsTokenCache();
    const approved = countingKv();
    const approvedEnv = testEnv(approved.kv);
    let captured = false;
    const approvedFetch = recordFetch((call) => {
      if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "3600" });
      if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
        return jsonResponse({ redirectUrl: "https://apitest.vipps.no/pay/abc", reference: ORDER_ID });
      }
      if (call.method === "POST" && call.url.endsWith("/capture")) {
        captured = true;
        return jsonResponse({ pspReference: "psp-capture" });
      }
      if (call.method === "GET" && call.url.includes("/epayment/v1/payments/")) {
        return jsonResponse(vippsPayment("AUTHORIZED", captured ? 22000 : 0));
      }
      if (call.url === approvedEnv.APPS_SCRIPT_URL) return jsonResponse({ ok: true, confirmationSent: true });
      throw new Error("unexpected " + call.url);
    });
    const approvedDeps = backgroundDeps({ fetch: approvedFetch.fetcher, now: () => NOW });
    assert.equal((await handleRequest(checkoutRequest(checkoutBody({ method: "vipps" })), approvedEnv, approvedDeps)).status, 200);
    const approvedHook = await handleRequest(
      await vippsWebhook({ msn: "123456", reference: ORDER_ID, name: "AUTHORIZED", amount: { currency: "NOK", value: 22000 } }),
      approvedEnv,
      approvedDeps,
    );
    assert.equal((await approvedHook.json()).status, "paid");
    await approvedDeps.flush();
    assert.equal(approved.puts.length, 8);
    assert.equal(count(approved.puts, "pending-vipps:"), 1);
    assert.equal(approved.puts.find((put) => put.key.startsWith("pending-vipps:"))?.options?.expirationTtl, PENDING_VIPPS_TTL_SEC);
    assert.equal(count(approved.puts, "unposted:"), 1);
    assert.deepEqual(approved.deletes, [`unposted:${ORDER_ID}`]);
    assert.equal((await approved.kv.list({ prefix: "pending-vipps:" })).keys.length, 1);

    clearVippsTokenCache();
    const cancelled = countingKv();
    const cancelledEnv = testEnv(cancelled.kv);
    const cancelledFetch = recordFetch((call) => {
      if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "3600" });
      if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
        return jsonResponse({ redirectUrl: "https://apitest.vipps.no/pay/abc", reference: ORDER_ID });
      }
      if (call.method === "GET" && call.url.includes("/epayment/v1/payments/")) return jsonResponse(vippsPayment("ABORTED", 0));
      if (call.url.endsWith("/capture") || call.url === cancelledEnv.APPS_SCRIPT_URL) throw new Error("aborted vipps must not capture or email");
      throw new Error("unexpected " + call.url);
    });
    const cancelledDeps = backgroundDeps({ fetch: cancelledFetch.fetcher, now: () => NOW });
    assert.equal((await handleRequest(checkoutRequest(checkoutBody({ method: "vipps" })), cancelledEnv, cancelledDeps)).status, 200);
    const cancelledOrder = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), cancelledEnv, cancelledDeps);
    assert.equal((await cancelledOrder.json()).failureReason, "aborted");
    assert.equal(cancelled.puts.length, 5);
    assert.equal(count(cancelled.puts, "rl:"), 0);
    assert.equal(cancelled.deletes.length, 0);
    assert.equal((await cancelled.kv.list({ prefix: "pending-vipps:" })).keys.length, 1);
    cancelled.reset();
    const cancelledAgain = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), cancelledEnv, cancelledDeps);
    assert.equal((await cancelledAgain.json()).status, "failed");
    assert.equal(cancelled.puts.length, 0);

    clearVippsTokenCache();
    const webhookCancel = countingKv();
    const webhookCancelEnv = testEnv(webhookCancel.kv);
    const webhookCancelFetch = recordFetch((call) => {
      if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "3600" });
      if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
        return jsonResponse({ redirectUrl: "https://apitest.vipps.no/pay/abc", reference: ORDER_ID });
      }
      if (call.method === "GET" && call.url.includes("/epayment/v1/payments/")) return jsonResponse(vippsPayment("ABORTED", 0));
      if (call.url === webhookCancelEnv.APPS_SCRIPT_URL) throw new Error("aborted vipps must not email");
      throw new Error("unexpected " + call.url);
    });
    const webhookCancelDeps = { fetch: webhookCancelFetch.fetcher, now: () => NOW };
    assert.equal((await handleRequest(checkoutRequest(checkoutBody({ method: "vipps" })), webhookCancelEnv, webhookCancelDeps)).status, 200);
    const cancelHook = await handleRequest(
      await vippsWebhook({ msn: "123456", reference: ORDER_ID, name: "ABORTED", amount: { currency: "NOK", value: 22000 } }),
      webhookCancelEnv,
      webhookCancelDeps,
    );
    assert.equal((await cancelHook.json()).status, "failed");
    assert.equal(webhookCancel.puts.length, 5);
    assert.equal(webhookCancel.deletes.length, 0);
  } finally {
    restore();
  }
});

test("Apple Pay is stored on the paid order write", async () => {
  const restore = installCache();
  try {
    const counter = countingKv();
    const env = testEnv(counter.kv);
    const recorded = recordFetch((call) => {
      if (call.method === "POST" && call.url.endsWith("/payment_intents")) return stripeCreate();
      if (call.url.includes("/payment_intents/pi_test_1")) {
        return intent("succeeded", { payment_method: { type: "card", card: { wallet: { type: "apple_pay" } } } });
      }
      if (call.url === env.APPS_SCRIPT_URL) return jsonResponse({ ok: true, confirmationSent: true });
      throw new Error("unexpected " + call.url);
    });
    const deps = backgroundDeps({ fetch: recorded.fetcher, now: () => NOW });
    assert.equal((await handleRequest(checkoutRequest(checkoutBody()), env, deps)).status, 200);
    const response = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), env, deps);
    const body = await response.json();
    assert.equal(body.method, "apple");
    await deps.flush();
    assert.equal(counter.puts.length, 7);
    const stored = await counter.kv.get(`order:${ORDER_ID}`);
    assert.equal(stored && JSON.parse(stored).method, "apple");
  } finally {
    restore();
  }
});

test("a checkout 500 names a server failure instead of repeating the declined-payment line", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  env.ORDERS = {
    ...kv,
    async get() {
      throw new Error("KV put() limit exceeded for the day");
    },
  };
  const response = await handleRequest(checkoutRequest(checkoutBody()), env, { now: () => NOW });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "internal");
  assert.equal(body.message, SERVER_FAIL);
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  assert.match(js, /res\.status >= 500/);
  assert.match(js, /Something went wrong on our side\. You haven’t been charged\. Try again in a moment\./);
});
