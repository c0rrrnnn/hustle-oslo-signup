import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleRequest } from "../src/handler.ts";
import { clearVippsTokenCache } from "../src/vipps.ts";
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

test("the deployed allow-list is the public site and live mode stays off", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const origins = toml.split("\n").find((line) => line.startsWith("ALLOWED_ORIGINS"));
  assert.equal(origins, 'ALLOWED_ORIGINS = "https://hustleoslo.com,https://www.hustleoslo.com"');
  assert.match(toml, /ALLOW_LIVE_PAYMENTS = "false"/);
});

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

test("checkout is rate limited", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = stripeFetch();
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await handleRequest(checkoutRequest(checkoutBody()), env, deps);
    assert.equal(response.status, 200);
  }
  const blocked = await handleRequest(checkoutRequest(checkoutBody()), env, deps);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, "rate-limit");
});

test("a simultaneous second checkout does not mark a successful order failed", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  let started = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorded = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      started += 1;
      return gate.then(() =>
        jsonResponse({
          id: "pi_test_1",
          client_secret: "pi_test_1_secret_abc",
          amount: 22000,
          currency: "nok",
          status: "requires_payment_method",
          metadata: { orderId: ORDER_ID },
        }),
      );
    }
    return jsonResponse({ error: { message: "unexpected " + call.url } }, 500);
  });
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  const first = handleRequest(checkoutRequest(checkoutBody()), env, deps);
  for (let i = 0; i < 40 && started < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await handleRequest(checkoutRequest(checkoutBody()), env, deps);
  const secondBody = await second.json();
  assert.equal(second.status, 409, JSON.stringify(secondBody));
  assert.equal(secondBody.error, "checkout-in-progress");
  release();
  const created = await first;
  assert.equal(created.status, 200);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.status, "pending");
  assert.equal(order?.failureReason, null);
  assert.equal(order?.clientSecret, "pi_test_1_secret_abc");
  assert.equal(started, 1);
});

test("live stripe keys are accepted only when live mode is explicitly on", async () => {
  const refused = recordFetch(() => {
    throw new Error("provider should not be called");
  });
  const blocked = await handleRequest(
    checkoutRequest(checkoutBody()),
    testEnv(memoryKv(), { ALLOW_LIVE_PAYMENTS: "true", STRIPE_SECRET_KEY: "sk_live_123", STRIPE_PUBLISHABLE_KEY: "pk_test_123" }),
    { fetch: refused.fetcher, now: () => NOW },
  );
  assert.equal(blocked.status, 403);
  assert.equal(refused.calls.length, 0);

  const allowed = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      assert.equal(call.headers.authorization, "Bearer sk_live_123");
      return jsonResponse({
        id: "pi_live_1",
        client_secret: "live_secret",
        amount: 22000,
        currency: "nok",
        status: "requires_payment_method",
      });
    }
    return jsonResponse({ error: { message: "unexpected" } }, 500);
  });
  const response = await handleRequest(
    checkoutRequest(checkoutBody()),
    testEnv(memoryKv(), { ALLOW_LIVE_PAYMENTS: "true", STRIPE_SECRET_KEY: "sk_live_123", STRIPE_PUBLISHABLE_KEY: "pk_live_123" }),
    { fetch: allowed.fetcher, now: () => NOW },
  );
  assert.equal(response.status, 200);
  assert.equal(allowed.calls.length, 1);
});

test("vipps stays on apitest until live mode points at the production host", async () => {
  clearVippsTokenCache();
  const recorded = recordFetch((call) => {
    if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "60" });
    if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
      return jsonResponse({ redirectUrl: "https://apitest.vipps.no/pay/abc", reference: ORDER_ID });
    }
    return jsonResponse({ ok: false }, 500);
  });
  const testMode = await handleRequest(
    checkoutRequest(checkoutBody({ method: "vipps" })),
    testEnv(memoryKv(), { VIPPS_API_BASE: "https://api.vipps.no" }),
    { fetch: recorded.fetcher, now: () => NOW },
  );
  assert.equal(testMode.status, 200);
  assert.ok(recorded.calls.some((call) => call.url.startsWith("https://apitest.vipps.no/")));
  assert.equal(recorded.calls.some((call) => call.url.startsWith("https://api.vipps.no/")), false);

  clearVippsTokenCache();
  const live = recordFetch((call) => {
    if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "60" });
    if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
      return jsonResponse({ redirectUrl: "https://api.vipps.no/pay/abc", reference: ORDER_ID });
    }
    return jsonResponse({ ok: false }, 500);
  }, { allowLiveVipps: true });
  const liveResponse = await handleRequest(
    checkoutRequest(checkoutBody({ method: "vipps" })),
    testEnv(memoryKv(), { ALLOW_LIVE_PAYMENTS: "true", VIPPS_API_BASE: "https://api.vipps.no" }),
    { fetch: live.fetcher, now: () => NOW },
  );
  assert.equal(liveResponse.status, 200);
  assert.ok(live.calls.some((call) => call.url.startsWith("https://api.vipps.no/epayment/")));
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
