import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/handler.ts";
import { getOrder, putOrder } from "../src/orders.ts";
import { checkoutBody, jsonResponse, memoryKv, NOW, ORDER_ID, recordFetch, testEnv } from "./helpers.ts";

function stripeFetch() {
  return recordFetch((call) => {
    if (call.url.includes("script.google.com") || call.url.startsWith("https://api.vipps.no/")) {
      throw new Error("unexpected live call");
    }
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      const params = new URLSearchParams(call.body);
      assert.equal(params.get("amount"), "22000");
      assert.equal(params.get("currency"), "nok");
      assert.equal(params.get("metadata[orderId]"), ORDER_ID);
      assert.equal(call.headers["idempotency-key"], ORDER_ID);
      assert.equal(call.headers.authorization, "Bearer sk_test_123");
      return jsonResponse({
        id: "pi_test_1",
        client_secret: "pi_test_1_secret_abc",
        amount: 22000,
        currency: "nok",
        status: "requires_payment_method",
        metadata: { orderId: ORDER_ID },
      });
    }
    return jsonResponse({ error: { message: "unexpected " + call.url } }, 500);
  });
}

function checkoutRequest(body: unknown) {
  return new Request("https://payments.test/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://hustleoslo.com" },
    body: JSON.stringify(body),
  });
}

test("checkout prices on the server and replays the same order id", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = stripeFetch();
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  const first = await handleRequest(checkoutRequest(checkoutBody()), env, deps);
  const created = await first.json();
  assert.equal(first.status, 200);
  assert.equal(created.ok, true);
  assert.equal(created.orderId, ORDER_ID);
  assert.equal(created.amountNok, 220);
  assert.equal(created.clientSecret, "pi_test_1_secret_abc");
  assert.equal(created.publishableKey, "pk_test_123");
  assert.equal(recorded.calls.filter((call) => call.url.endsWith("/payment_intents")).length, 1);

  const second = await handleRequest(checkoutRequest(checkoutBody({ amount: 999999 })), env, deps);
  const replay = await second.json();
  assert.equal(second.status, 200);
  assert.equal(replay.replay, true);
  assert.equal(replay.orderId, ORDER_ID);
  assert.equal(replay.amountNok, 220);
  assert.equal(replay.clientSecret, "pi_test_1_secret_abc");
  assert.equal(recorded.calls.filter((call) => call.url.endsWith("/payment_intents")).length, 1);

  const stored = await getOrder(kv, ORDER_ID);
  assert.equal(stored?.amountMinor, 22000);
  assert.equal(stored?.nights[0].amount, 220);
});

test("the same idempotency key with a different booking conflicts", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = stripeFetch();
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  const first = await handleRequest(checkoutRequest(checkoutBody()), env, deps);
  assert.equal(first.status, 200);
  const second = await handleRequest(
    checkoutRequest(
      checkoutBody({
        nights: [{ eventId: "2026-12-07-class-gymsalen", ticketId: "beginners", priceTier: "standard" }],
      }),
    ),
    env,
    deps,
  );
  const body = await second.json();
  assert.equal(second.status, 409);
  assert.equal(body.error, "idempotency-conflict");
  assert.equal(recorded.calls.filter((call) => call.url.endsWith("/payment_intents")).length, 1);
  const stored = await getOrder(kv, ORDER_ID);
  assert.equal(stored?.amountNok, 220);
});

test("a live Stripe key is refused before any provider call", async () => {
  const recorded = stripeFetch();
  const response = await handleRequest(
    checkoutRequest(checkoutBody()),
    testEnv(memoryKv(), { STRIPE_SECRET_KEY: "sk_live_nope" }),
    { fetch: recorded.fetcher, now: () => NOW },
  );
  assert.equal(response.status, 403);
  assert.equal(recorded.calls.length, 0);
});

test("a paid order is not charged again", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = stripeFetch();
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  assert.equal((await handleRequest(checkoutRequest(checkoutBody()), env, deps)).status, 200);
  const stored = await getOrder(kv, ORDER_ID);
  assert.ok(stored);
  stored.status = "paid";
  stored.paymentId = "pi_test_1";
  stored.appsScriptPosted = true;
  await putOrder(kv, stored);
  const again = await handleRequest(checkoutRequest(checkoutBody()), env, deps);
  const body = await again.json();
  assert.equal(body.status, "paid");
  assert.equal(body.clientSecret, null);
  assert.equal(recorded.calls.filter((call) => call.url.endsWith("/payment_intents")).length, 1);
});
